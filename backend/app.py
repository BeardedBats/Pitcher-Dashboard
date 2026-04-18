import os
import csv
import io
import re
import unicodedata
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests as http_requests
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from data import (
    get_games, clear_cache, get_default_date, get_game_linescore,
    save_pitch_override, remove_pitch_override, get_all_overrides,
    fetch_date_range, fetch_all_pitchers_list, prefetch_boxscores,
    start_warmup, get_warmup_status, get_agg_cache, set_agg_cache,
    warmup_range_data, fetch_date, compute_player_page,
    get_top400_pitcher_ids, warmup_player_pages,
    get_override_version,
)
from aggregation import (
    aggregate_pitch_data, aggregate_pitcher_results, get_pitcher_card,
    get_season_averages, aggregate_pitcher_results_range,
    aggregate_pitch_data_range, get_pitcher_game_log,
    find_previous_mlb_season,
)
from redis_cache import redis_get, redis_set, redis_available

app = FastAPI(title="Baseball Savant Dashboard API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Serve React frontend in production ──
# Look for frontend build in ../frontend-build (relative to backend/)
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend-build"

# ── Detect environment: serverless (Vercel) vs persistent (local/Electron) ──
_IS_SERVERLESS = os.environ.get("VERCEL") == "1" or os.environ.get("AWS_LAMBDA_FUNCTION_NAME") is not None

# ── Stadium coordinates (lat, lon) for weather lookups ──
STADIUM_COORDS = {
    "ARI": (33.4455, -112.0667), "ATL": (33.8907, -84.4677), "BAL": (39.2839, -76.6217),
    "BOS": (42.3467, -71.0972), "CHC": (41.9484, -87.6553), "CWS": (41.8299, -87.6338),
    "CIN": (39.0974, -84.5082), "CLE": (41.4962, -81.6852), "COL": (39.7561, -104.9942),
    "DET": (42.3390, -83.0485), "HOU": (29.7573, -95.3555), "KC":  (39.0517, -94.4803),
    "LAA": (33.8003, -117.8827), "LAD": (34.0739, -118.2400), "MIA": (25.7781, -80.2196),
    "MIL": (43.0280, -87.9712), "MIN": (44.9818, -93.2775), "NYM": (40.7571, -73.8458),
    "NYY": (40.8296, -73.9262), "OAK": (37.7516, -122.2005), "PHI": (39.9061, -75.1665),
    "PIT": (40.4469, -80.0057), "SD":  (32.7076, -117.1570), "SF":  (37.7786, -122.3893),
    "SEA": (47.5914, -122.3326), "STL": (38.6226, -90.1928), "TB":  (27.7682, -82.6534),
    "TEX": (32.7512, -97.0832), "TOR": (43.6414, -79.3894), "WSH": (38.8730, -77.0074),
}

# Teams with domed/retractable-roof stadiums (always treated as indoor)
DOMED_STADIUMS = {"ARI", "HOU", "MIA", "MIL", "SEA", "TB", "TEX", "TOR"}

# ── Weather cache (per game_pk) ──
_weather_cache = {}

def _get_game_weather(game_pk, home_team, game_date_str):
    """Return game-time weather: dome, temp + optional precip, or None on error."""
    game_pk = int(game_pk)
    if game_pk in _weather_cache:
        return _weather_cache[game_pk]

    # Domed stadiums
    if home_team in DOMED_STADIUMS:
        result = {"type": "dome"}
        _weather_cache[game_pk] = result
        return result

    coords = STADIUM_COORDS.get(home_team)
    if not coords:
        return None

    try:
        # Get game start time from MLB Stats API
        mlb_resp = http_requests.get(
            f"https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live",
            timeout=8,
        )
        mlb_data = mlb_resp.json()
        game_time_str = mlb_data["gameData"]["datetime"]["dateTime"]  # ISO 8601 UTC
        game_dt = datetime.fromisoformat(game_time_str.replace("Z", "+00:00"))

        lat, lon = coords
        game_hour_utc = game_dt.hour

        # First fetch weather to get the timezone offset, then compute local date/hour
        from datetime import date as date_cls, timedelta

        # Use the game_date_str parameter (the calendar date the user sees) for the API query,
        # since UTC dates can roll over to the next day for late-night games
        query_date = game_date_str
        today = date_cls.today()
        query_date_obj = date_cls.fromisoformat(query_date)
        days_ago = (today - query_date_obj).days

        if days_ago > 5:
            url = (
                f"https://archive-api.open-meteo.com/v1/archive"
                f"?latitude={lat}&longitude={lon}"
                f"&start_date={query_date}&end_date={query_date}"
                f"&hourly=temperature_2m,weather_code"
                f"&temperature_unit=fahrenheit&timezone=auto"
            )
        else:
            url = (
                f"https://api.open-meteo.com/v1/forecast"
                f"?latitude={lat}&longitude={lon}"
                f"&hourly=temperature_2m,weather_code"
                f"&temperature_unit=fahrenheit&timezone=auto"
                f"&past_days=7&forecast_days=2"
            )

        weather_resp = http_requests.get(url, timeout=8)
        weather_data = weather_resp.json()
        hourly = weather_data.get("hourly", {})
        times = hourly.get("time", [])
        temps = hourly.get("temperature_2m", [])
        codes = hourly.get("weather_code", [])

        if not times or not temps:
            return None

        # Convert game start to stadium local time using Open-Meteo's timezone offset
        utc_offset_sec = weather_data.get("utc_offset_seconds", 0)
        local_dt = game_dt + timedelta(seconds=utc_offset_sec)
        local_hour = local_dt.hour
        local_date = local_dt.strftime("%Y-%m-%d")

        # Match against the local date's hours
        target_prefix = local_date + "T"
        best_idx = None
        best_diff = 999
        for i, t in enumerate(times):
            if t.startswith(target_prefix):
                h = int(t[11:13])
                diff = abs(h - local_hour)
                if diff < best_diff:
                    best_diff = diff
                    best_idx = i

        if best_idx is None:
            return None

        temp = round(temps[best_idx])
        weather_code = codes[best_idx] if best_idx < len(codes) else 0

        # Determine precipitation type from WMO weather codes
        precip = None
        if weather_code in (71, 72, 73, 75, 76, 77, 85, 86):
            precip = "Snow"
        elif weather_code in (51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99):
            precip = "Rain"

        result = {"type": "temp", "temp": temp, "precip": precip}
        _weather_cache[game_pk] = result
        return result

    except Exception:
        return None


# ── Startup: pre-fetch data in background (local/Electron only) ──
@app.on_event("startup")
def on_startup():
    if not _IS_SERVERLESS:
        start_warmup()


# ── Helper: get current time in Eastern ──
def _now_et() -> datetime:
    try:
        import zoneinfo
        et = zoneinfo.ZoneInfo("America/New_York")
    except Exception:
        import pytz
        et = pytz.timezone("America/New_York")
    return datetime.now(et)


# ── Helper: resolve end_date to today ET ──
def _resolve_end_date(end_date: str) -> str:
    if end_date:
        return end_date
    from datetime import datetime
    try:
        import zoneinfo
        et = zoneinfo.ZoneInfo("America/New_York")
    except Exception:
        import pytz
        et = pytz.timezone("America/New_York")
    return datetime.now(et).strftime("%Y-%m-%d")


@app.get("/api/default-date")
def default_date(): return {"date": get_default_date()}

@app.get("/api/warmup-status")
def warmup_status(): return get_warmup_status()

@app.get("/api/games")
def games(date: str = Query(...)): return get_games(date)

@app.get("/api/pitch-data")
def pitch_data(date: str = Query(...), game_pk: int = Query(None)):
    if game_pk is None:
        # Check agg cache for all-games daily aggregation
        agg_key = f"daily_pitch_{date}"
        cached = get_agg_cache(agg_key)
        if cached is not None:
            return cached
        result = aggregate_pitch_data(date, game_pk)
        set_agg_cache(agg_key, result)
        return result
    return aggregate_pitch_data(date, game_pk)

@app.get("/api/pitcher-results")
def pitcher_results(date: str = Query(...), game_pk: int = Query(None)):
    if game_pk is None:
        # Check agg cache for all-games daily aggregation
        agg_key = f"daily_results_{date}"
        cached = get_agg_cache(agg_key)
        if cached is not None:
            return cached
        result = aggregate_pitcher_results(date, game_pk)
        set_agg_cache(agg_key, result)
        return result
    return aggregate_pitcher_results(date, game_pk)

@app.get("/api/initial-load")
def initial_load():
    """Combined endpoint: returns default date + games + pitch data + pitcher results in one call.
    Eliminates the frontend waterfall of sequential API calls on first load."""
    date = get_default_date()
    games_list = get_games(date)
    # Use agg cache for daily aggregations
    pitch_key = f"daily_pitch_{date}"
    results_key = f"daily_results_{date}"
    cached_pitch = get_agg_cache(pitch_key)
    cached_results = get_agg_cache(results_key)
    pd_data = cached_pitch if cached_pitch is not None else aggregate_pitch_data(date, None)
    pr_data = cached_results if cached_results is not None else aggregate_pitcher_results(date, None)
    if cached_pitch is None:
        set_agg_cache(pitch_key, pd_data)
    if cached_results is None:
        set_agg_cache(results_key, pr_data)
    return {"date": date, "games": games_list, "pitchData": pd_data, "resultsData": pr_data}

@app.post("/api/clear-cache")
def clear(date: str = Query(None)):
    clear_cache(date)
    return {"status": "ok", "cleared": date or "all"}

def _compute_season_totals(pitcher_id, start_date, end_date):
    """Compute season totals for a pitcher. Returns dict or {} if no data."""
    agg_key = f"season_totals_{pitcher_id}_{start_date}_{end_date}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    df = fetch_date_range(start_date, end_date)
    if df.empty:
        return {}
    game_log = get_pitcher_game_log(df, pitcher_id)
    if not game_log:
        return {}
    total_pitches = sum(g.get("pitches", 0) for g in game_log)
    total_ip_thirds = 0
    for g in game_log:
        ip_val = g.get("ip", "0.0")
        parts = str(ip_val).split(".")
        full = int(parts[0])
        thirds = int(parts[1]) if len(parts) > 1 else 0
        total_ip_thirds += full * 3 + thirds
    total_whiffs = sum(g.get("whiffs", 0) for g in game_log)
    total_strikes = sum(g.get("strikes", 0) for g in game_log)
    total_runs = sum(g.get("runs", 0) for g in game_log)
    total_batters_faced = sum(g.get("batters_faced", 0) for g in game_log)
    total_games_started = sum(g.get("games_started", 0) for g in game_log)
    total_pa_count = sum(g.get("pa_count", 0) for g in game_log)
    total_two_str_pas = sum(g.get("two_strike_pas", 0) for g in game_log)
    total_two_str_ks = sum(g.get("two_strike_ks", 0) for g in game_log)
    result = {
        "games": len(game_log),
        "games_started": total_games_started,
        "ip": f"{total_ip_thirds // 3}.{total_ip_thirds % 3}",
        "ip_thirds": total_ip_thirds,
        "hits": sum(g.get("hits", 0) for g in game_log),
        "bbs": sum(g.get("bbs", 0) for g in game_log),
        "ks": sum(g.get("ks", 0) for g in game_log),
        "hrs": sum(g.get("hrs", 0) for g in game_log),
        "er": sum(g.get("er", 0) for g in game_log),
        "runs": total_runs,
        "batters_faced": total_batters_faced,
        "whiffs": total_whiffs,
        "swstr_pct": round(total_whiffs / total_pitches * 100, 1) if total_pitches > 0 else 0,
        "csw_pct": round(sum(g.get("csw_pct", 0) * g.get("pitches", 0) for g in game_log) / total_pitches, 1) if total_pitches > 0 else 0,
        "strike_pct": round(total_strikes / total_pitches * 100, 1) if total_pitches > 0 else 0,
        "two_str_pct": round(total_two_str_pas / total_pa_count * 100, 1) if total_pa_count > 0 else 0,
        "par_pct": round(total_two_str_ks / total_two_str_pas * 100, 1) if total_two_str_pas > 0 else 0,
        "pitches": total_pitches,
        "wins": sum(1 for g in game_log if g.get("decision") == "W"),
        "losses": sum(1 for g in game_log if g.get("decision") == "L"),
    }
    set_agg_cache(agg_key, result)
    return result

@app.get("/api/pitcher-card")
def pitcher_card(date: str = Query(...), pitcher_id: int = Query(...), game_pk: int = Query(...)):
    # Include override version in cache key so reclassifications always bust the cache
    agg_key = f"card_{date}_{pitcher_id}_{game_pk}_v{get_override_version()}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    result = get_pitcher_card(date, pitcher_id, game_pk)
    if result:
        # Compute season totals and weather BEFORE caching so cache hits are complete
        if "season_totals" not in result:
            current_year = date[:4]
            season_start = f"{current_year}-03-25"
            end_date = _resolve_end_date("")
            result["season_totals"] = _compute_season_totals(pitcher_id, season_start, end_date)
        if "game_weather" not in result:
            home_team = result.get("result", {}).get("home_team", "")
            result["game_weather"] = _get_game_weather(game_pk, home_team, date)
        set_agg_cache(agg_key, result)
    return result

@app.get("/api/pitcher-season-totals")
def pitcher_season_totals(pitcher_id: int = Query(...), start_date: str = Query("2026-03-25"), end_date: str = Query("")):
    """Return aggregated season totals for a pitcher's box score row."""
    end_date = _resolve_end_date(end_date)
    return _compute_season_totals(pitcher_id, start_date, end_date)

@app.get("/api/game-linescore")
def game_linescore(game_pk: int = Query(...)): return get_game_linescore(game_pk)

@app.get("/api/season-averages")
def season_averages(
    pitcher_id: int = Query(...),
    season: int = Query(...),
    before_date: str = Query(None),
    exclude_game_pk: int = Query(None),
    auto_fallback: bool = Query(False),
):
    # Cache key includes optional filters so season-to-date and plain-season
    # results don't collide.
    suffix = ""
    if before_date:
        suffix += f"_b{before_date}"
    if exclude_game_pk is not None:
        suffix += f"_x{exclude_game_pk}"

    # auto_fallback: `season` is the CURRENT year; walk back year-by-year until
    # we find a prior MLB season with data. Intended for player-page deltas
    # where "previous MLB season" may be 2+ years back (returning from injury,
    # debut year, etc.).
    if auto_fallback:
        fb_key = f"season_avg_fb_{pitcher_id}_{season}{suffix}"
        cached = get_agg_cache(fb_key)
        if cached is not None:
            return cached
        resolved_season = find_previous_mlb_season(pitcher_id, season)
        if resolved_season is None:
            return {"season": None, "averages": {}}
        averages = get_season_averages(
            pitcher_id,
            resolved_season,
            before_date=before_date,
            exclude_game_pk=exclude_game_pk,
        )
        payload = {"season": resolved_season, "averages": averages or {}}
        if averages:
            set_agg_cache(fb_key, payload)
        return payload

    agg_key = f"season_avg_{pitcher_id}_{season}{suffix}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    result = get_season_averages(
        pitcher_id,
        season,
        before_date=before_date,
        exclude_game_pk=exclude_game_pk,
    )
    if result:
        set_agg_cache(agg_key, result)
    return result

@app.get("/api/pitchers-search")
def pitchers_search(q: str = Query(""), start_date: str = Query("2026-03-25"), end_date: str = Query("")):
    end_date = _resolve_end_date(end_date)
    pitchers = fetch_all_pitchers_list(start_date, end_date)
    if q:
        q_lower = q.lower()
        pitchers = [p for p in pitchers if q_lower in p["name"].lower()]
    return pitchers[:20]

@app.get("/api/resolve-pitcher")
def resolve_pitcher(name: str = Query(...), start_date: str = Query("2026-03-25"), end_date: str = Query("")):
    """Resolve a pitcher name to a pitcher_id from cached data. Uses accent-insensitive matching."""
    import unicodedata
    end_date = _resolve_end_date(end_date)
    pitchers = fetch_all_pitchers_list(start_date, end_date)

    def strip_accents(s):
        return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).replace("\u00ad", "")

    name_norm = strip_accents(name).lower()
    # Try exact match first, then accent-insensitive
    for p in pitchers:
        if p["name"].lower() == name.lower():
            return {"pitcher_id": p["pitcher_id"], "name": p["name"]}
    for p in pitchers:
        if strip_accents(p["name"]).lower() == name_norm:
            return {"pitcher_id": p["pitcher_id"], "name": p["name"]}
    return {"pitcher_id": None, "name": name}

@app.get("/api/team-pitchers")
def team_pitchers(team: str = Query(...), start_date: str = Query("2026-03-25"), end_date: str = Query(""), view: str = Query("results")):
    end_date = _resolve_end_date(end_date)
    # Check aggregation cache first
    agg_key = f"team_{team}_{view}_{start_date}_{end_date}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    df = fetch_date_range(start_date, end_date)
    if df.empty:
        return []
    if "pitcher_team" in df.columns:
        df = df[df["pitcher_team"] == team]
    if df.empty:
        return []
    if view == "pitch-data":
        result = aggregate_pitch_data_range(df)
    else:
        result = aggregate_pitcher_results_range(df)
    set_agg_cache(agg_key, result)
    return result

@app.get("/api/player-page")
def player_page(pitcher_id: int = Query(...), start_date: str = Query("2026-03-25"), end_date: str = Query("")):
    end_date = _resolve_end_date(end_date)
    agg_key = f"player_v2_{pitcher_id}_{start_date}_{end_date}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    df = fetch_date_range(start_date, end_date)
    empty = {"info": {}, "pitch_summary": [], "pitch_summary_vs_l": [], "pitch_summary_vs_r": [], "results_summary": {}, "game_log": []}
    if df.empty:
        return empty
    result = compute_player_page(df, pitcher_id)
    if result is None:
        return empty
    set_agg_cache(agg_key, result)
    return result

class ReclassifyRequest(BaseModel):
    game_pk: int
    pitcher_id: int
    at_bat_number: int
    pitch_number: int
    new_pitch_type: str
    date: str = ""

@app.post("/api/pitch-reclassify")
def reclassify_pitch(req: ReclassifyRequest):
    key = save_pitch_override(req.game_pk, req.pitcher_id, req.at_bat_number, req.pitch_number, req.new_pitch_type)
    if req.date:
        clear_cache(req.date)
    return {"status": "ok", "key": key}

@app.delete("/api/pitch-reclassify")
def undo_reclassify(game_pk: int = Query(...), pitcher_id: int = Query(...), at_bat_number: int = Query(...), pitch_number: int = Query(...), date: str = Query("")):
    removed = remove_pitch_override(game_pk, pitcher_id, at_bat_number, pitch_number)
    if date:
        clear_cache(date)
    return {"status": "ok" if removed else "not_found"}

@app.get("/api/pitch-overrides")
def pitch_overrides(): return get_all_overrides()


# ── Cron warmup endpoint (called by Vercel cron jobs) ──
@app.get("/api/cron/warmup")
def cron_warmup(request: Request):
    """Vercel cron job handler. Warms all caches: Savant data, boxscores, aggregations."""
    # Verify this is a cron request (Vercel sets this header)
    # In local dev, allow all requests
    auth = request.headers.get("authorization")
    cron_secret = os.environ.get("CRON_SECRET")
    if _IS_SERVERLESS and cron_secret and auth != f"Bearer {cron_secret}":
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    try:
        warmup_range_data()
        now = _now_et().isoformat()
        redis_set("last_refresh", now)
        return {"status": "ok", "timestamp": now}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Batch backfill: pre-compute Top 400 player pages in chunks ──
@app.get("/api/cron/warmup-players")
def cron_warmup_players(request: Request, batch: int = Query(1), batch_size: int = Query(50)):
    """Pre-compute Top 400 player pages in batches.
    Call with ?batch=1, then ?batch=2, etc. until all are done.
    Each batch computes ~50 player pages."""
    auth = request.headers.get("authorization")
    cron_secret = os.environ.get("CRON_SECRET")
    if _IS_SERVERLESS and cron_secret and auth != f"Bearer {cron_secret}":
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    try:
        start_date = "2026-03-25"
        end_date = _resolve_end_date("")
        # Fetch the full season data (hits in-memory cache if warmup already ran)
        df = fetch_date_range(start_date, end_date)
        if df.empty:
            return {"status": "no_data"}
        # Get all Top 400 pitcher IDs in the data
        top400_map = get_top400_pitcher_ids(df)
        all_ids = sorted(top400_map.keys())
        total_batches = (len(all_ids) + batch_size - 1) // batch_size
        # Slice to the requested batch (1-indexed)
        start_idx = (batch - 1) * batch_size
        end_idx = start_idx + batch_size
        batch_ids = all_ids[start_idx:end_idx]
        if not batch_ids:
            return {"status": "done", "message": f"No players in batch {batch}", "total_batches": total_batches}
        result = warmup_player_pages(df, start_date, end_date, pitcher_ids=batch_ids)
        return {
            "status": "ok", "batch": batch, "total_batches": total_batches,
            "batch_computed": result["computed"], "batch_skipped": result["skipped"],
            "total_top400_in_data": result["total_top400_in_data"],
            "players": [{"id": pid, "name": top400_map[pid]} for pid in batch_ids],
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Daily 5:30 AM ET cron: refresh data + leaderboard/team aggregations ──
@app.get("/api/cron/warmup-daily")
def cron_warmup_daily(request: Request):
    """Daily cron (5:30 AM ET / 9:30 UTC): fetches fresh Savant data,
    re-computes leaderboard and team aggregations. Subsequent cron jobs
    (warmup-daily-players at 5:40, warmup-daily-cards at 5:50) handle
    player pages and pitcher cards."""
    auth = request.headers.get("authorization")
    cron_secret = os.environ.get("CRON_SECRET")
    if _IS_SERVERLESS and cron_secret and auth != f"Bearer {cron_secret}":
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    try:
        warmup_range_data()
        now = _now_et().isoformat()
        redis_set("last_refresh", now)
        return {"status": "ok", "timestamp": now}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Daily 5:40 AM ET cron: re-compute player pages for yesterday's pitchers ──
@app.get("/api/cron/warmup-daily-players")
def cron_warmup_daily_players(request: Request):
    """Daily cron (5:40 AM ET / 9:40 UTC): re-computes player pages
    for Top 400 pitchers who pitched yesterday."""
    auth = request.headers.get("authorization")
    cron_secret = os.environ.get("CRON_SECRET")
    if _IS_SERVERLESS and cron_secret and auth != f"Bearer {cron_secret}":
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    try:
        start_date = "2026-03-25"
        end_date = _resolve_end_date("")
        df = fetch_date_range(start_date, end_date)
        if df.empty:
            return {"status": "no_data"}
        yesterday = get_default_date()
        result = warmup_player_pages(df, start_date, end_date, only_date=yesterday)
        return {
            "status": "ok", "date_updated": yesterday,
            "players_computed": result["computed"],
            "players_skipped": result["skipped"],
            "total_top400_in_data": result["total_top400_in_data"],
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Daily 5:50 AM ET cron: pre-compute game feeds, season avgs, pitcher cards ──
@app.get("/api/cron/warmup-daily-cards")
def cron_warmup_daily_cards(request: Request):
    """Daily cron (5:50 AM ET / 9:50 UTC): pre-computes game feeds,
    season averages, and pitcher cards for yesterday's games."""
    auth = request.headers.get("authorization")
    cron_secret = os.environ.get("CRON_SECRET")
    if _IS_SERVERLESS and cron_secret and auth != f"Bearer {cron_secret}":
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    try:
        yesterday = get_default_date()
        # Fetch only yesterday's data — NOT the full season range.
        # The old approach called fetch_date_range (entire season) which has no
        # Redis L2 cache, so every serverless cold start re-fetched from Savant
        # (~30-60s) and often timed out before computing any cards.
        day_df = fetch_date(yesterday)
        if day_df.empty:
            return {"status": "no_data", "date": yesterday}
        cards_computed = 0
        feeds_warmed = 0
        avgs_warmed = 0

        # Pre-fetch game feeds (linescore/PBP) for all yesterday's games
        game_pks = [int(gpk) for gpk in day_df["game_pk"].unique()]
        def _warm_feed(gpk):
            try:
                return bool(get_game_linescore(gpk))
            except Exception as e:
                print(f"[DailyCards] Feed error {gpk}: {e}")
                return False
        with ThreadPoolExecutor(max_workers=10) as pool:
            for ok in pool.map(_warm_feed, game_pks):
                if ok:
                    feeds_warmed += 1

        # Pre-compute season averages for all yesterday's pitchers
        prev_season = int(yesterday[:4]) - 1
        pitcher_ids = [int(pid) for pid in day_df["pitcher"].unique()]
        uncached_pids = [pid for pid in pitcher_ids if get_agg_cache(f"season_avg_{pid}_{prev_season}") is None]
        def _warm_avg(pid):
            try:
                avg_result = get_season_averages(pid, prev_season)
                if avg_result:
                    set_agg_cache(f"season_avg_{pid}_{prev_season}", avg_result)
                    return True
            except Exception as e:
                print(f"[DailyCards] Season avg error {pid}: {e}")
            return False
        with ThreadPoolExecutor(max_workers=10) as pool:
            for ok in pool.map(_warm_avg, uncached_pids):
                if ok:
                    avgs_warmed += 1

        # Pre-compute season totals for yesterday's pitchers
        current_year = yesterday[:4]
        season_start = f"{current_year}-03-25"
        totals_end = _resolve_end_date("")
        unique_pids = day_df["pitcher"].dropna().unique()
        totals_warmed = 0
        for pid in unique_pids:
            pid = int(pid)
            st_key = f"season_totals_{pid}_{season_start}_{totals_end}"
            if get_agg_cache(st_key) is not None:
                continue
            try:
                _compute_season_totals(pid, season_start, totals_end)
                totals_warmed += 1
            except Exception as e:
                print(f"[DailyCards] Season totals error {pid}: {e}")

        # Pre-compute pitcher cards with season_totals + weather baked in
        combos = day_df.groupby(["pitcher", "game_pk"]).size().reset_index()[["pitcher", "game_pk"]]
        for _, row in combos.iterrows():
            pid, gpk = int(row["pitcher"]), int(row["game_pk"])
            agg_key = f"card_{yesterday}_{pid}_{gpk}_v{get_override_version()}"
            if get_agg_cache(agg_key) is not None:
                continue
            try:
                card = get_pitcher_card(yesterday, pid, gpk)
                if card:
                    # Bake in season totals and weather so the endpoint has nothing left to compute
                    if "season_totals" not in card:
                        card["season_totals"] = _compute_season_totals(pid, season_start, totals_end)
                    if "game_weather" not in card:
                        home_team = card.get("result", {}).get("home_team", "")
                        card["game_weather"] = _get_game_weather(gpk, home_team, yesterday)
                    set_agg_cache(agg_key, card)
                    cards_computed += 1
            except Exception as e:
                print(f"[DailyCards] Card error {pid}/{gpk}: {e}")

        return {
            "status": "ok", "date_updated": yesterday,
            "cards_computed": cards_computed,
            "feeds_warmed": feeds_warmed,
            "avgs_warmed": avgs_warmed,
            "totals_warmed": totals_warmed,
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Live game card warmup (every 10 min during game hours) ──

def _get_live_pitchers(today: str):
    """Query MLB Stats API for currently live games and return the set of
    pitcher IDs currently on the mound, plus a map of game_pk → game status.
    Returns (active_pitcher_ids: set, game_statuses: dict[int, str])."""
    import requests as _req
    url = (f"https://statsapi.mlb.com/api/v1/schedule?sportId=1"
           f"&date={today}&hydrate=linescore,game(content(summary))")
    active = set()
    statuses = {}
    try:
        resp = _req.get(url, timeout=10)
        data = resp.json()
        for d in data.get("dates", []):
            for g in d.get("games", []):
                gpk = g["gamePk"]
                state = g.get("status", {}).get("abstractGameState", "")
                statuses[gpk] = state
                if state != "Live":
                    continue
                # Get current pitcher from linescore defense
                ls = g.get("linescore", {})
                defense = ls.get("defense", {})
                pitcher = defense.get("pitcher", {})
                pid = pitcher.get("id")
                if pid:
                    active.add(int(pid))
    except Exception as e:
        print(f"[LiveCards] MLB schedule error: {e}")
    return active, statuses


@app.get("/api/cron/warmup-live-cards")
def cron_warmup_live_cards(request: Request):
    """Every 10 min during game hours: re-compute pitcher cards ONLY for
    pitchers currently on the mound in live games.

    Pitcher lifecycle per game:
    1. Currently pitching → recompute card every 10 min
    2. Just left the game → one final cache (captures complete line), then
       mark as "done" so future runs skip them
    3. Done → skip entirely (cache preserved until natural expiration)
    """
    auth = request.headers.get("authorization")
    cron_secret = os.environ.get("CRON_SECRET")
    if _IS_SERVERLESS and cron_secret and auth != f"Bearer {cron_secret}":
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    try:
        today = _now_et().strftime("%Y-%m-%d")

        # 1. Get currently active pitchers from MLB Stats API
        active_pids, game_statuses = _get_live_pitchers(today)

        # 2. Load previous run's active set from Redis
        redis_key = f"live_cards_active:{today}"
        prev_active_raw = redis_get(redis_key)
        prev_active = set(prev_active_raw) if prev_active_raw else set()

        # 3. Load "done" set — pitchers who already got their final cache
        done_key = f"live_cards_done:{today}"
        done_raw = redis_get(done_key)
        done_pids = set(done_raw) if done_raw else set()

        # 4. Determine who needs caching:
        #    - Currently active: always recompute
        #    - Just left (was active, now not, not done): one final cache, then mark done
        just_left = (prev_active - active_pids) - done_pids
        pids_to_cache = active_pids | just_left

        if not pids_to_cache:
            # Save active set and return
            redis_set(redis_key, list(active_pids), ttl=86400)
            return {"status": "no_pitchers", "date": today,
                    "active": len(active_pids), "done": len(done_pids)}

        # 5. Fetch today's pitch data
        day_df = fetch_date(today)
        if day_df.empty:
            redis_set(redis_key, list(active_pids), ttl=86400)
            return {"status": "no_data", "date": today}

        prefetch_boxscores(day_df)

        current_year = today[:4]
        season_start = f"{current_year}-03-25"
        totals_end = _resolve_end_date("")

        cards_live = 0
        cards_final = 0

        # 6. Build cards only for pitchers in pids_to_cache
        combos = day_df.groupby(["pitcher", "game_pk"]).size().reset_index()[["pitcher", "game_pk"]]
        for _, row in combos.iterrows():
            pid, gpk = int(row["pitcher"]), int(row["game_pk"])
            if pid not in pids_to_cache:
                continue
            agg_key = f"card_{today}_{pid}_{gpk}_v{get_override_version()}"
            try:
                card = get_pitcher_card(today, pid, gpk)
                if card:
                    if "season_totals" not in card:
                        card["season_totals"] = _compute_season_totals(pid, season_start, totals_end)
                    if "game_weather" not in card:
                        home_team = card.get("result", {}).get("home_team", "")
                        card["game_weather"] = _get_game_weather(gpk, home_team, today)
                    set_agg_cache(agg_key, card)
                    if pid in active_pids:
                        cards_live += 1
                    else:
                        cards_final += 1
            except Exception as e:
                print(f"[LiveCards] Card error {pid}/{gpk}: {e}")

        # 7. Update state in Redis
        #    - Save current active set for next run's comparison
        #    - Add just_left pitchers to done set
        redis_set(redis_key, list(active_pids), ttl=86400)
        new_done = done_pids | just_left
        redis_set(done_key, list(new_done), ttl=86400)

        return {
            "status": "ok", "date": today,
            "cards_live": cards_live,
            "cards_final": cards_final,
            "active_pitchers": len(active_pids),
            "just_left": len(just_left),
            "done_pitchers": len(new_done),
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Manual refresh endpoint (called by the refresh button) ──
@app.post("/api/refresh")
def manual_refresh():
    """Lightweight refresh: clear only today's caches and re-fetch.
    Does NOT run the full season warmup — only refreshes live data."""
    try:
        today = get_default_date()
        clear_cache(today)
        # Re-fetch today's pitch data (triggers Savant CSV download + warms cache)
        df = fetch_date(today)
        # Re-compute today's daily aggregations.
        # aggregate_pitch_data / aggregate_pitcher_results take a date_str
        # (NOT a DataFrame) and re-fetch internally — but they hit the warm
        # cache from the fetch_date call above.
        if not df.empty:
            pitch_agg = aggregate_pitch_data(today)
            results_agg = aggregate_pitcher_results(today)
            set_agg_cache(f"daily_pitch_{today}", pitch_agg)
            set_agg_cache(f"daily_results_{today}", results_agg)
        now = _now_et().isoformat()
        redis_set("last_refresh", now)
        return {"status": "ok", "timestamp": now}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Pitcher schedule (next starts from Google Sheet) ──
_SCHEDULE_SHEET_URL = "https://docs.google.com/spreadsheets/d/1IefgV82-jwgoDDkSxWNlDmKFqvGOnorX1HjAENKfjv0/export?format=csv&gid=2116137360"
_schedule_cache = {"data": None, "ts": None}

def _fetch_schedule_grid():
    """Fetch and parse the Probables tab from Google Sheets. Cache for 1 hour.
    Header row: 'Team', 'Sunday - 4/5', 'Monday - 4/6', ...
    Team rows: 'PIT', 'Braxton Ashcraft | BAL', 'OFF', ...
    Cell format: 'Pitcher Name | OPP' or 'Pitcher Name | @OPP'."""
    now = datetime.now()
    if _schedule_cache["data"] and _schedule_cache["ts"] and (now - _schedule_cache["ts"]).total_seconds() < 3600:
        return _schedule_cache["data"]
    try:
        resp = http_requests.get(_SCHEDULE_SHEET_URL, timeout=15, allow_redirects=True)
        resp.raise_for_status()
        text = resp.content.decode("utf-8", errors="replace")
    except Exception:
        return _schedule_cache.get("data") or {}
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        return {}
    # Parse date columns from header row
    # Format: "Sunday - 4/5", "Monday - 4/6", or doubleheader "4/5/2026-2nd - ..."
    header = rows[0]
    dates = []  # list of (col_index, date_str)  e.g. (1, "4/5"), (2, "4/6")
    for ci, cell in enumerate(header):
        if ci == 0:
            continue
        m = re.search(r'(\d+/\d+)', cell)
        if m:
            dates.append((ci, m.group(1)))
    pitcher_starts = {}  # pitcher_name_lower -> [{ date, opponent, is_away, team }]
    for ri, row in enumerate(rows[1:], start=1):
        team_abbr = (row[0] or "").strip()
        if not team_abbr:
            continue
        for ci, date_str in dates:
            if ci >= len(row):
                continue
            cell = (row[ci] or "").strip()
            if not cell or cell.upper() == "OFF":
                continue
            # Format: "Pitcher Name | OPP" or "Pitcher Name | @OPP"
            parts = cell.split("|")
            if len(parts) < 2:
                continue
            pitcher_name = parts[0].strip()
            opp_raw = parts[1].strip()
            # Strip hand indicator like "(R)" or "(L)"
            pitcher_name = re.sub(r'\s*\([RLS]\)\s*$', '', pitcher_name).strip()
            if not pitcher_name or pitcher_name == "(null)":
                continue
            is_away = opp_raw.startswith("@")
            opp_abbr = opp_raw.lstrip("@").strip()
            key = _strip_accents(pitcher_name.lower())
            if key not in pitcher_starts:
                pitcher_starts[key] = []
            pitcher_starts[key].append({
                "date": date_str,
                "opponent": opp_abbr,
                "is_away": is_away,
                "team": team_abbr,
            })
    _schedule_cache["data"] = pitcher_starts
    _schedule_cache["ts"] = now
    return pitcher_starts

def _strip_accents(s):
    """Remove accent marks from characters (é→e, ñ→n, etc.)."""
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")

@app.get("/api/pitcher-schedule")
def pitcher_schedule(name: str = Query(...), game_date: str = Query("")):
    """Return next 3 scheduled starts for a pitcher after game_date."""
    grid = _fetch_schedule_grid()
    key = _strip_accents(name.lower().strip())
    starts = grid.get(key, [])
    if not starts:
        # Try with accent-stripped keys
        for k, v in grid.items():
            k_norm = _strip_accents(k)
            if key == k_norm or key in k_norm or k_norm in key:
                starts = v
                break
    if not starts:
        return {"starts": []}
    # Parse game_date to filter future starts
    current_year = datetime.now().year
    try:
        gd = datetime.strptime(game_date, "%Y-%m-%d") if game_date else datetime.now()
    except ValueError:
        gd = datetime.now()
    future = []
    for s in starts:
        try:
            sd = datetime.strptime(f"{current_year}/{s['date']}", "%Y/%m/%d")
        except ValueError:
            continue
        if sd > gd:
            day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
            future.append({
                "date": f"{sd.month}/{sd.day}",
                "day": day_names[sd.weekday()],
                "opponent": s["opponent"],
                "is_away": s["is_away"],
            })
    future.sort(key=lambda x: datetime.strptime(f"{current_year}/{x['date']}", "%Y/%m/%d"))
    return {"starts": future[:3]}

# ── Last refresh timestamp ──
@app.get("/api/last-refresh")
def last_refresh():
    """Return the timestamp of the last data refresh."""
    ts = redis_get("last_refresh")
    return {"timestamp": ts}


# ── Serve React frontend (must be AFTER all /api routes) ──
if _FRONTEND_DIR.is_dir():
    # Serve static assets (JS, CSS, images)
    app.mount("/static", StaticFiles(directory=_FRONTEND_DIR / "static"), name="static")

    # SPA catch-all: any non-API route returns index.html so React Router works
    @app.get("/{full_path:path}")
    def serve_frontend(full_path: str):
        # Try to serve the exact file first (favicon.ico, manifest.json, etc.)
        file_path = _FRONTEND_DIR / full_path
        if full_path and file_path.is_file():
            return FileResponse(file_path)
        # Otherwise return index.html for client-side routing
        return FileResponse(_FRONTEND_DIR / "index.html")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
