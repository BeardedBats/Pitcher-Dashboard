# Pitcher Dashboard

## Tech Stack
- Frontend: React 18 (Create React App), port 3847
- Backend: Python FastAPI
- Desktop: Electron wrapper
- Repo: BeardedBats/Pitcher-Dashboard

## Build & Verify
- Frontend build: `cd frontend && npx react-scripts build` (use 180s timeout — can be slow)
- Backend syntax check: `cd backend && python -c "import app"`
- Dev server: `BROWSER=none` is set in `frontend/.env` to prevent double browser windows

## Key Files

### Frontend Components
- `frontend/src/components/PitcherCard.jsx` — Main player card: Box Score table, pitch type metrics, strikezone plots, velocity trend, play-by-play. Receives `cardData`, `onReclassify`, `onPlayerClick` props.
- `frontend/src/components/VelocityTrendV2.jsx` — Single-lane velocity chart with interactive legend. `lockedType` state for click-to-lock pitch type highlighting. When locked, draws swim lane overlay (top/bottom lines, dotted avg line, right-side labels with anti-overlap). `activeHighlight = lockedType || highlightType`.
- `frontend/src/components/StrikeZonePlot.jsx` — Canvas strikezone with reclassify on click. Accepts `onReclassify` prop.
- `frontend/src/components/PlayByPlayModal.jsx` — Lightbox PBP view with tooltips.
- `frontend/src/components/PitchDataTable.jsx` — Pitch type metrics table with TOTALS row. Totals show "—" for Velo/Usage/IVB/IHB/Ext, percentages for Vs R/Vs L (overall hand split), and weighted averages for CS%/SwStr%/CSW%/Strike%.
- `frontend/src/components/ResultsTable.jsx` — Results tab with totals row using `.pp-total-row` CSS class.
- `frontend/src/components/PlayerPage.jsx` — Full player page with game log.
- `frontend/src/components/PitcherResultsTable.jsx` — Pitcher results on main data page.

### Frontend Utilities
- `frontend/src/utils/pitchFilters.js` — `getTooltipResult(pitch, opts)` shared tooltip utility returning `{ label, color, isK, isCalledStrikeThree, subLabel }`. Normalizes both Statcast and PBP formats.
- `frontend/src/utils/api.js` — All fetch functions including `fetchPitcherSeasonTotals`.
- `frontend/src/utils/formatting.js` — Cell highlight, emphasis frames, formatting helpers.
- `frontend/src/constants.js` — `PITCH_COLORS`, `CARD_PITCH_DATA_COLUMNS`, `CARD_RESULTS_COLUMNS`, `TEAM_FULL_NAMES`, `displayAbbrev`.
- `frontend/src/styles.css` — All CSS including `.pp-total-row`, `.card-gameline-table`, `.pitch-tooltip`.

### Backend
- `backend/app.py` — FastAPI endpoints: `/api/pitcher-card`, `/api/pitcher-season-totals`, `/api/player-page`, `/api/game-linescore`, `/api/season-averages`, `/api/leaderboard`, etc.
- `backend/aggregation.py` — Data aggregation: `get_pitcher_card`, `get_pitcher_game_log`, `aggregate_pitch_data_range`, `_aggregate_pitch_df`.
- `backend/data.py` — Data fetching, caching, boxscore lookups.

## Two Pitch Data Formats
- **Statcast:** `pitch_name`, `release_speed`, `description`, `events`
- **PBP:** `type`, `speed`, `desc`, plus parent PA `result`
- `getTooltipResult` normalizes both with `.toLowerCase().replace(/\s+/g, "_")` on `desc` and `ev`

## Color System

### Tooltip Result Colors
- Strikeout: `#65FF9C`
- Walk/HBP: `#FFAB6E`
- Home Run: `#FF5EDC`
- Outs: `#65BAFF`
- Single/Double/Triple: `#feffa3`
- Foul: `#AAB9FF`
- Run-scoring text: `#FF5EDC` (pink)

### Pitch Type Colors (in PITCH_COLORS constant)
- Knuckleball: `#A0A0A0` (grey)
- Forkball: `#78E0AE` (teal, between Changeup green and Splitter blue)

## Tooltip Pattern (4 locations)
All tooltips in StrikeZonePlot, VelocityTrend, PlayByPlayModal, PitcherCard:
- Use `position: fixed` with viewport clamping (`window.innerWidth`/`window.innerHeight`) to prevent overflow jitter
- Set `transform: "none"` to override the CSS `translate(-50%, -100%)`
- Strikeout sub-label ("Swinging Strike"/"Called Strike") on same line as "vs Batter", right-aligned
- Mini strikezone SVG container gets `paddingTop: 16` when `result.isK && result.subLabel`
- StrikeZonePBP passes `clientX`/`clientY` in its `onPitchHover` callback for fixed positioning

## Totals Rows
- Both PitchDataTable and ResultsTable use `.pp-total-row` CSS class (bold `font-weight: 700`, `background: rgba(255,255,255,0.04)`, `border-top: 2px solid var(--border)`)
- Box Score season totals row also uses `.pp-total-row` + `.pp-total-label`
- Box Score columns: Pitcher | IP | ER | R | Hits | BB | K | Whiffs | SwStr% | CSW% | Strike% | # | HR

## Spring Training Date Range
All season totals use `2026-02-10` as start date (includes WBC games). This is set in:
- Backend: all endpoint defaults in `app.py`, warmup in `data.py`
- Frontend: `api.js` defaults, `PitcherCard.jsx` springStart, `PlayerPage.jsx` start_date

## Sorting
Always use `TEAM_FULL_NAMES` lookup for alphabetical team sorting across all views (PitchDataTable, PitcherResultsTable default sort, column sort, and splitByTeam sort).

## Fielder's Choice / Outs
In `getTooltipResult`, fielder's choice and force outs are in the trajectory-based out section with "(FC)" or "(DP)" suffix. Launch angle determines: Groundout (<10°), Lineout (10-25°), Flyout (25-50°), Popout (>50°).

## VelocityTrendV2 Interactions
- **Hover legend:** Dims other pitch types to 20% opacity (only when no locked type)
- **Click legend:** Locks pitch type — shows swim lane overlay with top/bottom boundary lines, dotted avg line, right-side max/avg/min labels with anti-overlap stacking
- **Click canvas dot:** Opens reclassify lightbox (same as MovementPlot and StrikeZonePlot)
- Legend items use `padding: 2px 10px` with `gap: 0` on parent to eliminate hover jitter between items

## Dynamic Heights (VelocityTrend v1 swim lanes)
Formula: `max(50, round(24.75 * pitchCount))` with 4-pitch = 99px baseline.
