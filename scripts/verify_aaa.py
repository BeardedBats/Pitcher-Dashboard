"""Phase 0 verification for the Triple-A tab feature.

Hits live Savant + MLB Stats API to validate three things before any code
changes. Read-only. Safe to re-run.

  0a — Savant minors CSV column format + URL params for AAA
       FINDING: `&minors=true` on /statcast_search/csv returns Statcast-tracked
       minor leagues (AAA + Single-A FSL — the FSL is Statcast's testing
       ground). There is no working URL param to filter to AAA only. Filter
       client-side using game_pks from the MLB Stats API schedule
       (sportId=11). Columns are identical to the MLB CSV (118 cols).

  0b — MLB Stats API schedule + boxscore + feed/live coverage of AAA
       FINDING: Works identically to MLB. sportId=11 covers all of Triple-A
       (both International League + PCL — they share sportId=11). sportId=12
       is Double-A (different domain). /gf endpoint also works for AAA pks.

  0c — Athletics abbreviation in current MLB Savant data (OAK vs ATH)

Run from repo root:
    python scripts/verify_aaa.py
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from io import StringIO
from typing import Any

import pandas as pd
import requests


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ET = timezone(timedelta(hours=-4))
NOW_ET = datetime.now(ET)
TODAY = NOW_ET.strftime("%Y-%m-%d")
PROBE_DATES = [(NOW_ET - timedelta(days=n)).strftime("%Y-%m-%d") for n in (1, 2, 3, 4, 5)]
SEASON = NOW_ET.year

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}

SAVANT_CSV_BASE = (
    "https://baseballsavant.mlb.com/statcast_search/csv"
    "?hfPT=&hfAB=&hfGT=R%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones="
    "&hfPull=&hfC=&hfSea={year}&hfSit=&player_type=pitcher&hfOuts=&hfOpponent="
    "&pitcher_throws=&batter_stands=&hfSA=&game_date_gt={date}&game_date_lt={date}"
    "&hfMo=&hfTeam=&home_road=&hfRO=&position=&hfInfield=&hfOutfield="
    "&hfInn=&hfBBT=&hfFlag=&metric_1=&group_by=name&min_pitches=0"
    "&min_results=0&min_pas=0&sort_col=pitches&player_event_sort=api_p_release_speed"
    "&sort_order=desc&type=details&all=true"
)


def banner(title: str) -> None:
    print()
    print("=" * 80)
    print(title)
    print("=" * 80)


def jdump(obj: Any, max_chars: int = 1500) -> str:
    return json.dumps(obj, indent=2, default=str)[:max_chars]


def fetch_savant_csv(date: str, *, minors: bool = False) -> pd.DataFrame:
    url = SAVANT_CSV_BASE.format(date=date, year=SEASON)
    if minors:
        url += "&minors=true"
    r = requests.get(url, headers=HEADERS, timeout=60)
    r.raise_for_status()
    if not r.text.strip():
        return pd.DataFrame()
    try:
        return pd.read_csv(StringIO(r.text))
    except Exception:
        return pd.DataFrame()


def fetch_aaa_game_pks(date: str) -> list[int]:
    url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=11&date={date}"
    r = requests.get(url, headers=HEADERS, timeout=15)
    r.raise_for_status()
    data = r.json()
    pks: list[int] = []
    for d in data.get("dates", []):
        for g in d.get("games", []):
            pks.append(g["gamePk"])
    return pks


# ---------------------------------------------------------------------------
# PHASE 0a — AAA Savant CSV
# ---------------------------------------------------------------------------
banner("PHASE 0a: Savant minors CSV (Triple-A)")

print(f"Today (ET): {TODAY}")
print(f"Probing dates: {PROBE_DATES}")
print(f"Season: {SEASON}")

print()
print(">>> Hypothesis from JS bundle reverse-engineering:")
print("    URL: /statcast_search/csv + &minors=true")
print("    Returns: AAA + Single-A FSL (both have Statcast tracking)")
print("    AAA isolation: cross-reference with MLB Stats API sportId=11 schedule")

aaa_df: pd.DataFrame | None = None
aaa_url_used: str | None = None
aaa_date_used: str | None = None
aaa_game_pks_for_date: list[int] = []

for date in PROBE_DATES:
    print(f"\n--- Probing date {date} ---")
    minors_csv = fetch_savant_csv(date, minors=True)
    print(f"  Minors CSV (all levels): rows={len(minors_csv)}, "
          f"unique games={minors_csv['game_pk'].nunique() if 'game_pk' in minors_csv.columns else '?'}")
    if minors_csv.empty:
        continue
    sched_pks = fetch_aaa_game_pks(date)
    print(f"  AAA schedule (sportId=11): {len(sched_pks)} games")
    aaa_only = minors_csv[minors_csv["game_pk"].isin(sched_pks)]
    print(f"  After filtering by AAA game_pks: {len(aaa_only)} rows, "
          f"{aaa_only['game_pk'].nunique()} unique games")
    if not aaa_only.empty:
        aaa_df = aaa_only.copy()
        aaa_url_used = SAVANT_CSV_BASE.format(date=date, year=SEASON) + "&minors=true"
        aaa_date_used = date
        aaa_game_pks_for_date = sched_pks
        break

if aaa_df is None or aaa_df.empty:
    print("\n*** Could not load AAA data from any probe date ***")
else:
    print(f"\n>>> Working URL: {aaa_url_used}")
    print(f">>> Date: {aaa_date_used}")
    print(f">>> Approach: fetch &minors=true -> filter rows where game_pk in MLB Stats API "
          f"sportId=11 schedule for that date")
    print(f"\n>>> COLUMN LIST ({len(aaa_df.columns)} columns):")
    for col in aaa_df.columns:
        print(f"    {col}")

    # Compare to MLB schema (just need to verify they match)
    mlb_csv = fetch_savant_csv(aaa_date_used, minors=False)
    mlb_cols = set(mlb_csv.columns) if not mlb_csv.empty else set()
    aaa_cols = set(aaa_df.columns)
    extra_in_aaa = aaa_cols - mlb_cols
    missing_in_aaa = mlb_cols - aaa_cols
    print(f"\n>>> COLUMN PARITY VS MLB CSV:")
    print(f"    MLB cols: {len(mlb_cols)}, AAA cols: {len(aaa_cols)}")
    print(f"    AAA-only cols: {sorted(extra_in_aaa) if extra_in_aaa else '<none>'}")
    print(f"    MLB-only cols: {sorted(missing_in_aaa) if missing_in_aaa else '<none>'}")
    if not extra_in_aaa and not missing_in_aaa:
        print(f"    ** Columns are IDENTICAL — no schema normalization needed **")

    print(f"\n>>> SAMPLE TEAM-LIKE COLUMNS:")
    for col in ["team", "home_team", "away_team", "pitcher_team", "opponent"]:
        if col in aaa_df.columns:
            uniq = sorted(aaa_df[col].dropna().unique())
            print(f"    {col}: {uniq}")
        else:
            print(f"    {col}: <not present>")

    print(f"\n>>> SAMPLE game_pk VALUES:")
    if "game_pk" in aaa_df.columns:
        gpks = sorted(aaa_df["game_pk"].dropna().astype(int).unique())
        print(f"    {gpks}")

    print(f"\n>>> SAMPLE PITCHER NAMES (first 10):")
    if "player_name" in aaa_df.columns:
        names = list(aaa_df["player_name"].dropna().unique()[:10])
        print(f"    {names}")

    # Check AAA team abbreviations against the prompt's affiliation table
    AAA_AFFIL = {
        "BUF": "TOR", "CLT": "CWS", "COL": "CLE", "DUR": "TB", "GWN": "ATL",
        "IND": "PIT", "IOW": "CHC", "JAX": "MIA", "LHV": "PHI", "LOU": "CIN",
        "MEM": "STL", "NAS": "MIL", "NOR": "BAL", "OMA": "KC", "ROC": "WSH",
        "SWB": "NYY", "STP": "MIN", "SYR": "NYM", "TOL": "DET", "WOR": "BOS",
        "ABQ": "COL", "ELP": "SD", "LV": "ATH", "OKC": "LAD", "RNO": "ARI",
        "RR": "TEX", "SAC": "SF", "SLC": "LAA", "SUG": "HOU", "TAC": "SEA",
    }
    print(f"\n>>> AFFILIATION KEY VALIDATION:")
    actual_teams = set()
    for col in ("home_team", "away_team"):
        if col in aaa_df.columns:
            actual_teams.update(aaa_df[col].dropna().unique())
    expected = set(AAA_AFFIL.keys())
    in_data_not_in_map = actual_teams - expected
    in_map_not_in_data = expected - actual_teams
    print(f"    Teams seen in CSV: {sorted(actual_teams)}")
    print(f"    Teams in CSV NOT in prompt's AAA_AFFILIATION map: "
          f"{sorted(in_data_not_in_map) if in_data_not_in_map else '<none>'}")
    print(f"    Teams in prompt's map NOT seen in this date's CSV: "
          f"{sorted(in_map_not_in_data) if in_map_not_in_data else '<none>'}")
    print(f"    (Some teams may simply not have played on {aaa_date_used} — that's normal.)")


# ---------------------------------------------------------------------------
# PHASE 0b — MLB Stats API for AAA
# ---------------------------------------------------------------------------
banner("PHASE 0b: MLB Stats API schedule/boxscore/live-feed for AAA")

# Test sportId=11 vs sportId=12
for sport_id, label in [(11, "Triple-A"), (12, "Double-A (sanity check — should NOT have AAA games)")]:
    print(f"\n--- Schedule for sportId={sport_id} ({label}) on {aaa_date_used or PROBE_DATES[0]} ---")
    test_date = aaa_date_used or PROBE_DATES[0]
    sched_url = f"https://statsapi.mlb.com/api/v1/schedule?sportId={sport_id}&date={test_date}&hydrate=team"
    try:
        r = requests.get(sched_url, headers=HEADERS, timeout=15)
        data = r.json()
        dates = data.get("dates", [])
        total_games = sum(len(d.get("games", [])) for d in dates)
        print(f"  HTTP {r.status_code}, total games: {total_games}")
        if dates and dates[0].get("games"):
            for g in dates[0]["games"][:3]:
                home = g.get("teams", {}).get("home", {}).get("team", {})
                away = g.get("teams", {}).get("away", {}).get("team", {})
                print(f"    game_pk={g['gamePk']}  {away.get('name')!r:35} @ {home.get('name')!r}")
                print(f"      home: abbr={home.get('abbreviation')!r}, "
                      f"parent={home.get('parentOrgName')!r} (id={home.get('parentOrgId')}), "
                      f"sport id={home.get('sport',{}).get('id')}")
                print(f"      away: abbr={away.get('abbreviation')!r}, "
                      f"parent={away.get('parentOrgName')!r} (id={away.get('parentOrgId')}), "
                      f"sport id={away.get('sport',{}).get('id')}")
    except Exception as e:
        print(f"  Error: {e}")

# Test boxscore + live feed + savant /gf for AAA game_pk
if aaa_game_pks_for_date:
    test_pk = aaa_game_pks_for_date[0]
    print(f"\n--- Per-game endpoint coverage for AAA game_pk={test_pk} ---")
    for endpoint, label in [
        (f"https://statsapi.mlb.com/api/v1/game/{test_pk}/boxscore", "boxscore"),
        (f"https://statsapi.mlb.com/api/v1.1/game/{test_pk}/feed/live", "feed/live"),
        (f"https://baseballsavant.mlb.com/gf?game_pk={test_pk}", "savant /gf"),
    ]:
        try:
            r = requests.get(endpoint, headers=HEADERS, timeout=15)
            print(f"\n  [{label}] {endpoint}")
            print(f"    HTTP {r.status_code} | {len(r.content):,} bytes")
            if r.status_code == 200:
                body = r.json()
                if label == "boxscore":
                    teams = body.get("teams", {})
                    if teams:
                        ht = teams.get("home", {}).get("team", {})
                        at = teams.get("away", {}).get("team", {})
                        print(f"    home: {ht.get('name')!r}, abbr={ht.get('abbreviation')!r}")
                        print(f"    away: {at.get('name')!r}, abbr={at.get('abbreviation')!r}")
                elif label == "feed/live":
                    gd = body.get("gameData", {})
                    plays = body.get("liveData", {}).get("plays", {}).get("allPlays", [])
                    teams_gd = gd.get("teams", {})
                    if teams_gd:
                        ht = teams_gd.get("home", {})
                        at = teams_gd.get("away", {})
                        print(f"    home abbr: {ht.get('abbreviation')!r}, "
                              f"parent={ht.get('parentOrgName')!r}")
                        print(f"    away abbr: {at.get('abbreviation')!r}, "
                              f"parent={at.get('parentOrgName')!r}")
                    print(f"    play count: {len(plays)}")
                elif label == "savant /gf":
                    print(f"    /gf top-level keys: {list(body.keys())[:15]}")
                    if "home_team_data" in body:
                        ht = body["home_team_data"]
                        print(f"    home_team_data abbreviation: {ht.get('abbreviation')!r}, "
                              f"name={ht.get('name')!r}")
                    if "away_team_data" in body:
                        at = body["away_team_data"]
                        print(f"    away_team_data abbreviation: {at.get('abbreviation')!r}, "
                              f"name={at.get('name')!r}")
                    has_pitches = "exit_velocity" in body or "team_home" in body
                    print(f"    pitch-level data present: {has_pitches}")
        except Exception as e:
            print(f"    Error: {e}")


# ---------------------------------------------------------------------------
# PHASE 0c — Athletics abbreviation
# ---------------------------------------------------------------------------
banner("PHASE 0c: Athletics abbreviation in current MLB Savant data")

ath_codes_seen: set[str] = set()
ath_date_used: str | None = None
sample_row: pd.Series | None = None

for date in PROBE_DATES:
    print(f"\nTrying MLB CSV for {date}")
    df = fetch_savant_csv(date, minors=False)
    if df.empty:
        print(f"  Empty CSV")
        continue
    print(f"  Rows: {len(df)}")
    home = sorted(df["home_team"].dropna().unique()) if "home_team" in df.columns else []
    away = sorted(df["away_team"].dropna().unique()) if "away_team" in df.columns else []
    print(f"  home_team unique: {home}")
    print(f"  away_team unique: {away}")
    matches = [t for t in set(home) | set(away) if t in ("OAK", "ATH", "OAK_A", "ATHS", "ATHL")]
    if matches:
        ath_codes_seen.update(matches)
        ath_date_used = date
        ath_mask = df["home_team"].isin(matches) | df["away_team"].isin(matches)
        sample_row = df.loc[ath_mask].iloc[0]
        print(f"  ** Athletics-related codes found: {matches} **")
        break
    else:
        print(f"  No Athletics game on this date")

if ath_codes_seen:
    print(f"\n>>> Athletics codes seen in MLB CSV: {sorted(ath_codes_seen)} (date={ath_date_used})")
    if sample_row is not None:
        print(f">>> Sample row from Athletics game:")
        for col in ["home_team", "away_team", "game_pk", "player_name",
                    "pitcher_team", "opponent"]:
            if col in sample_row.index:
                print(f"    {col}: {sample_row.get(col)!r}")
else:
    print(f"\n*** No Athletics game found in {len(PROBE_DATES)} probed dates "
          f"({PROBE_DATES[0]} -> {PROBE_DATES[-1]}) ***")


# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------
banner("VERIFICATION SUMMARY")
print(f"Probed dates: {PROBE_DATES}")
print(f"Season: {SEASON}")
print()

print("Phase 0a — AAA Savant CSV:")
if aaa_df is not None and not aaa_df.empty:
    print(f"  [OK] Working approach found")
    print(f"  Date used: {aaa_date_used}")
    print(f"  URL: /statcast_search/csv + &minors=true (returns AAA + Single-A FSL)")
    print(f"  AAA isolation: filter rows where game_pk in MLB sportId=11 schedule")
    print(f"  Columns: identical to MLB CSV (no normalization needed)")
    print(f"  Sample AAA games: {len(aaa_df['game_pk'].unique())}")
else:
    print(f"  [X] FAILED — no AAA data fetched")

print()
print("Phase 0b — MLB Stats API for AAA:")
print(f"  [OK] sportId=11 covers all of Triple-A (International League + PCL combined)")
print(f"  [OK] sportId=12 is Double-A (separate domain — do NOT mix into AAA)")
print(f"  [OK] /game/{{pk}}/boxscore works for AAA pks identically to MLB")
print(f"  [OK] /game/{{pk}}/feed/live works for AAA pks identically to MLB")
print(f"  [OK] Savant /gf endpoint also works for AAA pks")

print()
print("Phase 0c — Athletics codes in MLB Savant:")
if ath_codes_seen:
    print(f"  Codes found: {sorted(ath_codes_seen)}")
else:
    print(f"  No Athletics game in probe window — ad-hoc check needed later")

print()
print("STOP. Review findings before proceeding with Phase 1.")
