#!/usr/bin/env python3
"""
Bulk cache warmup — run locally to backfill Redis cache.

Fetches Savant data for each date, computes pitcher cards and player pages,
and writes them to Redis. No Vercel timeout limits since this runs locally.

Usage:
    python bulk_warmup.py                    # MLB (default)
    python bulk_warmup.py --level aaa        # Triple-A
    python bulk_warmup.py --start 2026-04-01 --end 2026-04-15

Requires Pitcher_Dash_KV_REST_API_URL and Pitcher_Dash_KV_REST_API_TOKEN
environment variables to be set (same as cache_monitor.py).
"""

import argparse
import os
import sys
import time
from datetime import datetime, timedelta

# Add backend dir to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(SCRIPT_DIR, "backend")
sys.path.insert(0, BACKEND_DIR)

# ── Config defaults ────────────────────────────────────────────────────
DEFAULT_START_DATE = "2026-03-26"
DEFAULT_END_DATE = "2026-04-12"
SEASON_START = "2026-03-25"

# ── Imports from the backend ────────────────────────────────────────────
from data import (
    fetch_date, fetch_date_range, get_override_version,
    get_agg_cache, set_agg_cache,
    CARD_SCHEMA_VERSION, LEVELS, DEFAULT_LEVEL,
    is_custom_season_range,
)
from aggregation import get_pitcher_card, get_pitcher_game_log


def daterange(start, end):
    """Yield date strings YYYY-MM-DD from start through end inclusive."""
    s = datetime.strptime(start, "%Y-%m-%d")
    e = datetime.strptime(end, "%Y-%m-%d")
    while s <= e:
        yield s.strftime("%Y-%m-%d")
        s += timedelta(days=1)


def compute_season_totals(pitcher_id, start_date, end_date, df, level):
    """Compute and cache season totals for a pitcher from pre-loaded DataFrame.
    Cache key matches app.py's _compute_season_totals so the warm entries are
    actually hit at request time."""
    suffix = "_custom" if is_custom_season_range(start_date, end_date) else ""
    agg_key = f"season_totals_{level}_{pitcher_id}_s{CARD_SCHEMA_VERSION}{suffix}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached

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
        "wins": sum(1 for g in game_log if g.get("decision") == "W"),
        "losses": sum(1 for g in game_log if g.get("decision") == "L"),
    }
    set_agg_cache(agg_key, result)
    return result


def main():
    parser = argparse.ArgumentParser(description="Bulk warmup pitcher cards + player pages.")
    parser.add_argument("--level", choices=list(LEVELS), default=DEFAULT_LEVEL,
                        help="Data level: mlb (default) or aaa.")
    parser.add_argument("--start", default=DEFAULT_START_DATE, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", default=DEFAULT_END_DATE, help="End date YYYY-MM-DD")
    parser.add_argument("--season-start", default=SEASON_START,
                        help="Season-to-date start used for season-totals cache keys.")
    args = parser.parse_args()

    level = args.level
    start_date = args.start
    end_date = args.end
    season_start = args.season_start

    print("=" * 70)
    print(f"BULK WARMUP — level={level} — {start_date} through {end_date}")
    print("=" * 70)

    # Verify Redis connection
    url = (os.environ.get("Pitcher_Dash_KV_REST_API_URL")
           or os.environ.get("UPSTASH_REDIS_REST_URL")
           or os.environ.get("KV_REST_API_URL"))
    if not url:
        print("\n*** Redis env vars not set. Cannot write to cache. ***")
        print("Set Pitcher_Dash_KV_REST_API_URL and Pitcher_Dash_KV_REST_API_TOKEN first.")
        return

    override_ver = get_override_version()
    print(f"\nOverride version: {override_ver}")
    print(f"Card key format: agg:card_{level}_{{date}}_{{pid}}_{{gpk}}_v{override_ver}_s{CARD_SCHEMA_VERSION}")

    dates = list(daterange(start_date, end_date))
    print(f"Dates to process: {len(dates)}")

    # ── Phase 1: Fetch full season DataFrame (used for game logs + season totals) ──
    print(f"\n{'='*70}")
    print(f"PHASE 1: Fetching full season data ({season_start} to {end_date}) — level={level}")
    print(f"{'='*70}")
    t0 = time.time()
    season_df = fetch_date_range(season_start, end_date, level=level)
    if season_df.empty:
        print("*** No season data! Cannot proceed. ***")
        return
    print(f"  Season data: {len(season_df)} pitches in {time.time()-t0:.1f}s")

    all_pitcher_ids = sorted(season_df["pitcher"].dropna().unique().astype(int))
    print(f"  Unique pitchers in season: {len(all_pitcher_ids)}")

    # ── Phase 2: Compute pitcher cards for each date ──
    print(f"\n{'='*70}")
    print(f"PHASE 2: Computing pitcher cards for {len(dates)} dates...")
    print(f"{'='*70}")

    total_cards = 0
    total_skipped = 0
    total_errors = 0

    for date in dates:
        t1 = time.time()
        day_df = fetch_date(date, level=level)
        if day_df.empty:
            print(f"  {date}: no data (off day?)")
            continue

        combos = day_df.groupby(["pitcher", "game_pk"]).size().reset_index()[["pitcher", "game_pk"]]
        day_cards = 0
        day_skipped = 0

        for _, row in combos.iterrows():
            pid, gpk = int(row["pitcher"]), int(row["game_pk"])
            agg_key = f"card_{level}_{date}_{pid}_{gpk}_v{override_ver}_s{CARD_SCHEMA_VERSION}"

            if get_agg_cache(agg_key) is not None:
                day_skipped += 1
                continue

            try:
                card = get_pitcher_card(date, pid, gpk, level=level)
                if card:
                    if "season_totals" not in card:
                        card["season_totals"] = compute_season_totals(
                            pid, season_start, end_date, season_df, level
                        )
                    set_agg_cache(agg_key, card)
                    day_cards += 1
            except Exception as e:
                print(f"    ERROR: {date} pid={pid} gpk={gpk}: {e}")
                total_errors += 1

        elapsed = time.time() - t1
        total_cards += day_cards
        total_skipped += day_skipped
        print(f"  {date}: {day_cards} cards cached, {day_skipped} already cached ({elapsed:.1f}s)")

    print(f"\n  TOTAL: {total_cards} cards cached, {total_skipped} skipped, {total_errors} errors")

    # ── Phase 3: Compute player pages (game logs) for all pitchers ──
    print(f"\n{'='*70}")
    print(f"PHASE 3: Computing player pages (game logs) for {len(all_pitcher_ids)} pitchers...")
    print(f"{'='*70}")

    pages_cached = 0
    pages_skipped = 0
    pages_errors = 0
    t2 = time.time()
    page_suffix = "_custom" if is_custom_season_range(season_start, end_date) else ""

    for i, pid in enumerate(all_pitcher_ids):
        agg_key = f"player_v2_{level}_{pid}_s{CARD_SCHEMA_VERSION}{page_suffix}"
        if get_agg_cache(agg_key) is not None:
            pages_skipped += 1
            continue

        try:
            game_log = get_pitcher_game_log(season_df, pid)
            if game_log:
                result = {
                    "pitcher_id": pid,
                    "game_log": game_log,
                    "start_date": season_start,
                    "end_date": end_date,
                }
                set_agg_cache(agg_key, result)
                pages_cached += 1
        except Exception as e:
            print(f"    ERROR: pid={pid}: {e}")
            pages_errors += 1

        if (i + 1) % 50 == 0:
            print(f"  ... {i+1}/{len(all_pitcher_ids)} pitchers processed")

    elapsed3 = time.time() - t2
    print(f"\n  TOTAL: {pages_cached} pages cached, {pages_skipped} skipped, {pages_errors} errors ({elapsed3:.1f}s)")

    # ── Phase 4: Season totals for all pitchers ──
    print(f"\n{'='*70}")
    print(f"PHASE 4: Computing season totals for {len(all_pitcher_ids)} pitchers...")
    print(f"{'='*70}")

    totals_cached = 0
    totals_skipped = 0
    t3 = time.time()
    st_suffix = "_custom" if is_custom_season_range(season_start, end_date) else ""

    for pid in all_pitcher_ids:
        st_key = f"season_totals_{level}_{pid}_s{CARD_SCHEMA_VERSION}{st_suffix}"
        if get_agg_cache(st_key) is not None:
            totals_skipped += 1
            continue
        result = compute_season_totals(pid, season_start, end_date, season_df, level)
        if result:
            totals_cached += 1

    elapsed4 = time.time() - t3
    print(f"  TOTAL: {totals_cached} cached, {totals_skipped} skipped ({elapsed4:.1f}s)")

    # ── Summary ──
    total_elapsed = time.time() - t0
    print(f"\n{'='*70}")
    print(f"WARMUP COMPLETE — level={level} — {total_elapsed:.0f}s total")
    print(f"{'='*70}")
    print(f"  Cards:         {total_cards} cached")
    print(f"  Player pages:  {pages_cached} cached")
    print(f"  Season totals: {totals_cached} cached")
    print(f"  Errors:        {total_errors + pages_errors}")
    print(f"\nRun 'python cache_monitor.py' to verify Redis state.")


if __name__ == "__main__":
    main()
