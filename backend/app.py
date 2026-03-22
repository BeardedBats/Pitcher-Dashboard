import os
from pathlib import Path
from datetime import datetime
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
    warmup_range_data, fetch_date,
)
from aggregation import (
    aggregate_pitch_data, aggregate_pitcher_results, get_pitcher_card,
    get_season_averages, aggregate_pitcher_results_range,
    aggregate_pitch_data_range, get_pitcher_game_log,
)
from redis_cache import redis_get, redis_set, redis_available

app = FastAPI(title="Baseball Savant Dashboard API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Serve React frontend in production ──
# Look for frontend build in ../frontend-build (relative to backend/)
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend-build"

# ── Detect environment: serverless (Vercel) vs persistent (local/Electron) ──
_IS_SERVERLESS = os.environ.get("VERCEL") == "1" or os.environ.get("AWS_LAMBDA_FUNCTION_NAME") is not None


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

@app.get("/api/pitcher-card")
def pitcher_card(date: str = Query(...), pitcher_id: int = Query(...), game_pk: int = Query(...)):
    agg_key = f"card_{date}_{pitcher_id}_{game_pk}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    result = get_pitcher_card(date, pitcher_id, game_pk)
    if result:
        set_agg_cache(agg_key, result)
    return result

@app.get("/api/pitcher-season-totals")
def pitcher_season_totals(pitcher_id: int = Query(...), start_date: str = Query("2026-02-10"), end_date: str = Query("")):
    """Return aggregated season totals for a pitcher's box score row."""
    end_date = _resolve_end_date(end_date)
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
        "pitches": total_pitches,
    }
    set_agg_cache(agg_key, result)
    return result

@app.get("/api/game-linescore")
def game_linescore(game_pk: int = Query(...)): return get_game_linescore(game_pk)

@app.get("/api/season-averages")
def season_averages(pitcher_id: int = Query(...), season: int = Query(...)):
    agg_key = f"season_avg_{pitcher_id}_{season}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    result = get_season_averages(pitcher_id, season)
    if result:
        set_agg_cache(agg_key, result)
    return result

@app.get("/api/pitchers-search")
def pitchers_search(q: str = Query(""), start_date: str = Query("2026-02-10"), end_date: str = Query("")):
    end_date = _resolve_end_date(end_date)
    pitchers = fetch_all_pitchers_list(start_date, end_date)
    if q:
        q_lower = q.lower()
        pitchers = [p for p in pitchers if q_lower in p["name"].lower()]
    return pitchers[:20]

@app.get("/api/resolve-pitcher")
def resolve_pitcher(name: str = Query(...), start_date: str = Query("2026-02-10"), end_date: str = Query("")):
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
def team_pitchers(team: str = Query(...), start_date: str = Query("2026-02-10"), end_date: str = Query(""), view: str = Query("results")):
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
def player_page(pitcher_id: int = Query(...), start_date: str = Query("2026-02-10"), end_date: str = Query("")):
    end_date = _resolve_end_date(end_date)
    # Check aggregation cache
    agg_key = f"player_v2_{pitcher_id}_{start_date}_{end_date}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    df = fetch_date_range(start_date, end_date)
    if df.empty:
        return {"info": {}, "pitch_summary": [], "pitch_summary_vs_l": [], "pitch_summary_vs_r": [], "results_summary": {}, "game_log": []}
    pdf = df[df["pitcher"] == pitcher_id]
    if pdf.empty:
        return {"info": {}, "pitch_summary": [], "pitch_summary_vs_l": [], "pitch_summary_vs_r": [], "results_summary": {}, "game_log": []}
    name = pdf["player_name"].iloc[0]
    teams = list(pdf["pitcher_team"].unique()) if "pitcher_team" in pdf.columns else []
    hand = pdf["p_throws"].iloc[0] if "p_throws" in pdf.columns else ""
    info = {"name": name, "teams": teams, "hand": hand, "pitcher_id": pitcher_id}
    # Prep boolean columns ONCE, then reuse for all three aggregations
    from aggregation import _prep_df
    pdf_prepped = _prep_df(pdf)
    pitch_summary = aggregate_pitch_data_range(pdf_prepped, prepped=True)
    pdf_vs_l = pdf_prepped[pdf_prepped["stand"] == "L"] if "stand" in pdf_prepped.columns else pdf_prepped.iloc[0:0]
    pdf_vs_r = pdf_prepped[pdf_prepped["stand"] == "R"] if "stand" in pdf_prepped.columns else pdf_prepped.iloc[0:0]
    pitch_summary_vs_l = aggregate_pitch_data_range(pdf_vs_l, prepped=True) if not pdf_vs_l.empty else []
    pitch_summary_vs_r = aggregate_pitch_data_range(pdf_vs_r, prepped=True) if not pdf_vs_r.empty else []
    game_log = get_pitcher_game_log(df, pitcher_id)
    # Derive totals from game log so summary always matches displayed rows
    if game_log:
        total_pitches = sum(g.get("pitches", 0) for g in game_log)
        total_ip_thirds = 0
        for g in game_log:
            ip_val = g.get("ip", "0.0")
            parts = str(ip_val).split(".")
            full = int(parts[0])
            thirds = int(parts[1]) if len(parts) > 1 else 0
            total_ip_thirds += full * 3 + thirds
        results_summary = {
            "games": len(game_log),
            "ip": f"{total_ip_thirds // 3}.{total_ip_thirds % 3}",
            "hits": sum(g.get("hits", 0) for g in game_log),
            "bbs": sum(g.get("bbs", 0) for g in game_log),
            "ks": sum(g.get("ks", 0) for g in game_log),
            "hrs": sum(g.get("hrs", 0) for g in game_log),
            "er": sum(g.get("er", 0) for g in game_log),
            "whiffs": sum(g.get("whiffs", 0) for g in game_log),
            "csw_pct": round(sum(g.get("csw_pct", 0) * g.get("pitches", 0) for g in game_log) / total_pitches, 1) if total_pitches > 0 else 0,
            "pitches": total_pitches,
        }
    else:
        results_summary = {}
    # Build per-game pitch summaries for game filter in pitch metrics table
    per_game_summaries = {}
    for gpk in pdf_prepped["game_pk"].unique():
        gpdf = pdf_prepped[pdf_prepped["game_pk"] == gpk]
        per_game_summaries[str(int(gpk))] = {
            "all": aggregate_pitch_data_range(gpdf, prepped=True),
            "vs_l": aggregate_pitch_data_range(gpdf[gpdf["stand"] == "L"], prepped=True) if (gpdf["stand"] == "L").any() else [],
            "vs_r": aggregate_pitch_data_range(gpdf[gpdf["stand"] == "R"], prepped=True) if (gpdf["stand"] == "R").any() else [],
        }

    # Build raw pitches list for strikezone/movement plots
    from aggregation import build_pitches_list
    all_pitches = build_pitches_list(pdf)
    sz_top = float(pdf["sz_top"].mean()) if "sz_top" in pdf.columns and pdf["sz_top"].notna().any() else 3.5
    sz_bot = float(pdf["sz_bot"].mean()) if "sz_bot" in pdf.columns and pdf["sz_bot"].notna().any() else 1.5
    result = {"info": info, "pitch_summary": pitch_summary, "pitch_summary_vs_l": pitch_summary_vs_l, "pitch_summary_vs_r": pitch_summary_vs_r, "per_game_summaries": per_game_summaries, "results_summary": results_summary, "game_log": game_log, "pitches": all_pitches, "sz_top": sz_top, "sz_bot": sz_bot}
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


# ── Manual refresh endpoint (called by the refresh button) ──
@app.post("/api/refresh")
def manual_refresh():
    """Clear caches and re-fetch all data. Returns new timestamp."""
    try:
        clear_cache()
        warmup_range_data()
        now = _now_et().isoformat()
        redis_set("last_refresh", now)
        return {"status": "ok", "timestamp": now}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


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
