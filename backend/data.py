import io
import os
import json
import re
import time
import threading
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import numpy as np
import pandas as pd
import requests
from redis_cache import redis_get, redis_set, redis_delete, redis_delete_pattern, redis_available, redis_incr

_cache = {}          # { date_str: (timestamp, dataframe) }
_season_cache = {}
_batter_name_cache = {}  # { batter_id: "Full Name" }
LIVE_CACHE_TTL = 60  # seconds — refresh live data every 60s

# ── Warmup / pre-fetch state ──
_warmup_status = {"ready": False, "loading": False, "error": None, "progress": ""}
_warmup_lock = threading.Lock()

# ── Pitch reclassification overrides ──
OVERRIDES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pitch_overrides.json")
_overrides = {}  # { "gamePk_pitcherId_atBat_pitchNum": {"original":"FF","new":"FC",...} }
_override_version = 0  # Incremented on every save/remove to bust agg caches

# Cache-shape version. Bump whenever a cached payload (card, season totals,
# player page) gains or changes fields so all old cache entries miss after
# deploy. Included in every relevant cache key alongside _override_version.
# v7: cache keys carry a {level} prefix (mlb|aaa) for the Triple-A tab.
# v8: pitcher result rows gain `velo_ext` + `velo_ext_season` + `velo_ext_delta`;
#     AAA season aggregations now span all Statcast-tracked minor leagues
#     (AAA + Single-A FSL), not AAA-only.
CARD_SCHEMA_VERSION = 8

# Allowed level values. New levels must be added here and exposed via the
# frontend `level` state and any cron schedules.
LEVELS = ("mlb", "aaa")
DEFAULT_LEVEL = "mlb"

def _load_overrides():
    global _overrides, _override_version
    # Try Redis first
    val = redis_get("overrides")
    if val is not None:
        _overrides = val
    elif os.path.exists(OVERRIDES_PATH):
        # Fall back to local file
        try:
            with open(OVERRIDES_PATH, "r") as f:
                _overrides = json.load(f)
            # Migrate to Redis
            redis_set("overrides", _overrides)
        except Exception:
            _overrides = {}
    # Restore override version from Redis so cache keys match across restarts.
    # If the key doesn't exist yet (first deploy with this fix), seed it from
    # the number of overrides so all processes start from the same baseline.
    ver = redis_get("override_version")
    if ver is not None:
        _override_version = int(ver)
    elif _overrides:
        _override_version = len(_overrides)
        redis_set("override_version", _override_version)
    return _overrides

def _save_overrides():
    # Save to Redis (primary)
    redis_set("overrides", _overrides)
    # Also save to local file (works locally, may fail on serverless)
    try:
        with open(OVERRIDES_PATH, "w") as f:
            json.dump(_overrides, f, indent=2)
    except Exception:
        pass

def get_override_version():
    """Return current override version counter for cache-busting."""
    return _override_version

def save_pitch_override(game_pk, pitcher_id, at_bat_number, pitch_number, new_pitch_type, level=DEFAULT_LEVEL):
    """Save a pitch reclassification override.
    new_pitch_type can be either a human name ('Four-Seamer') or a code ('FF').
    `level` (mlb|aaa) is prefixed on the key so AAA reclassifications don't
    collide with MLB ones at the same game_pk numeric value.
    """
    global _override_version
    key = f"{level}_{game_pk}_{pitcher_id}_{at_bat_number}_{pitch_number}"
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
    # Persist version to Redis so warmup crons and restarts use the same cache keys
    new_ver = redis_incr("override_version")
    if new_ver is not None:
        _override_version = new_ver
    else:
        _override_version += 1
    return key

def remove_pitch_override(game_pk, pitcher_id, at_bat_number, pitch_number, level=DEFAULT_LEVEL):
    """Remove a pitch reclassification override. Falls back to the legacy
    un-prefixed key when nothing matches the level-prefixed one (so MLB
    reclassifications saved before v7 can still be undone)."""
    global _override_version
    key = f"{level}_{game_pk}_{pitcher_id}_{at_bat_number}_{pitch_number}"
    removed = _overrides.pop(key, None)
    if removed is None and level == DEFAULT_LEVEL:
        # Legacy 4-part key (no level prefix) — pre-v7 MLB overrides
        legacy_key = f"{game_pk}_{pitcher_id}_{at_bat_number}_{pitch_number}"
        removed = _overrides.pop(legacy_key, None)
    if removed:
        _save_overrides()
        # Persist version to Redis so warmup crons and restarts use the same cache keys
        new_ver = redis_incr("override_version")
        if new_ver is not None:
            _override_version = new_ver
        else:
            _override_version += 1
    return removed is not None

def get_all_overrides():
    return dict(_overrides)

def _apply_overrides(df, level=DEFAULT_LEVEL):
    """Apply pitch reclassification overrides to a DataFrame.

    Override keys use the level-prefixed form `{level}_{gpk}_{pid}_{ab}_{pn}`.
    Legacy 4-part MLB keys (saved before v7) are still honored when `level`
    is mlb so historical reclassifications survive the migration.
    """
    if not _overrides or df.empty:
        return df
    required = {"game_pk", "pitcher", "at_bat_number"}
    if not required.issubset(df.columns):
        return df
    has_pitch_number = "pitch_number" in df.columns
    for key, ov in _overrides.items():
        parts = key.split("_")
        if len(parts) == 5:
            ov_level, gpk_s, pid_s, abn_s, pnum_s = parts
        elif len(parts) == 4:
            # Legacy MLB-only override (pre-v7)
            ov_level = DEFAULT_LEVEL
            gpk_s, pid_s, abn_s, pnum_s = parts
        else:
            continue
        if ov_level != level:
            continue
        try:
            gpk, pid, abn, pnum = int(gpk_s), int(pid_s), int(abn_s), int(pnum_s)
        except ValueError:
            continue
        mask = (df["game_pk"] == gpk) & (df["pitcher"] == pid) & (df["at_bat_number"] == abn)
        if has_pitch_number:
            # Match by pitch_number column value directly (not positional index)
            exact_mask = mask & (df["pitch_number"] == pnum)
            if exact_mask.any():
                idx = df.loc[exact_mask].index[0]
                df.at[idx, "pitch_type"] = ov["new_type"]
                df.at[idx, "pitch_name"] = ov["new_name"]
        else:
            # Fallback: positional index (only if pitch_number column missing)
            matching_rows = df.loc[mask]
            if matching_rows.empty:
                continue
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

# Triple-A: Savant's `&minors=true` returns AAA + Single-A FSL combined
# (FSL is Statcast's testing ground). There is no Savant URL param to filter
# to AAA only — verified empirically in scripts/verify_aaa.py. Filter rows
# by game_pk against the MLB Stats API sportId=11 schedule instead.
SAVANT_AAA_FLAG = "&minors=true"
MLB_STATS_AAA_SCHEDULE_URL = (
    "https://statsapi.mlb.com/api/v1/schedule?sportId=11"
    "&startDate={start}&endDate={end}"
)

_aaa_pks_cache = {}  # { (start, end): (timestamp, set) } — short TTL since live games are added during the day
AAA_PKS_CACHE_TTL = 300  # 5 minutes


def _get_aaa_game_pks(start_date, end_date):
    """Return the set of game_pks for AAA games in [start_date, end_date]
    inclusive. Cached for 5 minutes — live AAA games can appear partway
    through a day, so we don't cache forever even for past dates."""
    key = (start_date, end_date)
    if key in _aaa_pks_cache:
        ts, pks = _aaa_pks_cache[key]
        if (time.time() - ts) < AAA_PKS_CACHE_TTL:
            return pks
    url = MLB_STATS_AAA_SCHEDULE_URL.format(start=start_date, end=end_date)
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        pks = set()
        for d in data.get("dates", []):
            for g in d.get("games", []):
                pk = g.get("gamePk")
                if pk is not None:
                    pks.add(int(pk))
        _aaa_pks_cache[key] = (time.time(), pks)
        return pks
    except Exception as e:
        print(f"[AAA schedule] Error fetching {start_date}..{end_date}: {e}")
        # Return cached value if available (better stale than empty)
        if key in _aaa_pks_cache:
            return _aaa_pks_cache[key][1]
        return set()

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

def _resolve_batter_names(batter_ids):
    """Resolve a Series of numeric batter IDs to full names via MLB Stats API.
    Uses a persistent cache to minimize API calls."""
    global _batter_name_cache
    # Hydrate from Redis if L1 is empty
    if not _batter_name_cache:
        redis_names = redis_get("batter_names")
        if redis_names:
            _batter_name_cache = {int(k): v for k, v in redis_names.items()}
    unique_ids = set(int(x) for x in batter_ids.dropna().unique() if pd.notna(x) and int(x) > 0)
    missing = unique_ids - set(_batter_name_cache.keys())
    if missing:
        # MLB Stats API supports comma-separated person IDs
        # Batch in groups of 100 to avoid URL length issues
        missing_list = list(missing)
        for i in range(0, len(missing_list), 100):
            batch = missing_list[i:i+100]
            ids_str = ",".join(str(x) for x in batch)
            try:
                url = f"https://statsapi.mlb.com/api/v1/people?personIds={ids_str}"
                resp = requests.get(url, timeout=15)
                resp.raise_for_status()
                for person in resp.json().get("people", []):
                    _batter_name_cache[person["id"]] = person.get("fullName", "")
            except Exception:
                pass  # fail silently, names just stay empty
        # Fill any still-missing with empty string
        for bid in missing:
            if bid not in _batter_name_cache:
                _batter_name_cache[bid] = ""
        # Persist to Redis
        redis_set("batter_names", {str(k): v for k, v in _batter_name_cache.items()})
    return batter_ids.map(lambda x: _batter_name_cache.get(int(x), "") if pd.notna(x) and int(x) > 0 else "")

def _assign_teams_vectorized(df):
    """Vectorized pitcher_team/opponent assignment based on inning_topbot."""
    if "inning_topbot" not in df.columns or "home_team" not in df.columns:
        return df
    is_top = df["inning_topbot"] == "Top"
    computed_team = np.where(is_top, df["home_team"], df["away_team"])
    computed_opp = np.where(is_top, df["away_team"], df["home_team"])
    if "pitcher_team" not in df.columns:
        df["pitcher_team"] = computed_team
        df["opponent"] = computed_opp
    else:
        # Fill NaN values (e.g. Savant rows after concat with MLB API rows)
        df["pitcher_team"] = df["pitcher_team"].fillna(pd.Series(computed_team, index=df.index))
        df["opponent"] = df["opponent"].fillna(pd.Series(computed_opp, index=df.index))
    return df

def _fetch_from_savant(date_str, level=DEFAULT_LEVEL):
    url = SAVANT_CSV_URL.format(date=date_str)
    if level == "aaa":
        url += SAVANT_AAA_FLAG
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        resp = requests.get(url, headers=headers, timeout=60)
        resp.raise_for_status()
        content = resp.content.decode("utf-8")
        if not content.strip() or "No Results" in content[:200]:
            return pd.DataFrame()
        df = pd.read_csv(io.StringIO(content), low_memory=False)
        if df.empty:
            return pd.DataFrame()
        if level == "aaa":
            # Strip Single-A FSL rows — Savant returns both levels under
            # &minors=true. AAA isolation is by game_pk vs MLB schedule API.
            aaa_pks = _get_aaa_game_pks(date_str, date_str)
            if "game_pk" in df.columns and aaa_pks:
                df = df[df["game_pk"].isin(aaa_pks)]
            else:
                # No schedule data — better empty than mixing in Single-A
                return pd.DataFrame()
        return df
    except Exception as e:
        print(f"Error fetching from Baseball Savant ({level}): {e}")
        if level == "mlb":
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


_BASE_END_LABELS = {"1B": "1st", "2B": "2nd", "3B": "3rd"}


def _runner_wp_pb_reason(runner):
    """Return "Wild Pitch" / "Passed Ball" if this runner's movement was
    caused by one of those events; otherwise None."""
    details = runner.get("details", {}) or {}
    # Primary signals: details.event ("Wild Pitch") and details.eventType
    # ("wild_pitch"). movementReason carries a per-runner hint sometimes
    # prefixed with "r_" (e.g. "r_wild_pitch", "r_passed_ball").
    ev = str(details.get("event") or details.get("eventType") or "").lower().replace(" ", "_")
    reason = str(details.get("movementReason") or "").lower()
    if reason.startswith("r_"):
        reason = reason[2:]
    if ev == "wild_pitch" or reason == "wild_pitch":
        return "Wild Pitch"
    if ev == "passed_ball" or reason == "passed_ball":
        return "Passed Ball"
    return None


def _extract_wp_pb_moves(play_events):
    """Scan a PA's play_events for mid-PA wild-pitch / passed-ball actions and
    return { (runner_id, end_base): "Wild Pitch"|"Passed Ball" }. Used as a
    fallback when pa.runners' details.event doesn't carry the cause."""
    moves = {}
    for ev in play_events or []:
        det = ev.get("details", {}) or {}
        et = str(det.get("eventType") or "").lower()
        if et not in ("wild_pitch", "passed_ball"):
            continue
        reason = "Wild Pitch" if et == "wild_pitch" else "Passed Ball"
        for r in ev.get("runners", []) or []:
            runner_id = r.get("details", {}).get("runner", {}).get("id")
            end = r.get("movement", {}).get("end")
            if runner_id is not None and end:
                moves[(runner_id, end)] = reason
    return moves


def _enrich_pa_description(desc, runners, include_plain=False, play_events=None):
    """Enrich a PA description with runner-movement sentences.

    - Upgrades plain "X to 2nd." to "X advances to 2nd on Wild Pitch." (or
      Passed Ball) for any runner whose movement was caused by a WP/PB. Runs
      for every PA so mid-PA WP/PB advances get annotated regardless of how
      the PA ended.
    - When include_plain=True (walk/HBP PAs), appends missing plain "X to
      Nth." sentences so the description always lists all base movements.
    - If play_events is provided, mid-PA WP/PB actions are cross-referenced
      to catch cases where pa.runners' details.event points at the PA event
      instead of the specific mid-PA cause.
    """
    if not runners:
        return desc or ""
    desc = desc or ""
    wp_pb_moves = _extract_wp_pb_moves(play_events)
    append_list = []
    for runner in runners:
        mv = runner.get("movement", {}) or {}
        origin = mv.get("originBase")
        end = mv.get("end")
        if not origin:
            continue
        details = runner.get("details", {}) or {}
        name = details.get("runner", {}).get("fullName", "")
        if not name:
            continue
        wp_pb = _runner_wp_pb_reason(runner)
        if not wp_pb:
            runner_id = details.get("runner", {}).get("id")
            wp_pb = wp_pb_moves.get((runner_id, end)) if runner_id is not None else None
        if end == "score":
            plain = f"{name} scores."
            annotated = f"{name} scores on {wp_pb}." if wp_pb else None
        elif end in _BASE_END_LABELS:
            label = _BASE_END_LABELS[end]
            plain = f"{name} to {label}."
            annotated = f"{name} advances to {label} on {wp_pb}." if wp_pb else None
        else:
            continue

        if wp_pb and annotated:
            if annotated.lower() in desc.lower():
                continue  # already annotated
            pattern = re.compile(re.escape(plain), re.IGNORECASE)
            if pattern.search(desc):
                desc = pattern.sub(annotated, desc, count=1)
            else:
                append_list.append(annotated)
        elif include_plain:
            if plain.lower() not in desc.lower():
                append_list.append(plain)

    if append_list:
        desc = desc.rstrip()
        if desc and not desc.endswith("."):
            desc += "."
        joiner = "  " if desc else ""
        desc = f"{desc}{joiner}" + "  ".join(append_list)
    return desc

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
        # Track base state across PAs by processing runner movements
        bases = {1: None, 2: None, 3: None}  # base number → runner ID or None
        prev_half = None  # (inning, isTop) to detect half-inning changes

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

            # Clear bases on half-inning change
            cur_half = (inning, is_top)
            if cur_half != prev_half:
                bases = {1: None, 2: None, 3: None}
                prev_half = cur_half

            # Snapshot base state at start of this PA (before any movements)
            pa_on_1b = bases[1]
            pa_on_2b = bases[2]
            pa_on_3b = bases[3]

            # Result info — normalize to Savant format
            ab_result = _normalize_mlb_event(pa.get("result", {}).get("event", ""))
            ab_desc = pa.get("result", {}).get("description", "")

            # Annotate WP/PB-caused runner movements on every PA, and also
            # ensure walk/HBP PAs list all base movements (the MLB API
            # description usually has them, but not always).
            ab_desc = _enrich_pa_description(
                ab_desc,
                pa.get("runners"),
                include_plain=ab_result in ("walk", "hit_by_pitch"),
                play_events=pa.get("playEvents"),
            )

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
                    # Velocity/acceleration for HAVAA calculation
                    "vx0": coords.get("vX0"),
                    "vy0": coords.get("vY0"),
                    "vz0": coords.get("vZ0"),
                    "ax": coords.get("aX"),
                    "ay": coords.get("aY"),
                    "az": coords.get("aZ"),
                    # Release position for arm angle
                    "release_pos_x": coords.get("x0"),
                    "release_pos_z": coords.get("z0"),
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
                    "on_1b": pa_on_1b,
                    "on_2b": pa_on_2b,
                    "on_3b": pa_on_3b,
                }
                rows.append(row)

                # Update count for next pitch. Codes mirror _MLB_TYPE_MAP:
                # balls = B/H/P/I/V/*B, strikes = C/S/F/T/L/M/A/*S, in-play = X/D/E.
                # ("F" = foul — was missing previously, which left cur_strikes
                # stuck at <2 for any PA with foul balls and made PAR%
                # denominators wildly under-counted.)
                code = details.get("code", "")
                if code in ("B", "H", "P", "I", "V", "*B"):
                    cur_balls = min(cur_balls + 1, 4)
                elif code in ("C", "S", "F", "T", "L", "M", "A", "*S"):
                    cur_strikes = min(cur_strikes + 1, 2)

            # After this PA: update base state from runner movements
            _BASE_MAP = {"1B": 1, "2B": 2, "3B": 3}
            for runner in pa.get("runners", []):
                mv = runner.get("movement", {})
                origin = mv.get("originBase")
                end = mv.get("end")
                runner_id = runner.get("details", {}).get("runner", {}).get("id")
                # Clear the origin base
                if origin in _BASE_MAP:
                    bases[_BASE_MAP[origin]] = None
                # Set the end base (None/empty means scored or out)
                if end in _BASE_MAP:
                    bases[_BASE_MAP[end]] = runner_id
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

def _get_today_str():
    """Get today's date string in US Eastern (approx UTC-5)."""
    from datetime import timedelta
    now_utc = datetime.now(timezone.utc)
    eastern_offset = timedelta(hours=-5)
    return (now_utc + eastern_offset).strftime("%Y-%m-%d")

def _is_today(date_str):
    """Check if the date string is today (US Eastern)."""
    try:
        return date_str == _get_today_str()
    except Exception:
        return False

def fetch_date(date_str, level=DEFAULT_LEVEL):
    # In-memory cache key includes level so MLB and AAA don't collide
    cache_key = (level, date_str)
    if cache_key in _cache:
        cached = _cache[cache_key]
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
    df = _fetch_from_savant(date_str, level=level)
    if df is None:
        df = pd.DataFrame()

    # Fallback: MLB Stats API for games Savant doesn't have. MLB only —
    # AAA doesn't have a per-pitch fallback path (and Savant minors data
    # has full coverage at AAA).
    if level == DEFAULT_LEVEL:
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
        _cache[cache_key] = (time.time(), pd.DataFrame())
        return pd.DataFrame()

    df = df.copy()
    # Resolve batter IDs to names where batter_name is missing/empty
    if "batter" in df.columns:
        if "batter_name" not in df.columns:
            df["batter_name"] = _resolve_batter_names(df["batter"])
        else:
            missing_mask = df["batter_name"].isna() | (df["batter_name"].astype(str).str.strip() == "") | (df["batter_name"].astype(str) == "nan")
            if missing_mask.any():
                resolved = _resolve_batter_names(df.loc[missing_mask, "batter"])
                df.loc[missing_mask, "batter_name"] = resolved.values
    if "player_name" in df.columns:
        df["player_name"] = _fix_names_vectorized(df["player_name"])
    # Always map pitch_name from pitch_type codes for consistent naming
    if "pitch_type" in df.columns:
        df["pitch_name"] = df["pitch_type"].map(PITCH_TYPE_MAP)
        df["pitch_name"] = df["pitch_name"].fillna("Unclassified")
    df = _assign_teams_vectorized(df)
    # Apply pitch reclassification overrides (level-filtered)
    df = _apply_overrides(df, level=level)
    _cache[cache_key] = (time.time(), df)
    # Also clear boxscore + feed caches for today so IP/ER/scoreboard refresh
    if _is_today(date_str):
        for gpk in set(df["game_pk"].unique()) if not df.empty else []:
            _boxscore_cache.pop(int(gpk), None)
            _feed_cache.pop(int(gpk), None)
            redis_delete(f"boxscore:{int(gpk)}")
            redis_delete(f"gamestate:{int(gpk)}")
            redis_delete(f"feed:{int(gpk)}")
    return df

SAVANT_PITCHER_SEASON_URL = (
    "https://baseballsavant.mlb.com/statcast_search/csv"
    "?all=true&type=details&pitchers_lookup[]={pitcher_id}"
    "&game_date_gt={year}-03-20&game_date_lt={year}-11-01"
    "&min_pitches=0&min_results=0&min_pas=0&sort_col=pitches"
    "&player_event_sort=api_p_release_speed&sort_order=desc"
)

def fetch_pitcher_season(pitcher_id, season_year, level=DEFAULT_LEVEL):
    """Fetch all pitches for a pitcher in a given season. Cached.

    For `level=aaa` we hit Savant with `&minors=true` and DO NOT post-filter
    by AAA game_pks — we want every Statcast-tracked minor-league level the
    pitcher appeared at (AAA + Single-A FSL today). This matches the
    "season totals = total minor league stats" semantics for AAA pitcher
    cards. Levels that Statcast doesn't track (AA, High-A non-FSL, lower)
    are not available through this pipeline.
    """
    cache_key = (level, pitcher_id, season_year)
    if cache_key in _season_cache:
        return _season_cache[cache_key]
    url = SAVANT_PITCHER_SEASON_URL.format(pitcher_id=pitcher_id, year=season_year)
    if level == "aaa":
        url += SAVANT_AAA_FLAG
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
        print(f"Error fetching season data for pitcher {pitcher_id}, year {season_year}, level {level}: {e}")
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


def _transform_range_df(df, level=DEFAULT_LEVEL):
    """Apply standard transforms to a range DataFrame (names, pitch mapping, teams)."""
    df = df.copy()
    if "player_name" in df.columns:
        df["player_name"] = _fix_names_vectorized(df["player_name"])
    if "pitch_type" in df.columns:
        df["pitch_name"] = df["pitch_type"].map(PITCH_TYPE_MAP)
        df["pitch_name"] = df["pitch_name"].fillna("Unclassified")
    df = _assign_teams_vectorized(df)
    df = _apply_overrides(df, level=level)
    return df


def _fetch_savant_range_chunk(start_date, end_date, level=DEFAULT_LEVEL):
    """Fetch a single chunk of CSV from Savant. Returns raw DataFrame.

    For AAA range fetches we DO NOT filter to AAA game_pks — we want the
    full set of Statcast-tracked minor league rows (currently AAA + Single-A
    FSL) so per-pitcher season aggregations include every level a pitcher
    appeared at. Daily AAA games (`fetch_date(level=aaa)`) still filter to
    AAA only because the games tab lists only AAA games.
    """
    url = SAVANT_RANGE_URL.format(start=start_date, end=end_date)
    if level == "aaa":
        url += SAVANT_AAA_FLAG
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        resp = requests.get(url, headers=headers, timeout=120)
        resp.raise_for_status()
        content = resp.content.decode("utf-8")
        if not content.strip() or "No Results" in content[:200]:
            return pd.DataFrame()
        df = pd.read_csv(io.StringIO(content), low_memory=False)
        if df.empty:
            return pd.DataFrame()
        return df
    except Exception as e:
        print(f"Error fetching date range {start_date} to {end_date} ({level}): {e}")
        return pd.DataFrame()


def _fetch_savant_range_raw(start_date, end_date, level=DEFAULT_LEVEL):
    """Fetch raw CSV from Savant for a date range, chunking into weekly intervals
    to avoid the 25,000 row cap per request."""
    from datetime import datetime, timedelta
    start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    chunk_days = 5  # ~5 days per chunk keeps well under 25k rows
    frames = []
    cur = start_dt
    while cur <= end_dt:
        chunk_end = min(cur + timedelta(days=chunk_days - 1), end_dt)
        cs = cur.strftime("%Y-%m-%d")
        ce = chunk_end.strftime("%Y-%m-%d")
        print(f"Fetching Savant chunk {cs} to {ce} ({level})...")
        chunk_df = _fetch_savant_range_chunk(cs, ce, level=level)
        if not chunk_df.empty:
            frames.append(chunk_df)
        cur = chunk_end + timedelta(days=1)
    if not frames:
        return pd.DataFrame()
    combined = pd.concat(frames, ignore_index=True)
    # Deduplicate in case of overlap
    if "game_pk" in combined.columns and "at_bat_number" in combined.columns and "pitch_number" in combined.columns:
        combined = combined.drop_duplicates(subset=["game_pk", "at_bat_number", "pitch_number"], keep="first")
    print(f"Savant range total ({level}): {len(combined)} rows across {combined['game_date'].nunique() if 'game_date' in combined.columns else '?'} dates")
    return combined


def _merge_daily_cache(df, start_date, end_date, level=DEFAULT_LEVEL):
    """Merge any cached daily data into a range DataFrame for the given level.

    The daily cache (_cache) includes MLB API fallback data that the Savant
    range endpoint may not have (e.g., today's live games). This merges those
    extra game_pk rows into the range DataFrame so player pages show all games.
    """
    daily_frames = []
    for cache_key, cached in _cache.items():
        # Cache keys are (level, date_str) tuples since v7
        if not (isinstance(cache_key, tuple) and len(cache_key) == 2):
            continue
        cache_level, date_str = cache_key
        if cache_level != level:
            continue
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


def fetch_date_range(start_date, end_date, level=DEFAULT_LEVEL):
    """Fetch all pitches across a date range from Savant, supplemented with daily cache."""
    cache_key = (level, start_date, end_date)
    if cache_key in _range_cache:
        ts, df = _range_cache[cache_key]
        if not _is_today(end_date) or (time.time() - ts) < RANGE_CACHE_TTL:
            # Past-date ranges never expire; today's data uses TTL-based refresh
            return _merge_daily_cache(df, start_date, end_date, level=level)

    df = _fetch_savant_range_raw(start_date, end_date, level=level)
    if not df.empty:
        df = _transform_range_df(df, level=level)

    # Merge in any daily-cached data (includes MLB API fallback games)
    df = _merge_daily_cache(df if not df.empty else pd.DataFrame(), start_date, end_date, level=level)

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


def _agg_key_is_live(key):
    """Check if an agg cache key references today's date (needs TTL-based refresh)."""
    return _get_today_str() in key

def get_agg_cache(key):
    """Get a cached aggregation result. Checks L1 (dict) then L2 (Redis).
    Past-date keys never expire; keys referencing today use AGG_CACHE_TTL."""
    if key in _agg_cache:
        ts, result = _agg_cache[key]
        if not _agg_key_is_live(key) or (time.time() - ts) < AGG_CACHE_TTL:
            return result
    # L2: Redis — only trust for past-date keys; live keys may be stale
    # (Redis entries have no TTL, so serverless cold starts would serve stale live data)
    if not _agg_key_is_live(key):
        val = redis_get(f"agg:{key}")
        if val is not None:
            _agg_cache[key] = (time.time(), val)
            return val
    return None

def set_agg_cache(key, result):
    """Store an aggregation result in L1 (dict) and L2 (Redis).
    Live keys get a TTL in Redis matching the in-memory TTL."""
    _agg_cache[key] = (time.time(), result)
    ttl = AGG_CACHE_TTL if _agg_key_is_live(key) else None
    redis_set(f"agg:{key}", result, ttl=ttl)


_pitchers_list_cache = {}  # { "start_end": (timestamp, list) }

def fetch_all_pitchers_list(start_date, end_date, level=DEFAULT_LEVEL):
    """Get deduplicated list of all pitchers in date range. Cached."""
    cache_key = (level, start_date, end_date)
    if cache_key in _pitchers_list_cache:
        ts, result = _pitchers_list_cache[cache_key]
        if not _is_today(end_date) or (time.time() - ts) < RANGE_CACHE_TTL:
            return result
    redis_key = f"pitchers:{level}_{start_date}_{end_date}"
    # L2: Redis — only trust for past-date ranges; live ranges may be stale
    if not _is_today(end_date):
        redis_val = redis_get(redis_key)
        if redis_val is not None:
            _pitchers_list_cache[cache_key] = (time.time(), redis_val)
            return redis_val
    df = fetch_date_range(start_date, end_date, level=level)
    if df.empty:
        return []
    grouped = df.groupby("pitcher").agg({
        "player_name": "first",
        "pitcher_team": lambda x: list(x.unique()),
        "p_throws": "first",
    }).reset_index()
    records = grouped.to_dict(orient="records")
    result = [{
        "pitcher_id": int(r["pitcher"]),
        "name": r["player_name"],
        "teams": r["pitcher_team"] if isinstance(r["pitcher_team"], list) else [r["pitcher_team"]],
        "hand": r["p_throws"],
    } for r in records]
    result.sort(key=lambda r: r["name"])
    _pitchers_list_cache[cache_key] = (time.time(), result)
    ttl = RANGE_CACHE_TTL if _is_today(end_date) else None
    redis_set(redis_key, result, ttl=ttl)
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


def is_custom_season_range(start_date, end_date):
    """True if (start_date, end_date) is NOT the canonical season-to-date range
    (current year's 03-25 through today ET). Custom ranges get a '_custom'
    suffix on player_v2 / season_totals cache keys so historical lookups
    don't collide with the stable, overwrite-in-place season key."""
    today = _get_default_end_date()
    current_year = today[:4]
    return start_date != f"{current_year}-03-25" or end_date != today


def warmup_range_data(start_date="2026-03-25", end_date=None, level=DEFAULT_LEVEL):
    """Pre-fetch and warm all caches for the standard date range.
    Called on server startup in a background thread."""
    global _warmup_status
    if end_date is None:
        end_date = _get_default_end_date()

    with _warmup_lock:
        if _warmup_status["loading"]:
            return  # already running
        _warmup_status["loading"] = True
        _warmup_status["progress"] = f"Fetching pitch data from Savant ({level})..."

    print(f"[Warmup] Starting data pre-fetch ({level}): {start_date} to {end_date}")
    t0 = time.time()
    try:
        df = fetch_date_range(start_date, end_date, level=level)
        elapsed = time.time() - t0
        print(f"[Warmup] Savant data loaded ({level}): {len(df)} rows in {elapsed:.1f}s")

        if not df.empty:
            # MLB only: prefetch MLB Stats API boxscores. AAA boxscores still
            # work via the same endpoints but we don't pre-warm to keep cron
            # runtime under control.
            if level == DEFAULT_LEVEL:
                with _warmup_lock:
                    _warmup_status["progress"] = "Pre-fetching boxscore data..."
                prefetch_boxscores(df)

            with _warmup_lock:
                _warmup_status["progress"] = f"Pre-computing aggregations ({level})..."

            # Pre-compute the default leaderboard aggregations
            from aggregation import aggregate_pitcher_results_range, aggregate_pitch_data_range
            results = aggregate_pitcher_results_range(df)
            set_agg_cache(f"leaderboard_{level}_results_{start_date}_{end_date}", results)
            pitch_data = aggregate_pitch_data_range(df)
            set_agg_cache(f"leaderboard_{level}_pitch-data_{start_date}_{end_date}", pitch_data)

            # Pre-compute per-team aggregations so team pages load instantly
            if "pitcher_team" in df.columns:
                with _warmup_lock:
                    _warmup_status["progress"] = "Pre-computing team aggregations..."
                teams = df["pitcher_team"].dropna().unique()
                for team in teams:
                    tdf = df[df["pitcher_team"] == team]
                    if tdf.empty:
                        continue
                    t_results = aggregate_pitcher_results_range(tdf)
                    set_agg_cache(f"team_{level}_{team}_results_{start_date}_{end_date}", t_results)
                    t_pitch = aggregate_pitch_data_range(tdf)
                    set_agg_cache(f"team_{level}_{team}_pitch-data_{start_date}_{end_date}", t_pitch)
                print(f"[Warmup] Team aggregations cached for {len(teams)} teams ({level})")

            # Also warm the daily cache for the default date so first game load is instant
            with _warmup_lock:
                _warmup_status["progress"] = "Warming default date cache..."
            try:
                default_date = get_default_date(level=level)
                fetch_date(default_date, level=level)
                print(f"[Warmup] Default date {default_date} warmed ({level})")

                # Pre-compute daily aggregations for the initial-load endpoint
                with _warmup_lock:
                    _warmup_status["progress"] = "Pre-computing daily aggregations..."
                from aggregation import aggregate_pitch_data, aggregate_pitcher_results
                pd_result = aggregate_pitch_data(default_date, None, level=level)
                set_agg_cache(f"daily_pitch_{level}_{default_date}", pd_result)
                pr_result = aggregate_pitcher_results(default_date, None, level=level)
                set_agg_cache(f"daily_results_{level}_s{CARD_SCHEMA_VERSION}_{default_date}", pr_result)
                print(f"[Warmup] Daily aggregations for {default_date} ({level}) cached")
            except Exception as e2:
                print(f"[Warmup] Default date warm failed: {e2}")

            elapsed_total = time.time() - t0
            print(f"[Warmup] Complete ({level}) in {elapsed_total:.1f}s — {len(df)} pitches")

        with _warmup_lock:
            _warmup_status["ready"] = True
            _warmup_status["loading"] = False
            _warmup_status["progress"] = "Ready"
            _warmup_status["error"] = None
    except Exception as e:
        print(f"[Warmup] Error ({level}): {e}")
        with _warmup_lock:
            _warmup_status["loading"] = False
            _warmup_status["error"] = str(e)
            _warmup_status["progress"] = f"Error: {e}"


def start_warmup(start_date="2026-03-25", end_date=None, level=DEFAULT_LEVEL):
    """Kick off warmup in a background thread."""
    t = threading.Thread(target=warmup_range_data, args=(start_date, end_date, level), daemon=True)
    t.start()
    return t


# ── Player page computation (shared by API endpoint and warmup) ──

def compute_player_page(df, pitcher_id):
    """Compute the full player page result dict for a single pitcher.
    Expects the full season DataFrame (not pre-filtered).
    Returns the result dict, or None if the pitcher has no data."""
    from aggregation import (
        aggregate_pitch_data_range, get_pitcher_game_log,
        _prep_df, build_pitches_list,
    )

    pdf = df[df["pitcher"] == pitcher_id]
    if pdf.empty:
        return None
    # Exclude All-Star Game data
    if "game_type" in pdf.columns:
        pdf = pdf[pdf["game_type"] != "A"]
    if pdf.empty:
        return None

    name = pdf["player_name"].iloc[0]
    teams = list(pdf["pitcher_team"].unique()) if "pitcher_team" in pdf.columns else []
    hand = pdf["p_throws"].iloc[0] if "p_throws" in pdf.columns else ""
    info = {"name": name, "teams": teams, "hand": hand, "pitcher_id": int(pitcher_id)}

    pdf_prepped = _prep_df(pdf)
    pitch_summary = aggregate_pitch_data_range(pdf_prepped, prepped=True)

    pdf_vs_l = pdf_prepped[pdf_prepped["stand"] == "L"] if "stand" in pdf_prepped.columns else pdf_prepped.iloc[0:0]
    pdf_vs_r = pdf_prepped[pdf_prepped["stand"] == "R"] if "stand" in pdf_prepped.columns else pdf_prepped.iloc[0:0]
    pitch_summary_vs_l = aggregate_pitch_data_range(pdf_vs_l, prepped=True) if not pdf_vs_l.empty else []
    pitch_summary_vs_r = aggregate_pitch_data_range(pdf_vs_r, prepped=True) if not pdf_vs_r.empty else []

    game_log = get_pitcher_game_log(df, pitcher_id)

    if game_log:
        total_pitches = sum(g.get("pitches", 0) for g in game_log)
        total_ip_thirds = 0
        for g in game_log:
            ip_val = g.get("ip", "0.0")
            parts = str(ip_val).split(".")
            full = int(parts[0])
            thirds = int(parts[1]) if len(parts) > 1 else 0
            total_ip_thirds += full * 3 + thirds
        total_pa_count = sum(g.get("pa_count", 0) for g in game_log)
        total_two_str_pas = sum(g.get("two_strike_pas", 0) for g in game_log)
        total_two_str_pitches = sum(g.get("two_strike_pitches", 0) for g in game_log)
        total_strikeouts_par = sum(g.get("strikeouts_for_par", 0) for g in game_log)
        results_summary = {
            "games": len(game_log),
            "ip": f"{total_ip_thirds // 3}.{total_ip_thirds % 3}",
            "hits": sum(g.get("hits", 0) for g in game_log),
            "bbs": sum(g.get("bbs", 0) for g in game_log),
            "ks": sum(g.get("ks", 0) for g in game_log),
            "hrs": sum(g.get("hrs", 0) for g in game_log),
            "er": sum(g.get("er", 0) for g in game_log),
            "runs": sum(g.get("runs", 0) for g in game_log),
            "batters_faced": sum(g.get("batters_faced", 0) for g in game_log),
            "games_started": sum(g.get("games_started", 0) for g in game_log),
            "whiffs": sum(g.get("whiffs", 0) for g in game_log),
            "swstr_pct": round(sum(g.get("whiffs", 0) for g in game_log) / total_pitches * 100, 1) if total_pitches > 0 else 0,
            "csw_pct": round(sum(g.get("csw_pct", 0) * g.get("pitches", 0) for g in game_log) / total_pitches, 1) if total_pitches > 0 else 0,
            "strike_pct": round(sum(g.get("strikes", 0) for g in game_log) / total_pitches * 100, 1) if total_pitches > 0 else 0,
            "two_str_pct": round(total_two_str_pas / total_pa_count * 100, 1) if total_pa_count > 0 else 0,
            # Per-pitch PAR%: Ks / pitches thrown in 2-strike counts.
            "par_pct": round(total_strikeouts_par / total_two_str_pitches * 100, 1) if total_two_str_pitches > 0 else 0,
            "ip_thirds": total_ip_thirds,
            "pitches": total_pitches,
            "wins": sum(1 for g in game_log if g.get("decision") == "W"),
            "losses": sum(1 for g in game_log if g.get("decision") == "L"),
        }
    else:
        results_summary = {}

    per_game_summaries = {}
    for gpk in pdf_prepped["game_pk"].unique():
        gpdf = pdf_prepped[pdf_prepped["game_pk"] == gpk]
        per_game_summaries[str(int(gpk))] = {
            "all": aggregate_pitch_data_range(gpdf, prepped=True),
            "vs_l": aggregate_pitch_data_range(gpdf[gpdf["stand"] == "L"], prepped=True) if (gpdf["stand"] == "L").any() else [],
            "vs_r": aggregate_pitch_data_range(gpdf[gpdf["stand"] == "R"], prepped=True) if (gpdf["stand"] == "R").any() else [],
        }

    all_pitches = build_pitches_list(pdf)
    sz_top = float(pdf["sz_top"].mean()) if "sz_top" in pdf.columns and pdf["sz_top"].notna().any() else 3.5
    sz_bot = float(pdf["sz_bot"].mean()) if "sz_bot" in pdf.columns and pdf["sz_bot"].notna().any() else 1.5

    return {
        "info": info, "pitch_summary": pitch_summary,
        "pitch_summary_vs_l": pitch_summary_vs_l, "pitch_summary_vs_r": pitch_summary_vs_r,
        "per_game_summaries": per_game_summaries, "results_summary": results_summary,
        "game_log": game_log, "pitches": all_pitches, "sz_top": sz_top, "sz_bot": sz_bot,
    }


def warmup_player_pages(df, start_date, end_date, pitcher_ids, only_date=None, level=DEFAULT_LEVEL):
    """Pre-compute and cache player pages for the given pitcher IDs.

    Args:
        df: Full season DataFrame (already loaded).
        start_date, end_date: Date range strings (for cache key).
        pitcher_ids: List of pitcher IDs to compute. Required.
        only_date: If set, only compute for pitchers who pitched on this date.
        level: mlb|aaa — included in the cache key.

    Returns:
        dict with 'computed' count and 'skipped' count.
    """
    target_ids = list(pitcher_ids or [])

    # If only_date is set, filter to pitchers who pitched on that date
    if only_date and "game_date" in df.columns:
        day_df = df[df["game_date"] == only_date]
        day_pitcher_ids = set(day_df["pitcher"].unique().astype(int))
        target_ids = [pid for pid in target_ids if pid in day_pitcher_ids]

    computed = 0
    skipped = 0
    suffix = "_custom" if is_custom_season_range(start_date, end_date) else ""
    for pid in target_ids:
        agg_key = f"player_v2_{level}_{pid}_s{CARD_SCHEMA_VERSION}{suffix}"
        try:
            result = compute_player_page(df, pid)
            if result is not None:
                set_agg_cache(agg_key, result)
                computed += 1
            else:
                skipped += 1
        except Exception as e:
            print(f"[PlayerWarmup] Error computing player {pid}: {e}")
            skipped += 1

    return {"computed": computed, "skipped": skipped}


def get_warmup_status():
    """Return current warmup status dict."""
    with _warmup_lock:
        return dict(_warmup_status)


def clear_cache(date_str=None, level=None):
    """Clear caches for a specific date and/or level.

    - `date_str=None`, `level=None` → clear everything
    - `date_str=X`, `level=None` → clear date X across all levels
    - `date_str=X`, `level=L` → clear date X for level L only
    - `date_str=None`, `level=L` → clear all entries for level L
    """
    if date_str:
        # Drop matching daily caches (filter by level if provided)
        for k in list(_cache.keys()):
            if isinstance(k, tuple) and len(k) == 2:
                k_level, k_date = k
                if k_date == date_str and (level is None or k_level == level):
                    _cache.pop(k, None)
        for k in list(_schedule_cache.keys()):
            if isinstance(k, tuple) and len(k) == 2:
                k_level, k_date = k
                if k_date == date_str and (level is None or k_level == level):
                    _schedule_cache.pop(k, None)
                    redis_delete(f"schedule:{k_level}_{k_date}")
        # Clear daily agg caches for this date
        for k in list(_agg_cache.keys()):
            if date_str in k:
                if level is not None and f"_{level}_" not in k and not k.endswith(f"_{level}"):
                    continue
                _agg_cache.pop(k, None)
                redis_delete(f"agg:{k}")
        # Clear range cache and pitchers list cache — any range covering this date
        # is now stale (e.g., reclassifying a pitch on April 5 invalidates
        # the March 25–April 11 range and its derived caches)
        for range_dict in (_range_cache, _pitchers_list_cache):
            for k in list(range_dict.keys()):
                if isinstance(k, tuple) and len(k) == 3:
                    k_level, start, end = k
                    if level is not None and k_level != level:
                        continue
                    if start <= date_str <= end:
                        range_dict.pop(k, None)
    elif level is not None:
        # Clear everything for one level
        for k in list(_cache.keys()):
            if isinstance(k, tuple) and k[0] == level:
                _cache.pop(k, None)
        for k in list(_range_cache.keys()):
            if isinstance(k, tuple) and k[0] == level:
                _range_cache.pop(k, None)
        for k in list(_pitchers_list_cache.keys()):
            if isinstance(k, tuple) and k[0] == level:
                _pitchers_list_cache.pop(k, None)
        for k in list(_schedule_cache.keys()):
            if isinstance(k, tuple) and k[0] == level:
                _schedule_cache.pop(k, None)
        for k in list(_season_cache.keys()):
            if isinstance(k, tuple) and k[0] == level:
                _season_cache.pop(k, None)
        for k in list(_agg_cache.keys()):
            if f"_{level}_" in k:
                _agg_cache.pop(k, None)
                redis_delete(f"agg:{k}")
    else:
        _cache.clear()
        _season_cache.clear()
        _range_cache.clear()
        _agg_cache.clear()
        _schedule_cache.clear()
        # Clear Redis aggregation and schedule keys
        redis_delete_pattern("agg:*")
        redis_delete_pattern("schedule:*")

def _last_name(full_name):
    """Extract last name from full name (e.g. 'Gerrit Cole' → 'Cole')."""
    return full_name.split()[-1] if full_name else ""

MLB_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&sportId=51&gameType=S&gameType=R&gameType=E&gameType=W&gameType=D&gameType=L&gameType=F&startDate={date}&endDate={date}&hydrate=team,probablePitcher,linescore"
# Triple-A schedule. sportId=11 covers International League + PCL (single
# combined sport ID per MLB Stats API). gameType=R only — AAA doesn't run
# spring training games on the same gameType codes as MLB.
AAA_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule?sportId=11&gameType=R&startDate={date}&endDate={date}&hydrate=team,probablePitcher,linescore"

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

def _get_mlb_schedule(date_str, force_refresh=False, level=DEFAULT_LEVEL):
    """Get full game list from MLB Stats API (includes all game types). Cached.
    force_refresh=True bypasses both in-memory and Redis caches.
    level=mlb hits sportId=1+51, level=aaa hits sportId=11."""
    cache_key = (level, date_str)
    redis_key = f"schedule:{level}_{date_str}"
    if not force_refresh:
        if cache_key in _schedule_cache:
            ts, games = _schedule_cache[cache_key]
            if time.time() - ts < SCHEDULE_CACHE_TTL:
                return games
        # L2: Redis
        redis_val = redis_get(redis_key)
        if redis_val is not None:
            _schedule_cache[cache_key] = (time.time(), redis_val)
            return redis_val
    try:
        url_template = AAA_SCHEDULE_URL if level == "aaa" else MLB_SCHEDULE_URL
        url = url_template.format(date=date_str)
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
                # Probable pitchers
                away_sp = g["teams"]["away"].get("probablePitcher", {})
                home_sp = g["teams"]["home"].get("probablePitcher", {})
                # Game start time (ISO 8601 UTC)
                game_date_utc = g.get("gameDate", "")
                # Convert to ET for display
                game_time_et = ""
                if game_date_utc:
                    try:
                        from datetime import timezone as _tz, timedelta as _td
                        dt_utc = datetime.fromisoformat(game_date_utc.replace("Z", "+00:00"))
                        try:
                            import zoneinfo
                            et = zoneinfo.ZoneInfo("America/New_York")
                            dt_et = dt_utc.astimezone(et)
                        except Exception:
                            dt_et = dt_utc - _td(hours=4)  # EDT approximation
                        hour = dt_et.hour % 12 or 12
                        minute = dt_et.minute
                        ampm = "am" if dt_et.hour < 12 else "pm"
                        game_time_et = f"{hour}:{minute:02d}{ampm}"
                    except Exception:
                        pass
                # Linescore (scores + inning for live/final games)
                linescore = g.get("linescore", {})
                home_score = linescore.get("teams", {}).get("home", {}).get("runs")
                away_score = linescore.get("teams", {}).get("away", {}).get("runs")
                current_inning = linescore.get("currentInning", 0)
                inning_half = linescore.get("inningHalf", "")
                detailed_state = g["status"]["detailedState"]
                abstract_state = g["status"].get("abstractGameState", "")
                games.append({
                    "game_pk": g["gamePk"],
                    "label": f"{away} @ {home}",
                    "home_team": home,
                    "away_team": away,
                    "status": detailed_state,
                    "abstract_state": abstract_state,
                    "game_time_et": game_time_et,
                    "game_date_utc": game_date_utc,
                    "away_sp": _last_name(away_sp.get("fullName", "")) if away_sp else "",
                    "home_sp": _last_name(home_sp.get("fullName", "")) if home_sp else "",
                    "home_score": home_score if home_score is not None else None,
                    "away_score": away_score if away_score is not None else None,
                    "current_inning": current_inning,
                    "inning_half": inning_half,
                })
        _schedule_cache[cache_key] = (time.time(), games)
        redis_set(redis_key, games, ttl=SCHEDULE_CACHE_TTL)
        return games
    except Exception as e:
        print(f"MLB Schedule API error ({level}): {e}")
        return None

def get_default_date(level=DEFAULT_LEVEL):
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
    not_started = {"Scheduled", "Pre-Game", "Warmup", "Delayed Start"}
    schedule = _get_mlb_schedule(today_str, level=level)
    if schedule:
        if any(g.get("status") not in not_started for g in schedule):
            return today_str
        # All games show not_started — but if any game's scheduled start
        # time has already passed, the cache is likely stale. Force a fresh
        # API fetch to verify.
        from datetime import timezone as _tz
        now_utc = datetime.now(_tz.utc)
        should_have_started = False
        for g in schedule:
            game_utc_str = g.get("game_date_utc", "")
            if game_utc_str:
                try:
                    game_utc = datetime.fromisoformat(game_utc_str.replace("Z", "+00:00"))
                    if now_utc >= game_utc:
                        should_have_started = True
                        break
                except Exception:
                    pass
        if should_have_started:
            schedule = _get_mlb_schedule(today_str, force_refresh=True, level=level)
            if schedule and any(g.get("status") not in not_started for g in schedule):
                return today_str
    # No games started today (or no games at all) — show yesterday
    return yesterday_str

def get_games(date_str, level=DEFAULT_LEVEL):
    df = fetch_date(date_str, level=level)  # This now includes MLB API fallback data
    data_pks = set(df["game_pk"].unique()) if not df.empty else set()

    # Try MLB Stats API for full game list
    mlb_games = _get_mlb_schedule(date_str, level=level)
    if mlb_games:
        for g in mlb_games:
            g["has_data"] = g["game_pk"] in data_pks
        # Sort by game start time (UTC ISO string sorts correctly)
        return sorted(mlb_games, key=lambda g: g.get("game_date_utc", "") or "9999")

    # Fallback to Savant-only if MLB API fails
    if df.empty: return []
    games = []
    for game_pk, gdf in df.groupby("game_pk"):
        home = gdf["home_team"].iloc[0]
        away = gdf["away_team"].iloc[0]
        games.append({"game_pk": int(game_pk), "label": f"{away} @ {home}", "home_team": home, "away_team": away, "has_data": True,
                       "status": "", "abstract_state": "", "game_time_et": "", "game_date_utc": "",
                       "away_sp": "", "home_sp": "", "home_score": None, "away_score": None,
                       "current_inning": 0, "inning_half": ""})
    return sorted(games, key=lambda g: g.get("game_date_utc", "") or "9999")

_boxscore_cache = {}  # { game_pk: (timestamp, stats_map) }
_game_state_cache = {}  # { game_pk: { home_score, away_score, inning, inning_half, status } }
BOXSCORE_LIVE_TTL = 60  # seconds — refetch live game boxscores after this

def _get_boxscore_stats(game_pk):
    """Fetch pitching stats per pitcher from MLB Stats API boxscore.
    Returns dict: { pitcher_id: { 'er': int, 'runs': int, 'ip': str, 'hits': int, 'bbs': int, 'ks': int, 'hrs': int, 'batters_faced': int } }
    Live games use a 60s TTL; final games cache forever."""
    if game_pk in _boxscore_cache:
        ts, cached_stats = _boxscore_cache[game_pk]
        # Check if game is final (game_state "F" = final)
        gs = _game_state_cache.get(game_pk, {})
        is_final = gs.get("game_state", "") == "F"
        if is_final or (time.time() - ts) < BOXSCORE_LIVE_TTL:
            return cached_stats
        # Live game with stale cache — refetch below
    # L2: Redis (check game state to decide if we should use it)
    redis_val = redis_get(f"boxscore:{game_pk}")
    if redis_val is not None:
        converted = {int(k): v for k, v in redis_val.items()}
        # Also restore game state from Redis
        gs_val = redis_get(f"gamestate:{game_pk}")
        if gs_val is not None:
            _game_state_cache[game_pk] = gs_val
        # If game is final in Redis, cache forever
        is_final = (gs_val or {}).get("game_state", "") == "F"
        _boxscore_cache[game_pk] = (time.time(), converted)
        if is_final:
            return converted
        # Live game — only use Redis if no in-memory was available (first load)
        # On subsequent calls the TTL check above will handle refetching
        return converted
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
                runs = stats.get("runs")
                ip = stats.get("inningsPitched")
                hits = stats.get("hits")
                bbs = stats.get("baseOnBalls")
                ks = stats.get("strikeOuts")
                hrs = stats.get("homeRuns")
                bf = stats.get("battersFaced")
                gs = stats.get("gamesStarted")
                note = stats.get("note", "")
                if er is not None or ip is not None:
                    # Parse decision from note, e.g. "(W, 1-0)" -> "W"
                    decision = ""
                    if note:
                        import re as _re
                        dm = _re.match(r"\(([WLS])", note)
                        if dm:
                            decision = dm.group(1)
                    stats_map[pid] = {
                        "er": er if er is not None else 0,
                        "runs": runs if runs is not None else 0,
                        "ip": ip,
                        "hits": hits if hits is not None else 0,
                        "bbs": bbs if bbs is not None else 0,
                        "ks": ks if ks is not None else 0,
                        "hrs": hrs if hrs is not None else 0,
                        "batters_faced": bf if bf is not None else 0,
                        "games_started": gs if gs is not None else 0,
                        "decision": decision,
                    }
        # Extract game state (scores, inning, status) from linescore
        linescore = data.get("liveData", {}).get("linescore", {})
        game_status = data.get("gameData", {}).get("status", {})
        detailed_state = game_status.get("detailedState", "")
        abstract_state = game_status.get("abstractGameState", "")
        home_score = linescore.get("teams", {}).get("home", {}).get("runs", 0)
        away_score = linescore.get("teams", {}).get("away", {}).get("runs", 0)
        current_inning = linescore.get("currentInning", 0)
        inning_half = linescore.get("inningHalf", "")  # "Top" or "Bottom"
        # Build game state string: F (Final), T7 (Top 7), B3 (Bottom 3)
        if abstract_state == "Final" or "Final" in detailed_state:
            game_state_str = "F"
        elif inning_half and current_inning:
            game_state_str = ("T" if inning_half == "Top" else "B") + str(current_inning)
        else:
            game_state_str = ""
        gs_data = {
            "home_score": home_score if home_score is not None else 0,
            "away_score": away_score if away_score is not None else 0,
            "game_state": game_state_str,
        }
        _game_state_cache[game_pk] = gs_data
        redis_set(f"gamestate:{game_pk}", gs_data)
        _boxscore_cache[game_pk] = (time.time(), stats_map)
        # Store in Redis with string keys (JSON requirement)
        # Only persist to Redis if game is final
        if gs_data.get("game_state") == "F":
            redis_set(f"boxscore:{game_pk}", {str(k): v for k, v in stats_map.items()})
            redis_set(f"gamestate:{game_pk}", gs_data)
        return stats_map
    except Exception as e:
        print(f"Error fetching boxscore for game {game_pk}: {e}")
        _boxscore_cache[game_pk] = (time.time(), {})
        return {}

def get_game_state(game_pk):
    """Return game state dict: { home_score, away_score, game_state }."""
    if game_pk not in _game_state_cache:
        # Trigger boxscore fetch which populates game state cache
        _get_boxscore_stats(game_pk)
    return _game_state_cache.get(game_pk, {})

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

_feed_cache = {}  # { game_pk: (timestamp, full_json) }
FEED_LIVE_TTL = 60  # seconds — refetch live game feeds after this

def _is_game_final(feed_json):
    """Check if a game feed indicates the game is over."""
    if not feed_json:
        return False
    status = feed_json.get("gameData", {}).get("status", {})
    abstract = status.get("abstractGameState", "")
    detailed = status.get("detailedState", "")
    return abstract == "Final" or "Final" in detailed

def _get_game_feed(game_pk):
    """Fetch and cache the full MLB Stats API game feed.
    Live games use a 60s TTL; final games cache forever."""
    if game_pk in _feed_cache:
        ts, data = _feed_cache[game_pk]
        if _is_game_final(data) or (time.time() - ts) < FEED_LIVE_TTL:
            return data
        # Live game with stale cache — refetch below
    # L2: Redis (only stores completed game feeds)
    redis_val = redis_get(f"feed:{game_pk}")
    if redis_val is not None:
        _feed_cache[game_pk] = (time.time(), redis_val)
        return redis_val
    try:
        url = MLB_GAME_FEED_URL.format(game_pk=game_pk)
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        _feed_cache[game_pk] = (time.time(), data)
        # Only persist to Redis if game is final
        if _is_game_final(data):
            redis_set(f"feed:{game_pk}", data)
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

        # Annotate WP/PB-caused runner movements on every PA, and also ensure
        # walk/HBP PAs list all base movements.
        _evt_lower = (result_event or "").lower().replace(" ", "_")
        result_desc = _enrich_pa_description(
            result_desc,
            pa.get("runners"),
            include_plain=_evt_lower in ("walk", "intentional_walk", "hit_by_pitch"),
            play_events=pa.get("playEvents"),
        )

        result_rbi = result.get("rbi", 0)
        result_home_score = result.get("homeScore")
        result_away_score = result.get("awayScore")

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

        # Build pitch list (including non-pitch events like pickoffs, stolen bases)
        all_play_events = pa.get("playEvents", [])
        pitches = []
        balls = 0
        strikes = 0
        pitch_num = 0
        # Pre-compute last pitch index
        last_pitch_idx = max((i for i, e in enumerate(all_play_events) if e.get("isPitch")), default=-1)
        for eidx, ev in enumerate(all_play_events):
            det = ev.get("details", {})
            if ev.get("isPitch"):
                pitch_num += 1
                is_last_p = (eidx == last_pitch_idx)
                pd_ = ev.get("pitchData", {})
                pitch_type_code = det.get("type", {}).get("code", "")
                pitch_type_name = PITCH_TYPE_MAP.get(pitch_type_code, pitch_type_code)
                speed = pd_.get("startSpeed")
                desc = det.get("description", "")
                # Normalize: foul tip and swinging strike (blocked) → Swinging Strike
                if desc in ("Foul Tip", "Swinging Strike (Blocked)"):
                    desc = "Swinging Strike"
                code = det.get("code", "")
                p_coords = pd_.get("coordinates", {})
                p_breaks = pd_.get("breaks", {})

                count_str = f"{balls}-{strikes}"

                pitches.append({
                    "num": pitch_num,
                    "type": pitch_type_name,
                    "type_code": pitch_type_code,
                    "speed": round(speed, 1) if speed else None,
                    "desc": desc,
                    "count": count_str,
                    # Location & break for strikezone + hover
                    "plate_x": p_coords.get("pX"),
                    "plate_z": p_coords.get("pZ"),
                    "pfx_x": round(-p_breaks.get("breakHorizontal", 0), 1) if p_breaks.get("breakHorizontal") is not None else None,
                    "pfx_z": round(p_breaks.get("breakVerticalInduced", 0), 1) if p_breaks.get("breakVerticalInduced") is not None else None,
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
            else:
                # Non-pitch event: pickoff, stolen base, balk, wild pitch, etc.
                event_type = det.get("eventType", "") or det.get("event", "") or ""
                desc = det.get("description", "")
                if not desc and not event_type:
                    continue
                # Determine if a run scored on this action
                runner_events = ev.get("runners", [])
                action_scored = any(
                    r.get("movement", {}).get("end") == "score"
                    for r in runner_events
                ) if runner_events else False
                # Determine if it was an error
                action_is_error = any(
                    r.get("details", {}).get("isScoringEvent") and "error" in (r.get("details", {}).get("event", "") or "").lower()
                    for r in runner_events
                ) if runner_events else ("error" in desc.lower())
                pitches.append({
                    "is_action": True,
                    "event_type": event_type,
                    "desc": desc,
                    "scored": action_scored,
                    "is_error": action_is_error,
                    "count": f"{balls}-{strikes}",
                })

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
            "home_score": result_home_score,
            "away_score": result_away_score,
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

    # Game status
    game_status = game_data.get("status", {}).get("detailedState", "")
    is_final = game_status in ("Final", "Game Over", "Completed Early")

    return {
        "away_team": away_abbrev,
        "home_team": home_abbrev,
        "innings": innings,
        "totals": totals,
        "plays": plays,
        "pitcher_exit": pitcher_exit,
        "is_final": is_final,
    }
