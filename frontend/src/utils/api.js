// In Electron, the backend runs on a dynamic port passed via window.__BACKEND_PORT__
// In dev mode (React dev server on :3000), proxy to localhost:8000
// In production web deploy, API is on the same origin (empty string)
const BASE = window.__BACKEND_PORT__
  ? `http://localhost:${window.__BACKEND_PORT__}`
  : process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "";

export async function fetchGames(date) {
  const res = await fetch(`${BASE}/api/games?date=${date}`);
  if (!res.ok) throw new Error("Failed to fetch games");
  return res.json();
}

export async function fetchPitchData(date, gamePk) {
  const url = gamePk != null
    ? `${BASE}/api/pitch-data?date=${date}&game_pk=${gamePk}`
    : `${BASE}/api/pitch-data?date=${date}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch pitch data");
  return res.json();
}

export async function fetchPitcherResults(date, gamePk) {
  const url = gamePk != null
    ? `${BASE}/api/pitcher-results?date=${date}&game_pk=${gamePk}`
    : `${BASE}/api/pitcher-results?date=${date}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch pitcher results");
  return res.json();
}

export async function fetchPitcherCard(date, pitcherId, gamePk) {
  const res = await fetch(`${BASE}/api/pitcher-card?date=${date}&pitcher_id=${pitcherId}&game_pk=${gamePk}`);
  if (!res.ok) throw new Error("Failed to fetch pitcher card");
  return res.json();
}

export async function fetchSeasonAverages(pitcherId, season, { beforeDate, excludeGamePk } = {}) {
  const params = new URLSearchParams({ pitcher_id: pitcherId, season });
  if (beforeDate) params.set("before_date", beforeDate);
  if (excludeGamePk != null) params.set("exclude_game_pk", excludeGamePk);
  const res = await fetch(`${BASE}/api/season-averages?${params}`);
  if (!res.ok) throw new Error("Failed to fetch season averages");
  return res.json();
}

export async function fetchPitcherSeasonTotals(pitcherId, startDate = "2026-03-25", endDate = "") {
  const res = await fetch(`${BASE}/api/pitcher-season-totals?pitcher_id=${pitcherId}&start_date=${startDate}&end_date=${endDate}`);
  if (!res.ok) throw new Error("Failed to fetch season totals");
  return res.json();
}

export async function fetchGameLinescore(gamePk) {
  const res = await fetch(`${BASE}/api/game-linescore?game_pk=${gamePk}`);
  if (!res.ok) throw new Error("Failed to fetch linescore");
  return res.json();
}

export async function reclassifyPitch({ game_pk, pitcher_id, at_bat_number, pitch_number, new_pitch_type, date }) {
  const res = await fetch(`${BASE}/api/pitch-reclassify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ game_pk, pitcher_id, at_bat_number, pitch_number, new_pitch_type, date }),
  });
  if (!res.ok) throw new Error("Failed to reclassify pitch");
  return res.json();
}

export async function undoReclassify({ game_pk, pitcher_id, at_bat_number, pitch_number, date }) {
  const params = new URLSearchParams({ game_pk, pitcher_id, at_bat_number, pitch_number, date: date || "" });
  const res = await fetch(`${BASE}/api/pitch-reclassify?${params}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to undo reclassification");
  return res.json();
}

export async function fetchDefaultDate() {
  const res = await fetch(`${BASE}/api/default-date`);
  if (!res.ok) throw new Error("Failed to fetch default date");
  const data = await res.json();
  return data.date;
}

export async function fetchInitialLoad() {
  const res = await fetch(`${BASE}/api/initial-load`);
  if (!res.ok) throw new Error("Failed to fetch initial load");
  return res.json();
}

export async function fetchRefresh() {
  const res = await fetch(`${BASE}/api/refresh`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to refresh data");
  return res.json();
}

export async function fetchPitcherSchedule(name, gameDate = "") {
  const params = new URLSearchParams({ name });
  if (gameDate) params.set("game_date", gameDate);
  const res = await fetch(`${BASE}/api/pitcher-schedule?${params}`);
  if (!res.ok) throw new Error("Failed to fetch pitcher schedule");
  return res.json();
}

export async function fetchLastRefresh() {
  const res = await fetch(`${BASE}/api/last-refresh`);
  if (!res.ok) throw new Error("Failed to fetch last refresh");
  return res.json();
}
