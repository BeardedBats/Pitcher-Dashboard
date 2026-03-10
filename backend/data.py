import io
import os
import json
import time
import threading
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import numpy as np
import pandas as pd
import requests

_cache = {}          # { date_str: (timestamp, dataframe) }
_season_cache = {}
LIVE_CACHE_TTL = 60  # seconds — refresh live data every 60s

# ── Warmup / pre-fetch state ──
_warmup_status = {"ready": False, "loading": False, "error": None, "progress": ""}
_warmup_lock = threading.Lock()

# ── Pitch reclassification overrides ──
OVERRIDES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pitch_overrides.json")
_overrides = {}  # { "gamePk_pitcherId_atBat_pitchNum": {"original":"FF","new":"FC",...} }

def _load_overrides():
    global _overrides
    if os.path.exists(OVERRIDES_PATH):
        try:
            with open(OVERRIDES_PATH, "r") as f:
                _overrides = json.load(f)
        except Exception:
            _overrides = {}
    return _overrides

def _save_overrides():
    try:
        with open(OVERRIDES_PATH, "w") as f:
            json.dump(_overrides, f, indent=2)
    except Exception as e:
        print(f"Error saving overrides: {e}")

def save_pitch_override(game_pk, pitcher_id, at_bat_number, pitch_number, new_pitch_type):
    """Save a pitch reclassification override.
    new_pitch_type can be either a human name ('Four-Seamer') or a code ('FF').
    """
    key = f"{game_pk}_{pitcher_id}_{at_bat_number}_{pitch_number}"
    # Determine code and name regardless of which format was passed
    if new_pitch_type in PITCH_NAME_TO_CODE:
        # Human name passed (e.g., "Four-Seamer")
        new_code = PITCH_NAME_TO_CODE[new_pitch_type]
        new_name = new_pitch_type
    elif new_pitch_type in PITCH_TYPE_MAP:
        # Code passed (e.g., "FF")
        new_code = new_pitch_type
        new_name = PITCH_TYPE_MAP[new_pitch_type]
    else:
        new_code = new_pitch_type
        new_name = new_pitch_type
    _overrides[key] = {
        "new_type": new_code,
        "new_name": new_name,
    }
    _save_overrides()
    return key

def remove_pitch_override(game_pk, pitcher_id, at_bat_number, pitch_number):
    """Remove a pitch reclassification override."""
    key = f"{game_pk}_{pitcher_id}_{at_bat_number}_{pitch_number}"
    removed = _overrides.pop(key, None)
    if removed:
        _save_overrides()
    return removed is not None

def get_all_overrides():
    return dict(_overrides)

def _apply_overrides(df):
    """Apply pitch reclassification overrides to a DataFrame."""
    if not _overrides or df.empty:
        return df
    required = {"game_pk", "pitcher", "at_bat_number"}
    if not required.issubset(df.columns):
        return df
    # Build a lookup for fast matching
    for key, ov in _overrides.items():
        parts = key.split("_")
        if len(parts) != 4:
            continue
        gpk, pid, abn, pnum = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
        mask = (df["game_pk"] == gpk) & (df["pitcher"] == pid) & (df["at_bat_number"] == abn)
        matching_rows = df.loc[mask]
        if matching_rows.empty:
            continue
        # pitch_number is 1-based within the at-bat
        indices = matching_rows.index.tolist()
        if pnum - 1 < len(indices):
            idx = indices[pnum - 1]
            df.at[idx, "pitch_type"] = ov["new_type"]
            df.at[idx, "pitch_name"] = ov["new_name"]
    return df

# Load overrides on module import
_load_overrides()

PITCH_TYPE_MAP = {
    "FF": "Four-Seamer", "SI": "Sinker", "FC": "Cutter",
    "SL": "Slider", "ST": "Sweeper", "CU": "Curveball",
    "KC": "Curveball", "CS": "Curveball", "CH": "Changeup",
    "FS": "Splitter", "KN": "Knuckleball", "EP": "Eephus",
    "SC": "Screwball", "FO": "Forkball", "SV": "Curveball",
}

# Reverse map: human-readable name -> primary pitch_type code
PITCH_NAME_TO_CODE = {
    "Four-Seamer": "FF", "Sinker": "SI", "Cutter": "FC",
    "Slider": "SL", "Sweeper": "ST", "Curveball": "CU",
    "Changeup": "CH", "Splitter": "FS", "Knuckleball": "KN",
    "Eephus": "EP", "Screwball": "SC", "Forkball": "FO",
}

SAVANT_CSV_URL = (
    "https://baseballsavant.mlb.com/statcast_search/csv"
    "?hfPT=&hfAB=&hfGT=R%7CS%7CE%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones="
    "&hfPull=&hfC=&hfSea=&hfSit=&player_type=pitcher&hfOuts=&hfOpponent="
    "&pitcher_throws=&batter_stands=&hfSA=&game_date_gt={date}&game_date_lt={date}"
    "&hfMo=&hfTeam=&home_road=&hfRO=&position=&hfInfield=&hfOutfield="
    "&hfInn=&hfBBT=&hfFlag=&metric_1=&group_by=name&min_pitches=0"
    "&min_results=0&min_pas=0&sort_col=pitches&player_event_sort=api_p_release_speed"
    "&sort_order=desc&type=details&all=true"
)

def _fix_name(name):
    if not isinstance(name, str): return name
    if ", " in name:
        parts = name.split(", ", 1)
        return f"{parts[1]} {parts[0]}"
    return name

def _fix_names_vectorized(series):
    """Vectorized name fixing: 'Last, First' -> 'First Last'."""
    mask = series.str.contains(", ", na=False)
    if not mask.any():
        return series
    fixed = series.copy()
    parts = series[mask].str.split(", ", n=1, expand=True)
    if parts.shape[1] >= 2:
        fixed[mask] = parts[1] + " " + parts[0]
    return fixed

def _assign_teams_vectorized(df):
    """Vectorized pitcher_team/opponent assignment based on inning_topbot."""
    if "inning_topbot" not in df.columns or "home_team" not in df.columns:
        return df
    if "pitcher_team" not in df.columns:
        is_top = df["inning_topbot"] == "Top"
        df["pitcher_team"] = np.where(is_top, df["home_team"], df["away_team"])
        df["opponent"] = np.where(is_top, df["away_team"], df["home_team"])
    return df

def _fetch_from_savant(date_str):
    url = SAVANT_CSV_URL.format(date=date_str)
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        resp = requests.get(url, headers=headers, timeout=60)
        resp.raise_for_status()
        content = resp.content.decode("utf-8")
        if not content.strip() or "No Results" in content[:200]:
            return pd.DataFrame()
        df = pd.read_csv(io.StringIO(content), low_memory=False)
        return df if not df.empty else pd.DataFrame()
    except Exception as e:
        print(f"Error fetching from Baseball Savant: {e}")
        try:
            from pybaseball import statcast
            return statcast(start_dt=date_str, end_dt=date_str)
        except Exception as e2:
            print(f"Fallback failed: {e2}")
            return pd.DataFrame()

MLB_GAME_FEED_URL = "https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live"

# Map MLB Stats API pitch descriptions to Baseball Savant format
_MLB_DESC_MAP = {
    "Called Strike": "called_strike",
    "Swinging Strike": "swinging_strike",
    "Swinging Strike (Blocked)": "swinging_strike_blocked",
    "Foul": "foul",
    "Foul Tip": "foul_tip",
    "Foul Bunt": "foul_bunt",
    "Missed Bunt": "missed_bunt",
    "Bunt Foul Tip": "bunt_foul_tip",
    "Ball": "ball",
    "Ball In Dirt": "ball",
    "Hit By Pitch": "hit_by_pitch",
    "In play, no out": "hit_into_play",
    "In play, out(s)": "hit_into_play",
    "In play, run(s)": "hit_into_play",
    "Pitchout": "pitchout",
    "Automatic Ball": "ball",
    "Automatic Strike": "called_strike",
    "Intent Ball": "ball",
    "Intentional Ball": "ball",
}

def _normalize_mlb_description(raw_desc):
    """Convert MLB API description to Savant-format description."""
    return _MLB_DESC_MAP.get(raw_desc, raw_desc.lower().replace(" ", "_") if raw_desc else "")

# MLB API details.code uses granular codes; Savant collapses to B/S/X
_MLB_TYPE_MAP = {
    "B": "B",   # Ball
    "C": "S",   # Called Strike → Strike
    "S": "S",   # Swinging Strike → Strike
    "F": "S",   # Foul → Strike
    "T": "S",   # Foul Tip → Strike
    "L": "S",   # Foul Bunt → Strike
    "M": "S",   # Missed Bunt → Strike
    "X": "X",   # In play
    "D": "X",   # In play (no out) — some API versions
    "E": "X",   # In play (run(s))
    "H": "B",   # Hit By Pitch → Ball
    "P": "B",   # Pitchout → Ball
    "I": "B",   # Intentional Ball → Ball
    "V": "B",   # Automatic Ball → Ball
    "A": "S",   # Automatic Strike → Strike
    "*B": "B",  # Automatic Ball (alternate code) → Ball
    "*S": "S",  # Automatic Strike (alternate code) → Strike
}

def _normalize_mlb_type_code(code):
    """Convert MLB API details.code to Savant-format type (B/S/X)."""
    return _MLB_TYPE_MAP.get(code, code)

# MLB API event names to Savant format
_MLB_EVENT_MAP = {
    "Single": "single",
    "Double": "double",
    "Triple": "triple",
    "Home Run": "home_run",
    "Walk": "walk",
    "Intentional Walk": "walk",
    "Hit By Pitch": "hit_by_pitch",
    "Strikeout": "strikeout",
    "Strikeout Double Play": "strikeout_double_play",
    "Field Out": "field_out",
    "Flyout": "field_out",
    "Groundout": "field_out",
    "Lineout": "field_out",
    "Pop Out": "field_out",
    "Forceout": "force_out",
    "Force Out": "force_out",
    "Grounded Into DP": "grounded_into_double_play",
    "Double Play": "double_play",
    "Fielders Choice": "fielders_choice",
    "Fielders Choice Out": "fielders_choice_out",
    "Field Error": "field_error",
    "Sac Fly": "sac_fly",
    "Sac Bunt": "sac_bunt",
    "Sac Fly Double Play": "sac_fly_double_play",
    "Triple Play": "triple_play",
    "Catcher Interf": "catcher_interf",
    "Runner Out": "runner_out",
    "Caught Stealing 2B": "caught_stealing_2b",
    "Caught Stealing 3B": "caught_stealing_3b",
    "Caught Stealing Home": "caught_stealing_home",
    "Pickoff 1B": "pickoff_1b",
    "Pickoff 2B": "pickoff_2b",
    "Batter Interference": "batter_interference",
}

def _normalize_mlb_event(raw_event):
    """Convert MLB API event name to Savant-format event."""
    if not raw_event:
        return ""
    return _MLB_EVENT_MAP.get(raw_event, raw_event.lower().replace(" ", "_"))

def _fetch_game_from_mlb_api(game_pk, date_str):
    """Fetch pitch-by-pitch data from MLB Stats API for a single game.
    Returns a DataFrame in the same column format as Savant data."""
    try:
        url = MLB_GAME_FEED_URL.format(game_pk=game_pk)
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        game_data = data.get("gameData", {})
        teams = game_data.get("teams", {})
        home_abbrev = teams.get("home", {}).get("abbreviation", "")
        away_abbrev = teams.get("away", {}).get("abbreviation", "")
        players = game_data.get("players", {})

        rows = []
        all_plays = data.get("liveData", {}).get("plays", {}).get("allPlays", [])
        for pa in all_plays:
            batter_id = pa.get("matchup", {}).get("batter", {}).get("id")
            pitcher_id = pa.get("matchup", {}).get("pitcher", {}).get("id")
            pitcher_name = pa.get("matchup", {}).get("pitcher", {}).get("fullName", "")
            pitcher_hand = pa.get("matchup", {}).get("pitchHand", {}).get("code", "")
            bat_side = pa.get("matchup", {}).get("batSide", {}).get("code", "")
            about = pa.get("about", {})
            is_top = about.get("isTopInning", True)
            inning = about.get("inning", 0)
            inning_topbot = "Top" if is_top else "Bot"

            # Result info — normalize to Savant format
            ab_result = _normalize_mlb_event(pa.get("result", {}).get("event", ""))
            ab_desc = pa.get("result", {}).get("description", "")
            at_bat_number = about.get("atBatIndex", 0)
            outs_when_up = pa.get("count", {}).get("outs", 0) if pa.get("count") else about.get("outs", 0)

            # Hit data — could be on the PA level or on the last playEvent
            hit_data = pa.get("hitData") or {}
            if not hit_data:
                # Check last playEvent for hitData
                play_events_all = pa.get("playEvents", [])
                if play_events_all:
                    hit_data = play_events_all[-1].get("hitData") or {}
            pa_launch_speed = hit_data.get("launchSpeed")
            pa_launch_angle = hit_data.get("launchAngle")
            pa_hc_x = hit_data.get("coordinates", {}).get("coordX")
            pa_hc_y = hit_data.get("coordinates", {}).get("coordY")

            # Collect pitch events; only last pitch gets the PA result (like Savant)
            pitch_events = [e for e in pa.get("playEvents", []) if e.get("isPitch")]
            cur_balls = 0
            cur_strikes = 0
            for idx, event in enumerate(pitch_events):
                is_last_pitch = (idx == len(pitch_events) - 1)
                details = event.get("details", {})
                pitch_data = event.get("pitchData", {})
                coords = pitch_data.get("coordinates", {})
                breaks = pitch_data.get("breaks", {})

                # Normalize MLB API description to Savant format
                raw_desc = details.get("description", "")
                norm_desc = _normalize_mlb_description(raw_desc)

                row = {
                    "game_pk": game_pk,
                    "game_date": date_str,
                    "player_name": pitcher_name,
                    "pitcher": pitcher_id,
                    "batter": batter_id,
                    "stand": bat_side,
                    "p_throws": pitcher_hand,
                    "pitch_type": details.get("type", {}).get("code", ""),
                    "release_speed": pitch_data.get("startSpeed"),
                    "release_extension": pitch_data.get("extension"),
                    "plate_x": coords.get("pX"),
                    "plate_z": coords.get("pZ"),
                    # Savant stores pfx_x/pfx_z in feet; MLB API gives inches — convert
                    # Negate breakHorizontal: MLB API sign convention is opposite to Savant's pfx_x
                    "pfx_x": -breaks.get("breakHorizontal") / 12 if breaks.get("breakHorizontal") is not None else None,
                    "pfx_z": breaks.get("breakVerticalInduced") / 12 if breaks.get("breakVerticalInduced") is not None else None,
                    "sz_top": pitch_data.get("strikeZoneTop"),
                    "sz_bot": pitch_data.get("strikeZoneBottom"),
                    "zone": pitch_data.get("zone"),
                    "description": norm_desc,
                    "type": _normalize_mlb_type_code(details.get("code", "")),  # Normalized to B/S/X
                    "home_team": home_abbrev,
                    "away_team": away_abbrev,
                    "inning": inning,
                    "inning_topbot": inning_topbot,
                    "events": ab_result if is_last_pitch else "",
                    "des": ab_desc if is_last_pitch else "",
                    "game_type": "S",
                    # Hit data (only meaningful on last pitch of PA)
                    "launch_speed": pa_launch_speed if is_last_pitch else None,
                    "launch_angle": pa_launch_angle if is_last_pitch else None,
                    "hc_x": pa_hc_x if is_last_pitch else None,
                    "hc_y": pa_hc_y if is_last_pitch else None,
                    # Context fields for hover tooltips
                    "at_bat_number": at_bat_number,
                    "pitch_number": idx + 1,
                    "outs_when_up": outs_when_up,
                    "batter_name": pa.get("matchup", {}).get("batter", {}).get("fullName", ""),
                    "balls": cur_balls,
                    "strikes": cur_strikes,
                    "on_1b": None,  # Not easily derived from MLB API
                    "on_2b": None,
                    "on_3b": None,
                }
                rows.append(row)

                # Update count for next pitch
                code = details.get("code", "")
                if code in ("B", "H", "P", "I", "V", "*B"):
                    cur_balls = min(cur_balls + 1, 4)
                elif code in ("C", "S", "T", "M", "L", "A", "*S"):
                    cur_strikes = min(cur_strikes + 1, 2)
                elif code == "F" and cur_strikes < 2:
                    cur_strikes += 1

        return pd.DataFrame(rows) if rows else pd.DataFrame()
    except Exception as e:
        print(f"MLB API game feed error for {game_pk}: {e}")
        return pd.DataFrame()

def _fetch_missing_from_mlb_api(date_str, savant_pks):
    """Fetch pitch data from MLB Stats API for games missing from Savant."""
    schedule = _get_mlb_schedule(date_str)
    if not schedule:
        return pd.DataFrame()

    missing_pks = [g["game_pk"] for g in schedule if g["game_pk"] not in savant_pks]
    if not missing_pks:
        return pd.DataFrame()

    print(f"Fetching {len(missing_pks)} games from MLB Stats API fallback...")
    dfs = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(_fetch_game_from_mlb_api, pk, date_str): pk for pk in missing_pks}
        for f in as_completed(futures):
            try:
                gdf = f.result()
                if not gdf.empty:
                    dfs.append(gdf)
            except Exception as e:
                print(f"MLB API fallback error for game {futures[f]}: {e}")
    return pd.concat(dfs, ignore_index=True) if dfs else pd.DataFrame()

def _is_today(date_str):
    """Check if the date string is today (US Eastern)."""
    try:
        from datetime import timedelta
        # Approximate US Eastern as UTC-5 (good enough for cache decisions)
        now_utc = datetime.now(timezone.utc)
        eastern_offset = timedelta(hours=-5)
        now_eastern = now_utc + eastern_offset
        today_str = now_eastern.strftime("%Y-%m-%d")
        return date_str == today_str
    except Exception:
        return False

def fetch_date(date_str):
    # For today's date, use TTL-based cache so live data refreshes
    if date_str in _cache:
        cached = _cache[date_str]
        if isinstance(cached, tuple):
            ts, df = cached
            if _is_today(date_str) and (time.time() - ts) > LIVE_CACHE_TTL:
                pass  # cache expired, re-fetch below
            else:
                return df
        else:
            # Old-style cache entry (no timestamp) — return for past dates, re-fetch for today
            if not _is_today(date_str):
                return cached
            # else fall through to re-fetch

    # Primary: Savant CSV
    df = _fetch_from_savant(date_str)
    if df is None:
        df = pd.DataFrame()

    # Fallback: MLB Stats API for games Savant doesn't have
    savant_pks = set(df["game_pk"].unique()) if not df.empty else set()
    mlb_df = _fetch_missing_from_mlb_api(date_str, savant_pks)
    if not mlb_df.empty:
        # Apply same transforms to MLB API data
        if "pitch_type" in mlb_df.columns:
            mlb_df["pitch_name"] = mlb_df["pitch_type"].map(PITCH_TYPE_MAP)
            mlb_df["pitch_name"] = mlb_df["pitch_name"].fillna("Unclassified")
        mlb_df = _assign_teams_vectorized(mlb_df)
        if not df.empty:
            # Align columns before concat to avoid FutureWarning with empty/NA columns
            shared_cols = list(set(df.columns) | set(mlb_df.columns))
            df = pd.concat([df.reindex(columns=shared_cols), mlb_df.reindex(columns=shared_cols)], ignore_index=True)
        else:
            df = mlb_df

    if df.empty:
        _cache[date_str] = (time.time(), pd.DataFrame())
        return pd.DataFrame()

    df = df.copy()
    if "player_name" in df.columns:
        df["player_name"] = _fix_names_vectorized(df["player_name"])
    # Always map pitch_name from pitch_type codes for consistent naming
    if "pitch_type" in df.columns:
        df["pitch_name"] = df["pitch_type"].map(PITCH_TYPE_MAP)
        df["pitch_name"] = df["pitch_name"].fillna("Unclassified")
    df = _assign_teams_vectorized(df)
    # Apply pitch reclassification overrides
    df = _apply_overrides(df)
    _cache[date_str] = (time.time(), df)
    # Also clear boxscore cache for today so IP/ER refresh
    if _is_today(date_str):
        for gpk in set(df["game_pk"].unique()) if not df.empty else []:
            _boxscore_cache.pop(int(gpk), None)
    return df

SAVANT_PITCHER_SEASON_URL = (
    "https://baseballsavant.mlb.com/statcast_search/csv"
    "?all=true&type=details&pitchers_lookup[]={pitcher_id}"
    "&game_date_gt={year}-03-20&game_date_lt={year}-11-01"
    "&min_pitches=0&min_results=0&min_pas=0&sort_col=pitches"
    "&player_event_sort=api_p_release_speed&sort_order=desc"
)

def fetch_pitcher_season(pitcher_id, season_year):
    """Fetch all pitches for a pitcher in a given season. Cached."""
    cache_key = f"{pitcher_id}_{season_year}"
    if cache_key in _season_cache:
        return _season_cache[cache_key]
    url = SAVANT_PITCHER_SEASON_URL.format(pitcher_id=pitcher_id, year=season_year)
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        resp = requests.get(url, headers=headers, timeout=90)
        resp.raise_for_status()
        content = resp.content.decode("utf-8")
        if not content.strip() or "No Results" in content[:200]:
            _season_cache[cache_key] = pd.DataFrame()
            return _season_cache[cache_key]
        df = pd.read_csv(io.StringIO(content), low_memory=False)
        _season_cache[cache_key] = df if not df.empty else pd.DataFrame()
        return _season_cache[cache_key]
    except Exception as e:
        print(f"Error fetching season data for pitcher {pitcher_id}, year {season_year}: {e}")
        _season_cache[cache_key] = pd.DataFrame()
        return _season_cache[cache_key]

_range_cache = {}  # { "start_end": (timestamp, dataframe) }
RANGE_CACHE_TTL = 3600  # 1 hour

# ── Aggregation result cache ──
# Caches the final JSON-serializable results from aggregation functions
# so repeated leaderboard/team/player requests skip re-aggregation.
_agg_cache = {}  # { "agg_key": (timestamp, result_list) }
AGG_CACHE_TTL = 3600  # matches range cache TTL

SAVANT_RANGE_URL = (
    "https://baseballsavant.mlb.com/statcast_search/csv"
    "?hfPT=&hfAB=&hfGT=R%7CS%7CE%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones="
    "&hfPull=&hfC=&hfSea=&hfSit=&player_type=pitcher&hfOuts=&hfOpponent="
    "&pitcher_throws=&batter_stands=&hfSA=&game_date_gt={start}&game_date_lt={end}"
    "&hfMo=&hfTeam=&home_road=&hfRO=&position=&hfInfield=&hfOutfield="
    "&hfInn=&hfBBT=&hfFlag=&metric_1=&group_by=name&min_pitches=0"
    "&min_results=0&min_pas=0&sort_col=pitches&player_event_sort=api_p_release_speed"
    "&sort_order=desc&type=details&all=true"
)


def _transform_range_df(df):
    """Apply standard transforms to a range DataFrame (names, pitch mapping, teams)."""
    df = df.copy()
    if "player_name" in df.columns:
        df["player_name"] = _fix_names_vectorized(df["player_name"])
    if "pitch_type" in df.columns:
        df["pitch_name"] = df["pitch_type"].map(PITCH_TYPE_MAP)
        df["pitch_name"] = df["pitch_name"].fillna("Unclassified")
    df = _assign_teams_vectorized(df)
    df = _apply_overrides(df)
    return df


def _fetch_savant_range_raw(start_date, end_date):
    """Fetch raw CSV from Savant for a date range. Returns raw DataFrame (no transforms)."""
    url = SAVANT_RANGE_URL.format(start=start_date, end=end_date)
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        resp = requests.get(url, headers=headers, timeout=120)
        resp.raise_for_status()
        content = resp.content.decode("utf-8")
        if not content.strip() or "No Results" in content[:200]:
            return pd.DataFrame()
        df = pd.read_csv(io.StringIO(content), low_memory=False)
        return df if not df.empty else pd.DataFrame()
    except Exception as e:
        print(f"Error fetching date range {start_date} to {end_date}: {e}")
        return pd.DataFrame()


def _merge_daily_cache(df, start_date, end_date):
    """Merge any cached daily data into a range DataFrame.

    The daily cache (_cache) includes MLB API fallback data that the Savant
    range endpoint may not have (e.g., today's live games). This merges those
    extra game_pk rows into the range DataFrame so player pages show all games.
    """
    daily_frames = []
    for date_str, cached in _cache.items():
        if date_str < start_date or date_str > end_date:
            continue
        if isinstance(cached, tuple):
            _, day_df = cached
        else:
            day_df = cached
        if day_df is not None and not day_df.empty:
            daily_frames.append(day_df)

    if not daily_frames:
        return df

    daily_all = pd.concat(daily_frames, ignore_index=True)
    if df.empty:
        return daily_all

    # Find game_pks in daily cache that are NOT in the range data
    range_pks = set(df["game_pk"].unique()) if "game_pk" in df.columns else set()
    daily_pks = set(daily_all["game_pk"].unique()) if "game_pk" in daily_all.columns else set()
    missing_pks = daily_pks - range_pks
    if not missing_pks:
        return df

    extra = daily_all[daily_all["game_pk"].isin(missing_pks)]
    merged = pd.concat([df, extra], ignore_index=True)
    return merged


def fetch_date_range(start_date, end_date):
    """Fetch all pitches across a date range from Savant, supplemented with daily cache."""
    cache_key = f"{start_date}_{end_date}"
    if cache_key in _range_cache:
        ts, df = _range_cache[cache_key]
        if (time.time() - ts) < RANGE_CACHE_TTL:
            # Still merge daily cache for any games fetched after range was cached
            return _merge_daily_cache(df, start_date, end_date)

    df = _fetch_savant_range_raw(start_date, end_date)
    if not df.empty:
        df = _transform_range_df(df)

    # Merge in any daily-cached data (includes MLB API fallback games)
    df = _merge_daily_cache(df if not df.empty else pd.DataFrame(), start_date, end_date)

    _range_cache[cache_key] = (time.time(), df)
    return df


def prefetch_boxscores(df):
    """Pre-fetch all boxscores for game_pks in df using parallel threads."""
    if df.empty or "game_pk" not in df.columns:
        return
    game_pks = [int(gpk) for gpk in df["game_pk"].unique()]
    # Filter out already-cached ones
    uncached = [gpk for gpk in game_pks if gpk not in _boxscore_cache]
    if not uncached:
        return
    print(f"Pre-fetching {len(uncached)} boxscores in parallel...")

    def _fetch_one(gpk):
        try:
            return gpk, _get_boxscore_stats(gpk)
        except Exception:
            return gpk, {}

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(_fetch_one, gpk): gpk for gpk in uncached}
        for future in as_completed(futures):
            try:
                gpk, stats = future.result()
                # _get_boxscore_stats already populates _boxscore_cache
            except Exception:
                pass
    print(f"Boxscore pre-fetch complete ({len(uncached)} games)")


def get_agg_cache(key):
    """Get a cached aggregation result if fresh."""
    if key in _agg_cache:
        ts, result = _agg_cache[key]
        if (time.time() - ts) < AGG_CACHE_TTL:
            return result
    return None

def set_agg_cache(key, result):
    """Store an aggregation result in cache."""
    _agg_cache[key] = (time.time(), result)


def fetch_all_pitchers_list(start_date, end_date):
    """Get deduplicated list of all pitchers in date range."""
    df = fetch_date_range(start_date, end_date)
    if df.empty:
        return []
    grouped = df.groupby("pitcher").agg({
        "player_name": "first",
        "pitcher_team": lambda x: list(x.unique()),
        "p_throws": "first",
    }).reset_index()
    # Use to_dict instead of iterrows
    records = grouped.to_dict(orient="records")
    result = [{
        "pitcher_id": int(r["pitcher"]),
        "name": r["player_name"],
        "teams": r["pitcher_team"] if isinstance(r["pitcher_team"], list) else [r["pitcher_team"]],
        "hand": r["p_throws"],
    } for r in records]
    result.sort(key=lambda r: r["name"])
    return result


# ── Startup warmup ──

def _get_default_end_date():
    """Get today's date in Eastern time."""
    try:
        import zoneinfo
        et = zoneinfo.ZoneInfo("America/New_York")
    except Exception:
        import pytz
        et = pytz.timezone("America/New_York")
    return datetime.now(et).strftime("%Y-%m-%d")


def warmup_range_data(start_date="2026-02-20", end_date=None):
    """Pre-fetch and warm all caches for the standard date range.
    Called on server startup in a background thread."""
    global _warmup_status
    if end_date is None:
        end_date = _get_default_end_date()

    with _warmup_lock:
        if _warmup_status["loading"]:
            return  # already running
        _warmup_status["loading"] = True
        _warmup_status["progress"] = "Fetching pitch data from Savant..."

    print(f"[Warmup] Starting data pre-fetch: {start_date} to {end_date}")
    t0 = time.time()
    try:
        df = fetch_date_range(start_date, end_date)
        elapsed = time.time() - t0
        print(f"[Warmup] Savant data loaded: {len(df)} rows in {elapsed:.1f}s")

        if not df.empty:
            with _warmup_lock:
                _warmup_status["progress"] = "Pre-fetching boxscore data..."
            prefetch_boxscores(df)

            with _warmup_lock:
                _warmup_status["progress"] = "Pre-computing aggregations..."

            # Pre-compute the default leaderboard aggregations
            from aggregation import aggregate_pitcher_results_range, aggregate_pitch_data_range
            results = aggregate_pitcher_results_range(df)
            set_agg_cache(f"leaderboard_results_{start_date}_{end_date}", results)
            pitch_data = aggregate_pitch_data_range(df)
            set_agg_cache(f"leaderboard_pitch-data_{start_date}_{end_date}", pitch_data)

            # Also warm the daily cache for the default date so first game load is instant
            with _warmup_lock:
                _warmup_status["progress"] = "Warming default date cache..."
            try:
                default_date = get_default_date()
                fetch_date(default_date)
                print(f"[Warmup] Default date {default_date} warmed")

                # Pre-compute daily aggregations for the initial-load endpoint
                with _warmup_lock:
                    _warmup_status["progress"] = "Pre-computing daily aggregations..."
                from aggregation import aggregate_pitch_data, aggregate_pitcher_results
                pd_result = aggregate_pitch_data(default_date, None)
                set_agg_cache(f"daily_pitch_{default_date}", pd_result)
                pr_result = aggregate_pitcher_results(default_date, None)
                set_agg_cache(f"daily_results_{default_date}", pr_result)
                print(f"[Warmup] Daily aggregations for {default_date} cached")
            except Exception as e2:
                print(f"[Warmup] Default date warm failed: {e2}")

            elapsed_total = time.time() - t0
            print(f"[Warmup] Complete in {elapsed_total:.1f}s — {len(df)} pitches, boxscores + aggregations cached")

        with _warmup_lock:
            _warmup_status["ready"] = True
            _warmup_status["loading"] = False
            _warmup_status["progress"] = "Ready"
            _warmup_status["error"] = None
    except Exception as e:
        print(f"[Warmup] Error: {e}")
        with _warmup_lock:
            _warmup_status["loading"] = False
            _warmup_status["error"] = str(e)
            _warmup_status["progress"] = f"Error: {e}"


def start_warmup(start_date="2026-02-20", end_date=None):
    """Kick off warmup in a background thread."""
    t = threading.Thread(target=warmup_range_data, args=(start_date, end_date), daemon=True)
    t.start()
    return t


def get_warmup_status():
    """Return current warmup status dict."""
    with _warmup_lock:
        return dict(_warmup_status)


def clear_cache(date_str=None):
    if date_str:
        _cache.pop(date_str, None)
        _schedule_cache.pop(date_str, None)
        # Clear daily agg caches for this date
        for k in list(_agg_cache.keys()):
            if date_str in k:
                _agg_cache.pop(k, None)
    else:
        _cache.clear()
        _season_cache.clear()
        _range_cache.clear()
        _agg_cache.clear()
        _schedule_cache.clear()

MLB_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&sportId=51&gameType=S&gameType=R&gameType=E&gameType=W&gameType=D&gameType=L&gameType=F&startDate={date}&endDate={date}&hydrate=team"

# Map full team names to abbreviations used by Savant
_TEAM_ABBREV = {
    "Arizona Diamondbacks": "AZ", "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL",
    "Boston Red Sox": "BOS", "Chicago Cubs": "CHC", "Chicago White Sox": "CWS",
    "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE", "Colorado Rockies": "COL",
    "Detroit Tigers": "DET", "Houston Astros": "HOU", "Kansas City Royals": "KC",
    "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD", "Miami Marlins": "MIA",
    "Milwaukee Brewers": "MIL", "Minnesota Twins": "MIN", "New York Mets": "NYM",
    "New York Yankees": "NYY", "Oakland Athletics": "ATH", "Philadelphia Phillies": "PHI",
    "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD", "San Francisco Giants": "SF",
    "Seattle Mariners": "SEA", "St. Louis Cardinals": "STL", "Tampa Bay Rays": "TB",
    "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR", "Washington Nationals": "WSH",
    "Athletics": "ATH",
    # WBC / International Teams
    "United States": "USA", "Japan": "JPN", "Dominican Republic": "DOM",
    "Puerto Rico": "PUR", "Korea": "KOR", "Cuba": "CUB", "Mexico": "MEX",
    "Venezuela": "VEN", "Netherlands": "NED", "Chinese Taipei": "TPE",
    "Italy": "ITA", "Israel": "ISR", "Great Britain": "GBR", "Australia": "AUS",
    "Panama": "PAN", "Czech Republic": "CZE", "Nicaragua": "NCA", "Colombia": "COL",
    "Canada": "CAN", "Brazil": "BRA", "China": "CHN", "New Zealand": "NZL",
}

_schedule_cache = {}  # { date_str: (timestamp, games_list) }
SCHEDULE_CACHE_TTL = 120  # 2 minutes

def _get_mlb_schedule(date_str):
    """Get full game list from MLB Stats API (includes all game types). Cached."""
    if date_str in _schedule_cache:
        ts, games = _schedule_cache[date_str]
        if time.time() - ts < SCHEDULE_CACHE_TTL:
            return games
    try:
        url = MLB_SCHEDULE_URL.format(date=date_str)
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        games = []
        for date_entry in data.get("dates", []):
            for g in date_entry.get("games", []):
                away_name = g["teams"]["away"]["team"]["name"]
                home_name = g["teams"]["home"]["team"]["name"]
                away = g["teams"]["away"]["team"].get("abbreviation") or _TEAM_ABBREV.get(away_name, away_name)
                home = g["teams"]["home"]["team"].get("abbreviation") or _TEAM_ABBREV.get(home_name, home_name)
                games.append({
                    "game_pk": g["gamePk"],
                    "label": f"{away} @ {home}",
                    "home_team": home,
                    "away_team": away,
                    "status": g["status"]["detailedState"],
                })
        _schedule_cache[date_str] = (time.time(), games)
        return games
    except Exception as e:
        print(f"MLB Schedule API error: {e}")
        return None

def get_default_date():
    """Return the smart default date:
    - Yesterday (ET) if no game has started today yet
    - Today (ET) once any game is in progress or finished
    The 'day' starts at 5 AM ET — before that, treat it as the prior day."""
    from datetime import datetime, timedelta
    try:
        import zoneinfo
        et = zoneinfo.ZoneInfo("America/New_York")
    except Exception:
        import pytz
        et = pytz.timezone("America/New_York")
    now_et = datetime.now(et)
    # Before 5 AM ET, treat "today" as the prior calendar day
    if now_et.hour < 5:
        now_et = now_et - timedelta(days=1)
    today_str = now_et.strftime("%Y-%m-%d")
    yesterday_str = (now_et - timedelta(days=1)).strftime("%Y-%m-%d")

    # Check if any game today has started
    schedule = _get_mlb_schedule(today_str)
    if schedule:
        not_started = {"Scheduled", "Pre-Game", "Warmup", "Delayed Start"}
        for g in schedule:
            if g.get("status") not in not_started:
                # At least one game is in progress or finished
                return today_str
    # No games started today (or no games at all) — show yesterday
    return yesterday_str

def get_games(date_str):
    df = fetch_date(date_str)  # This now includes MLB API fallback data
    data_pks = set(df["game_pk"].unique()) if not df.empty else set()

    # Try MLB Stats API for full game list
    mlb_games = _get_mlb_schedule(date_str)
    if mlb_games:
        for g in mlb_games:
            g["has_data"] = g["game_pk"] in data_pks
        return sorted(mlb_games, key=lambda g: g["label"])

    # Fallback to Savant-only if MLB API fails
    if df.empty: return []
    games = []
    for game_pk, gdf in df.groupby("game_pk"):
        home = gdf["home_team"].iloc[0]
        away = gdf["away_team"].iloc[0]
        games.append({"game_pk": int(game_pk), "label": f"{away} @ {home}", "home_team": home, "away_team": away, "has_data": True})
    return sorted(games, key=lambda g: g["label"])

_boxscore_cache = {}

def _get_boxscore_stats(game_pk):
    """Fetch pitching stats per pitcher from MLB Stats API boxscore.
    Returns dict: { pitcher_id: { 'er': int, 'ip': str, 'hits': int, 'bbs': int, 'ks': int, 'hrs': int } }"""
    if game_pk in _boxscore_cache:
        return _boxscore_cache[game_pk]
    try:
        url = f"https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live"
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        box = data.get("liveData", {}).get("boxscore", {})
        stats_map = {}
        for side in ["away", "home"]:
            team = box.get("teams", {}).get(side, {})
            for pid in team.get("pitchers", []):
                pinfo = team.get("players", {}).get(f"ID{pid}", {})
                stats = pinfo.get("stats", {}).get("pitching", {})
                er = stats.get("earnedRuns")
                ip = stats.get("inningsPitched")
                hits = stats.get("hits")
                bbs = stats.get("baseOnBalls")
                ks = stats.get("strikeOuts")
                hrs = stats.get("homeRuns")
                if er is not None or ip is not None:
                    stats_map[pid] = {
                        "er": er if er is not None else 0,
                        "ip": ip,
                        "hits": hits if hits is not None else 0,
                        "bbs": bbs if bbs is not None else 0,
                        "ks": ks if ks is not None else 0,
                        "hrs": hrs if hrs is not None else 0,
                    }
        _boxscore_cache[game_pk] = stats_map
        return stats_map
    except Exception as e:
        print(f"Error fetching boxscore for game {game_pk}: {e}")
        _boxscore_cache[game_pk] = {}
        return {}

def get_earned_runs(game_pk):
    """Backward-compatible wrapper: returns { pitcher_id: earned_runs }"""
    stats = _get_boxscore_stats(game_pk)
    return {pid: s["er"] for pid, s in stats.items()}

def get_boxscore_ip(game_pk):
    """Returns { pitcher_id: inningsPitched_str }"""
    stats = _get_boxscore_stats(game_pk)
    return {pid: s.get("ip") for pid, s in stats.items()}

def get_boxscore_full(game_pk):
    """Returns full boxscore stats: { pitcher_id: { er, ip, hits, bbs, ks, hrs } }"""
    return _get_boxscore_stats(game_pk)


# ── Linescore + Play-by-Play ──────────────────────────────────────────

_feed_cache = {}  # { game_pk: full_json }

def _get_game_feed(game_pk):
    """Fetch and cache the full MLB Stats API game feed."""
    if game_pk in _feed_cache:
        return _feed_cache[game_pk]
    try:
        url = MLB_GAME_FEED_URL.format(game_pk=game_pk)
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        _feed_cache[game_pk] = data
        return data
    except Exception as e:
        print(f"Error fetching game feed for {game_pk}: {e}")
        return None

def get_game_linescore(game_pk, pitcher_id=None):
    """Return linescore, play-by-play, and pitcher exit info for a game."""
    feed = _get_game_feed(game_pk)
    if not feed:
        return {}

    game_data = feed.get("gameData", {})
    teams = game_data.get("teams", {})
    away_abbrev = teams.get("away", {}).get("abbreviation", "")
    home_abbrev = teams.get("home", {}).get("abbreviation", "")

    live = feed.get("liveData", {})

    # ── Linescore ──
    ls = live.get("linescore", {})
    innings_raw = ls.get("innings", [])
    innings = []
    for inn in innings_raw:
        innings.append({
            "num": inn.get("num", 0),
            "away": {
                "runs": inn.get("away", {}).get("runs", 0),
                "hits": inn.get("away", {}).get("hits", 0),
                "errors": inn.get("away", {}).get("errors", 0),
            },
            "home": {
                "runs": inn.get("home", {}).get("runs", 0),
                "hits": inn.get("home", {}).get("hits", 0),
                "errors": inn.get("home", {}).get("errors", 0),
            },
        })

    ls_teams = ls.get("teams", {})
    totals = {
        "away": {
            "runs": ls_teams.get("away", {}).get("runs", 0),
            "hits": ls_teams.get("away", {}).get("hits", 0),
            "errors": ls_teams.get("away", {}).get("errors", 0),
        },
        "home": {
            "runs": ls_teams.get("home", {}).get("runs", 0),
            "hits": ls_teams.get("home", {}).get("hits", 0),
            "errors": ls_teams.get("home", {}).get("errors", 0),
        },
    }

    # ── Play-by-play ──
    all_plays = live.get("plays", {}).get("allPlays", [])
    # Group plays by (inning, isTop)
    half_innings = {}  # { (inning, is_top): [pa, ...] }
    # Track pitcher appearances: { pitcher_id: { last_inning, last_top, innings_set } }
    pitcher_tracker = {}

    for pa in all_plays:
        about = pa.get("about", {})
        inning = about.get("inning", 0)
        is_top = about.get("isTopInning", True)
        key = (inning, is_top)

        matchup = pa.get("matchup", {})
        batter_name = matchup.get("batter", {}).get("fullName", "")
        batter_id = matchup.get("batter", {}).get("id", 0)
        p_name = matchup.get("pitcher", {}).get("fullName", "")
        p_id = matchup.get("pitcher", {}).get("id", 0)
        bat_side = matchup.get("batSide", {}).get("code", "R")

        result = pa.get("result", {})
        result_event = result.get("event", "")
        result_desc = result.get("description", "")
        result_rbi = result.get("rbi", 0)

        # Hit data for this PA — could be on PA level or last playEvent
        pa_hit = pa.get("hitData") or {}
        if not pa_hit:
            play_events_all = pa.get("playEvents", [])
            if play_events_all:
                pa_hit = play_events_all[-1].get("hitData") or {}
        pa_ls = pa_hit.get("launchSpeed")
        pa_la = pa_hit.get("launchAngle")
        pa_hcx = pa_hit.get("coordinates", {}).get("coordX")
        pa_hcy = pa_hit.get("coordinates", {}).get("coordY")
        pa_trajectory = pa_hit.get("trajectory")  # ground_ball, fly_ball, line_drive, popup
        pa_hardness = pa_hit.get("hardness")  # hard, medium, soft
        pa_total_distance = pa_hit.get("totalDistance")
        pa_outs = about.get("outs", 0) if about else 0

        # Build pitch list
        pitch_events = [ev for ev in pa.get("playEvents", []) if ev.get("isPitch")]
        pitches = []
        balls = 0
        strikes = 0
        for pidx, ev in enumerate(pitch_events):
            is_last_p = (pidx == len(pitch_events) - 1)
            det = ev.get("details", {})
            pd_ = ev.get("pitchData", {})
            pitch_type_code = det.get("type", {}).get("code", "")
            pitch_type_name = PITCH_TYPE_MAP.get(pitch_type_code, pitch_type_code)
            speed = pd_.get("startSpeed")
            desc = det.get("description", "")
            code = det.get("code", "")
            p_coords = pd_.get("coordinates", {})
            p_breaks = pd_.get("breaks", {})

            count_str = f"{balls}-{strikes}"

            pitches.append({
                "num": len(pitches) + 1,
                "type": pitch_type_name,
                "type_code": pitch_type_code,
                "speed": round(speed, 1) if speed else None,
                "desc": desc,
                "count": count_str,
                # Location & break for strikezone + hover
                "plate_x": p_coords.get("pX"),
                "plate_z": p_coords.get("pZ"),
                "pfx_x": round(-p_breaks.get("breakHorizontal", 0) / 12, 4) if p_breaks.get("breakHorizontal") is not None else None,
                "pfx_z": round(p_breaks.get("breakVerticalInduced", 0) / 12, 4) if p_breaks.get("breakVerticalInduced") is not None else None,
                "zone": pd_.get("zone"),
                # Hit data on last pitch only
                "launch_speed": pa_ls if is_last_p else None,
                "launch_angle": pa_la if is_last_p else None,
                "hc_x": pa_hcx if is_last_p else None,
                "hc_y": pa_hcy if is_last_p else None,
            })

            # Update count for next pitch
            if code in ("B", "H", "P", "I", "V", "*B"):
                balls = min(balls + 1, 4)
            elif code in ("C", "S", "T", "M", "L", "A", "*S"):
                strikes = min(strikes + 1, 2)
            elif code == "F" and strikes < 2:
                strikes += 1
            # X (in play) doesn't change count

        pa_obj = {
            "batter": batter_name,
            "batter_id": batter_id,
            "pitcher": p_name,
            "pitcher_id": p_id,
            "result": result_event,
            "description": result_desc,
            "rbi": result_rbi,
            "pitches": pitches,
            "outs": pa_outs,
            "stand": bat_side,
            "launch_speed": pa_ls,
            "launch_angle": pa_la,
            "hc_x": pa_hcx,
            "hc_y": pa_hcy,
            "trajectory": pa_trajectory,
            "hardness": pa_hardness,
            "total_distance": pa_total_distance,
        }

        if key not in half_innings:
            half_innings[key] = []
        half_innings[key].append(pa_obj)

        # Track pitcher appearances
        if p_id not in pitcher_tracker:
            pitcher_tracker[p_id] = {"name": p_name, "last_inning": inning, "last_top": is_top, "innings": set()}
        else:
            pitcher_tracker[p_id]["last_inning"] = inning
            pitcher_tracker[p_id]["last_top"] = is_top
        pitcher_tracker[p_id]["innings"].add(key)

    # Build ordered plays list
    plays = []
    for (inn, top) in sorted(half_innings.keys()):
        plays.append({
            "inning": inn,
            "top": top,
            "pas": half_innings[(inn, top)],
        })

    # Compute pitcher exit info
    pitcher_exit = {}
    for pid, info in pitcher_tracker.items():
        last_inn = info["last_inning"]
        last_top = info["last_top"]
        # Check if pitcher was pulled mid-inning: were there PAs after theirs in the same half-inning?
        key = (last_inn, last_top)
        pas_in_half = half_innings.get(key, [])
        # Find the index of the last PA by this pitcher
        last_idx = -1
        for i, pa in enumerate(pas_in_half):
            if pa["pitcher_id"] == pid:
                last_idx = i
        mid_inning = last_idx < len(pas_in_half) - 1 if last_idx >= 0 else False

        pitcher_exit[str(pid)] = {
            "name": info["name"],
            "last_inning": last_inn,
            "last_top": last_top,
            "mid_inning": mid_inning,
        }

    return {
        "away_team": away_abbrev,
        "home_team": home_abbrev,
        "innings": innings,
        "totals": totals,
        "plays": plays,
        "pitcher_exit": pitcher_exit,
    }
