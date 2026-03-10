import os
from pathlib import Path
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from data import (
    get_games, clear_cache, get_default_date, get_game_linescore,
    save_pitch_override, remove_pitch_override, get_all_overrides,
    fetch_date_range, fetch_all_pitchers_list, prefetch_boxscores,
    start_warmup, get_warmup_status, get_agg_cache, set_agg_cache,
)
from aggregation import (
    aggregate_pitch_data, aggregate_pitcher_results, get_pitcher_card,
    get_season_averages, aggregate_pitcher_results_range,
    aggregate_pitch_data_range, get_pitcher_game_log,
)

app = FastAPI(title="Baseball Savant Dashboard API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Serve React frontend in production ──
# Look for frontend build in ../frontend-build (relative to backend/)
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend-build"


# ── Startup: pre-fetch data in background ──
@app.on_event("startup")
def on_startup():
    start_warmup()


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
def pitcher_card(date: str = Query(...), pitcher_id: int = Query(...), game_pk: int = Query(...)): return get_pitcher_card(date, pitcher_id, game_pk)

@app.get("/api/game-linescore")
def game_linescore(game_pk: int = Query(...)): return get_game_linescore(game_pk)

@app.get("/api/season-averages")
def season_averages(pitcher_id: int = Query(...), season: int = Query(...)): return get_season_averages(pitcher_id, season)

@app.get("/api/pitchers-search")
def pitchers_search(q: str = Query(""), start_date: str = Query("2026-02-20"), end_date: str = Query("")):
    end_date = _resolve_end_date(end_date)
    pitchers = fetch_all_pitchers_list(start_date, end_date)
    if q:
        q_lower = q.lower()
        pitchers = [p for p in pitchers if q_lower in p["name"].lower()]
    return pitchers[:20]

@app.get("/api/leaderboard")
def leaderboard(start_date: str = Query("2026-02-20"), end_date: str = Query(""), view: str = Query("results")):
    end_date = _resolve_end_date(end_date)
    # Check aggregation cache first
    agg_key = f"leaderboard_{view}_{start_date}_{end_date}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    df = fetch_date_range(start_date, end_date)
    if df.empty:
        return []
    if view == "pitch-data":
        result = aggregate_pitch_data_range(df)
    else:
        result = aggregate_pitcher_results_range(df)
    set_agg_cache(agg_key, result)
    return result

@app.get("/api/team-pitchers")
def team_pitchers(team: str = Query(...), start_date: str = Query("2026-02-20"), end_date: str = Query(""), view: str = Query("results")):
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
def player_page(pitcher_id: int = Query(...), start_date: str = Query("2026-02-20"), end_date: str = Query("")):
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
    results_list = aggregate_pitcher_results_range(pdf)
    results_summary = results_list[0] if results_list else {}
    game_log = get_pitcher_game_log(df, pitcher_id)
    result = {"info": info, "pitch_summary": pitch_summary, "pitch_summary_vs_l": pitch_summary_vs_l, "pitch_summary_vs_r": pitch_summary_vs_r, "results_summary": results_summary, "game_log": game_log}
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
