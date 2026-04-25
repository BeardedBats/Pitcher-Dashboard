# Baseball Dashboard — Architecture

> **Purpose of this doc:** Tech stack, directory layout, deployment topology, build/dev commands. Read this before touching infra or adding a new surface (new page, new cron job, new deploy target).

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Frontend | React 18 (Create React App), Vite where noted | Port 3847 in dev. `BROWSER=none` set in `frontend/.env` to prevent double browser windows |
| Backend | Python 3 + FastAPI | Data aggregation, caching, MLB/Savant integration |
| Desktop wrapper | Electron | Spawns backend on random port, injects via `window.__BACKEND_PORT__` |
| Cache L1 | Python in-memory dicts | Per-process (`_cache`, `_season_cache`, `_batter_name_cache`) |
| Cache L2 | Redis (Upstash) | Persistent, cross-process, TTL-configured |
| Data sources | Baseball Savant CSV, MLB Stats API, Savant `/gf` endpoint (live WebSocket-style) | |
| Deploy | Vercel (serverless Python runtime) | Also runs scheduled cron jobs |

## Directory tree (top-level)

```
baseball-dashboard/
├── backend/                      # FastAPI app
│   ├── app.py                    # All endpoints
│   ├── aggregation.py            # Pitch + results aggregation, card builder
│   ├── data.py                   # Fetching, caching, boxscore lookups, warmup
│   ├── redis_cache.py            # Upstash Redis wrapper
│   └── pitch_overrides.json      # Reclassification JSON fallback
│
├── frontend/                     # React app (CRA)
│   ├── src/
│   │   ├── components/           # All UI components (see 04-FRONTEND.md)
│   │   ├── utils/                # api.js, pitchFilters.js, formatting.js
│   │   ├── hooks/                # useIsMobile, etc.
│   │   ├── App.jsx               # Root component, holds global state
│   │   ├── constants.js          # PITCH_COLORS, column defs, team mappings
│   │   ├── styles.css            # All CSS (dark theme, tables, tooltips)
│   │   └── index.js              # Entry
│   ├── build/                    # Production output (deployed by Vercel)
│   ├── .env                      # BROWSER=none
│   └── package.json
│
├── api/
│   └── index.py                  # Vercel serverless entry — wraps backend app
│
├── electron/
│   ├── main.js                   # Main process: spawns Python backend
│   └── preload.js                # Injects __BACKEND_PORT__ into window
│
├── docs/claude-project/          # ← this directory (schema docs for Claude Projects)
│
├── vercel.json                   # Vercel config + cron schedule
├── CLAUDE.md                     # Project-specific Claude instructions
├── design.md                     # Design token source of truth
├── BUILD.md                      # Build instructions
├── MOBILE-PLAN.md                # Mobile responsiveness plan
├── VERCEL-MIGRATION.md           # Serverless deployment notes
│
├── bulk_warmup.py                # Local script: pre-populate Redis for a date range
├── cache_monitor.py              # Hourly cache health check
├── setup_scheduler.ps1           # Registers Windows Task Scheduler for cache_monitor
├── run_cache_monitor.bat         # Batch wrapper
│
└── requirements.txt              # Python deps (backend + api)
```

## Deployment

### Vercel

`vercel.json`:

```json
{
  "buildCommand": "cd frontend && npm install && npm run build",
  "outputDirectory": "frontend/build",
  "rewrites": [
    { "source": "/api/:path*", "destination": "/api/index.py" }
  ]
}
```

- All `/api/*` requests are rewritten to `api/index.py` (Vercel Python serverless function).
- Frontend build output served from `frontend/build`.
- Auto-deploy on push to `origin/main`.

### Vercel cron schedule (UTC)

Each cron handler accepts an optional `?level=mlb|aaa` query param (default `mlb`).
AAA crons are offset 5 minutes from their MLB siblings to stay under Vercel's
per-minute concurrency limit.

| Path | Schedule (cron) | Purpose |
|---|---|---|
| `/api/cron/warmup` | `0 0-4,17-23 * * *` | Off-season hourly warmup (MLB) |
| `/api/cron/warmup-daily` | `30 9 * * *` | 5:30 AM ET — MLB daily refresh + leaderboard |
| `/api/cron/warmup-daily-players` | `40 9 * * *` | 5:40 AM ET — MLB player pages for yesterday |
| `/api/cron/warmup-daily-cards` | `50 9 * * *` | 5:50 AM ET — MLB game feeds + season avgs + cards |
| `/api/cron/warmup-live-cards` | `*/10 16-23,0-5 * * *` | MLB live card refresh during game hours |
| `/api/cron/warmup-daily?level=aaa` | `35 9 * * *` | 5:35 AM ET — AAA daily refresh |
| `/api/cron/warmup-daily-players?level=aaa` | `45 9 * * *` | 5:45 AM ET — AAA player pages |
| `/api/cron/warmup-daily-cards?level=aaa` | `55 9 * * *` | 5:55 AM ET — AAA cards |
| `/api/cron/warmup-live-cards?level=aaa` | `5,15,25,35,45,55 16-23,0-5 * * *` | AAA live cards (offset 5 min) |

All cron endpoints validate a Vercel `Authorization` header to block external callers.

### Electron

`electron/main.js`:

1. Finds random free port
2. Spawns Python backend (`python -m uvicorn backend.app:app --port <port>`)
3. Injects `window.__BACKEND_PORT__ = <port>` via `preload.js`
4. Frontend API layer detects Electron (`window.__BACKEND_PORT__`) and uses `http://localhost:{port}` as API base
5. On window close, terminates backend process

### Local dev

```bash
# Backend
cd backend && uvicorn app:app --reload --port 8000

# Frontend (separate terminal)
cd frontend && npm start     # serves on port 3847
```

Frontend API base URL logic (`utils/api.js`):
- Electron: `http://localhost:${window.__BACKEND_PORT__}`
- Dev (`NODE_ENV === "development"`): `http://localhost:8000`
- Prod: `""` (same origin — Vercel rewrites handle routing)

## Scripts at repo root

| File | Purpose |
|---|---|
| `bulk_warmup.py` | Pre-compute pitcher cards + player pages for a date range. Useful for seeding Redis before Vercel cutover or after cache schema bump |
| `cache_monitor.py` | Hourly Redis health check: counts keys by prefix, reports cache hit rates, lists recently updated keys |
| `setup_scheduler.ps1` | Registers Windows Task Scheduler to run `cache_monitor.py` hourly at :07 |
| `run_cache_monitor.bat` | Batch wrapper around the monitor |
| `push-update.bat` / `push.bat` | Git push shortcuts |
| `start-dashboard.bat` / `Pitcher Dashboard.vbs` / `Baseball Dashboard Terminal.lnk` | Launch helpers |
| `build-mac.sh` / `build-win.bat` | Build Electron desktop artifacts |

## Cache busting version

`CARD_SCHEMA_VERSION` (currently `7`) in `backend/data.py`. Bump whenever the cached card/season-totals payload shape changes — the version is embedded in Redis keys, so a bump invalidates all cached payloads safely.

`v7` introduced level-prefixed cache keys for the Triple-A tab. Every aggregation Redis key now embeds `{level}` (`mlb` or `aaa`) right after the entity type — e.g. `agg:card_aaa_2026-04-23_607192_815236_v0_s7`. See [03-BACKEND-INTERNALS.md](03-BACKEND-INTERNALS.md#cache-keys-redis).

## Environment variables

| Var | Used for |
|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | L2 cache |
| Vercel's built-in `Authorization` header | Cron auth |

(Check `backend/redis_cache.py` for exact env lookup.)
