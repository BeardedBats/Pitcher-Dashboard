import React, { useState, useEffect, useMemo, useCallback, useRef as useReactRef, Suspense, lazy } from "react";
import DatePicker from "./components/DatePicker";
import GameTabs from "./components/GameTabs";
import PitchDataTable from "./components/PitchDataTable";
import PitcherResultsTable from "./components/PitcherResultsTable";
import PitcherCard from "./components/PitcherCard";
import Scoreboard from "./components/Scoreboard";
import PlayByPlayModal from "./components/PlayByPlayModal";
import ReclassifyModal from "./components/ReclassifyModal";
import SearchBar from "./components/SearchBar";
// Lazy-load pages that aren't needed on initial render
const TeamPage = lazy(() => import("./components/TeamPage"));
const PlayerPage = lazy(() => import("./components/PlayerPage"));
import { fetchGames, fetchPitchData, fetchPitcherResults, fetchPitcherCard, fetchDefaultDate, fetchGameLinescore, reclassifyPitch, fetchInitialLoad, fetchRefresh, fetchLastRefresh } from "./utils/api";
import { PITCH_TYPE_FILTERS, PITCH_COLORS, TEAMS_LIST, PITCHER_RESULTS_COLUMNS } from "./constants";

// Hash routing helpers — `#aaa[/...]` selects the AAA level, anything else is MLB.
function parseHash(rawHash) {
  const hash = (rawHash || "").replace(/^#/, "");
  if (!hash) return { level: "mlb", parts: [] };
  const parts = hash.split("/");
  if (parts[0] === "aaa") {
    return { level: "aaa", parts: parts.slice(1) };
  }
  return { level: "mlb", parts };
}

function buildHash(level, ...parts) {
  const segs = [];
  if (level === "aaa") segs.push("aaa");
  for (const p of parts) {
    if (p == null || p === "") continue;
    segs.push(String(p));
  }
  return segs.length ? "#" + segs.join("/") : "";
}
import useIsMobile from "./hooks/useIsMobile";

function getYesterdayEST() {
  // Fallback: current time in US Eastern, minus 1 day
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Helper: check if Ctrl (or Cmd on Mac) or middle-click was held during click event
function isNewWindowClick(e) {
  return e && (e.ctrlKey || e.metaKey || e.button === 1);
}

// Open a hash route in a new background tab (Electron or browser).
// Uses a real <a> element so the browser opens in the background (no focus steal),
// matching native middle-click / Ctrl+Click behavior.
function openInNewWindow(hash) {
  if (window.electronAPI?.openNewWindow) {
    window.electronAPI.openNewWindow(hash);
    return true;
  }
  const url = window.location.origin + window.location.pathname + "#" + hash;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener nofollow";
  a.style.display = "none";
  document.body.appendChild(a);
  // Dispatch a Ctrl+Click so the browser treats it as "open in background tab"
  a.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true }));
  document.body.removeChild(a);
  return true;
}

export default function App() {
  const isMobile = useIsMobile();
  // Read initial level from the hash so a refresh on #aaa stays on AAA.
  const [level, setLevel] = useState(() => parseHash(window.location.hash).level);
  const [date, setDate] = useState(null);
  const [games, setGames] = useState([]);
  const [selectedGame, setSelectedGame] = useState(null);
  const [view, setView] = useState("pitcher-results");
  const [pitchData, setPitchData] = useState([]);
  const [resultsData, setResultsData] = useState([]);
  const [cardData, setCardData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [spOnly, setSpOnly] = useState(true);
  const [rpOnly, setRpOnly] = useState(false);
  const [splitByTeam, setSplitByTeam] = useState(false);
  const [pitchFilter, setPitchFilter] = useState("Four-Seamer");
  const [resultsHiddenCols, setResultsHiddenCols] = useState(["team", "hand"]);
  const [showColFilter, setShowColFilter] = useState(false);
  const [linescoreData, setLinescoreData] = useState(null);
  const [pbpModal, setPbpModal] = useState(null); // { inning, isTop } or null
  const [reclassifyPitch_, setReclassifyPitch] = useState(null); // pitch object to reclassify
  const [page, setPage] = useState("games"); // "games" | "team" | "player"
  const [playerPageId, setPlayerPageId] = useState(null);
  const [selectedTeamPage, setSelectedTeamPage] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [toast, setToast] = useState(null); // { message, type: "success"|"error" }

  // Lifted sort state so it persists across card navigation
  const [resultsSortKey, setResultsSortKey] = useState("ip");
  const [resultsSortDir, setResultsSortDir] = useState("desc");
  const [pitchSortKey, setPitchSortKey] = useState(null);
  const [pitchSortDir, setPitchSortDir] = useState("asc");

  // Track whether this is the initial mount load (combined endpoint) vs user date change
  const initialLoadDone = React.useRef(false);
  // Ref to skip the date-change useEffect when navigating to a game card from player page
  const skipDateFetchForCard = React.useRef(false);
  // Ref to skip the pitch/results data fetch (e.g. after initial load already provided it)
  const skipNextDataFetch = React.useRef(false);

  // Fetch everything on mount in a single API call.
  // `#aaa` (no further parts) is treated as a level toggle, NOT a deep link —
  // so we still run initial-load for the AAA games view.
  useEffect(() => {
    const { level: hashLevel, parts: hashParts } = parseHash(window.location.hash);
    if (hashParts.length > 0) return; // Deep-link (e.g. #aaa/card/...) will handle its own loading
    setLoading(true);
    fetchInitialLoad(hashLevel)
      .then(data => {
        initialLoadDone.current = true;
        skipNextDataFetch.current = true;
        setDate(data.date);
        setGames(data.games);
        setPitchData(data.pitchData);
        setResultsData(data.resultsData);
        setLoading(false);
      })
      .catch(() => {
        // Fallback to sequential flow — date change will trigger games fetch
        setLoading(false);
        fetchDefaultDate(hashLevel)
          .then(d => setDate(d))
          .catch(() => setDate(getYesterdayEST()));
      });
  }, []); // eslint-disable-line

  // Fetch last refresh timestamp on mount; fall back to "now" so button always shows a time
  useEffect(() => {
    fetchLastRefresh()
      .then(data => { setLastRefresh(data.timestamp || new Date().toISOString()); })
      .catch(() => { setLastRefresh(new Date().toISOString()); });
  }, []);

  // Auto-dismiss toast after 3 seconds
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await fetchRefresh(level);
      setLastRefresh(data.timestamp);
      setToast({ message: "Data refreshed", type: "success" });
      // Re-fetch current page data including linescore
      if (date) {
        const fetches = [
          fetchGames(date, level),
          fetchPitchData(date, selectedGame, level),
          fetchPitcherResults(date, selectedGame, level),
        ];
        const gpk = cardData?.result?.game_pk || selectedGame;
        if (gpk) fetches.push(fetchGameLinescore(gpk));
        const [newGames, newPitch, newResults, newLinescore] = await Promise.all(fetches);
        setGames(newGames);
        setPitchData(newPitch);
        setResultsData(newResults);
        if (newLinescore) setLinescoreData(newLinescore);
      }
    } catch (e) {
      setToast({ message: "Refresh failed", type: "error" });
    } finally {
      setRefreshing(false);
    }
  };

  const formatRefreshTime = (isoStr) => {
    if (!isoStr) return "";
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    } catch { return ""; }
  };

  // Handle hash-based deep linking for new windows. Examples:
  //   #player/12345                         (MLB player)
  //   #card/2026-03-08/12345/789            (MLB card)
  //   #aaa                                  (AAA games view — no parts after prefix)
  //   #aaa/player/12345                     (AAA player)
  //   #aaa/card/2026-03-08/12345/789        (AAA card)
  const hashHandled = React.useRef(false);
  useEffect(() => {
    if (hashHandled.current) return;
    const { level: hashLevel, parts } = parseHash(window.location.hash);
    if (parts.length === 0) {
      // Bare `#` or `#aaa` — initial-load effect handles data fetch.
      hashHandled.current = true;
      return;
    }
    hashHandled.current = true;
    if (hashLevel !== level) setLevel(hashLevel);
    const baseHash = window.location.pathname;
    if (parts[0] === "player" && parts[1]) {
      // #[aaa/]player/{pitcherId}
      const pid = Number(parts[1]);
      setPage("player");
      setPlayerPageId(pid);
      setLoading(false);
      window.history.replaceState({ view: "list", page: "games", selectedGame: null, level: hashLevel }, "", baseHash);
      window.history.pushState({ view: "list", page: "player", pitcherId: pid, level: hashLevel }, "", buildHash(hashLevel, "player", pid));
    } else if (parts[0] === "team" && parts[1]) {
      // #[aaa/]team/{teamAbbrev}
      const team = parts[1];
      setPage("team");
      setSelectedTeamPage(team);
      setLoading(false);
      window.history.replaceState({ view: "list", page: "games", selectedGame: null, level: hashLevel }, "", baseHash);
      window.history.pushState({ view: "list", page: "team", team, level: hashLevel }, "", buildHash(hashLevel, "team", team));
    } else if (parts[0] === "card" && parts[1] && parts[2] && parts[3]) {
      // #[aaa/]card/{date}/{pitcherId}/{gamePk}
      const gameDate = parts[1];
      const pitcherId = Number(parts[2]);
      const gamePk = Number(parts[3]);
      skipDateFetchForCard.current = true;
      skipNextDataFetch.current = true;
      setPage("games");
      setSelectedGame(gamePk);
      setDate(gameDate);
      setLoading(true);
      window.history.replaceState({ view: "list", page: "games", selectedGame: null, date: gameDate, level: hashLevel }, "", baseHash);
      fetchPitcherCard(gameDate, pitcherId, gamePk, hashLevel)
        .then(cd => {
          setCardData(cd); setLoading(false);
          window.history.pushState({ view: "card", selectedGame: gamePk, pitcherId, gamePk, date: gameDate, level: hashLevel }, "", buildHash(hashLevel, "card", gameDate, pitcherId, gamePk));
        })
        .catch(e => { setError(e.message); setLoading(false); });
      // Background: load games for the game tabs (non-blocking)
      fetchGames(gameDate, hashLevel)
        .then(g => setGames(g))
        .catch(() => {});
    }
  }, []); // eslint-disable-line

  // Track whether we're currently handling a popstate event to avoid pushing duplicate history
  const isPopState = React.useRef(false);
  // Pending scroll restoration — stored in ref so a post-render effect can pick it up
  const pendingScrollY = React.useRef(null);

  const resetToDefault = useCallback(() => {
    setCardData(null);
    setSelectedGame(null);
    setView("pitcher-results");
    setSpOnly(true);
    setSplitByTeam(false);
    setPage("games");
    setPlayerPageId(null);
    setSelectedTeamPage(null);
    // resetToDefault always lands on MLB games view (the "home" of the app)
    setLevel("mlb");
    window.history.pushState({ view: "list", page: "games", selectedGame: null, level: "mlb" }, "", window.location.pathname);
  }, []);

  // Switch between MLB and AAA. Clears the current view (card/team/player) so
  // the level swap lands on the games list and re-fires data hooks via the
  // [date, level] effect.
  const selectLevel = useCallback((newLevel) => {
    if (newLevel === level) return;
    setLevel(newLevel);
    setCardData(null);
    setSelectedGame(null);
    setPage("games");
    setPlayerPageId(null);
    setSelectedTeamPage(null);
    setDate(null); // force /api/default-date refetch for new level
    setGames([]);
    setPitchData([]);
    setResultsData([]);
    setLoading(true);
    fetchInitialLoad(newLevel)
      .then(data => {
        initialLoadDone.current = true;
        skipNextDataFetch.current = true;
        setDate(data.date);
        setGames(data.games);
        setPitchData(data.pitchData);
        setResultsData(data.resultsData);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
        fetchDefaultDate(newLevel)
          .then(d => setDate(d))
          .catch(() => setDate(getYesterdayEST()));
      });
    // Update URL to reflect the level (bare `#aaa` or no hash for mlb)
    const url = newLevel === "aaa" ? "#aaa" : window.location.pathname;
    window.history.pushState({ view: "list", page: "games", selectedGame: null, level: newLevel }, "", url);
  }, [level]);

  // Browser back/forward navigation support
  useEffect(() => {
    // Set initial state only if not deep-linking via hash
    if (!window.location.hash) {
      window.history.replaceState({ view: "list", selectedGame: null }, "");
    }
  }, []);

  // Helper: pushState that auto-saves current scroll position and syncs URL hash.
  // Always reads current `level` from state so AAA navigation gets the right prefix.
  const pushState = useCallback((state, title = "") => {
    const current = window.history.state;
    if (current && current.scrollY == null) {
      window.history.replaceState({ ...current, scrollY: window.scrollY }, "");
    }
    const stateLevel = state.level || level;
    const stateWithLevel = { ...state, level: stateLevel };
    // Build hash from state so refreshes restore the same view
    let hash = "";
    if (state.view === "card" && state.date && state.pitcherId && state.gamePk) {
      hash = buildHash(stateLevel, "card", state.date, state.pitcherId, state.gamePk);
    } else if (state.page === "player" && state.pitcherId) {
      hash = buildHash(stateLevel, "player", state.pitcherId);
    } else if (state.page === "team" && state.team) {
      hash = buildHash(stateLevel, "team", state.team);
    } else if (stateLevel === "aaa") {
      // No deep hash but AAA — preserve the level marker
      hash = buildHash(stateLevel);
    }
    const url = hash || window.location.pathname;
    window.history.pushState(stateWithLevel, title, url);
  }, [level]);

  useEffect(() => {
    const handlePopState = (e) => {
      const state = e.state;
      isPopState.current = true;
      // Restore level from state — back/forward across MLB ↔ AAA must re-fetch with correct level.
      if (state?.level && state.level !== level) setLevel(state.level);
      const popLevel = state?.level || level;
      if (!state || state.view === "list") {
        setCardData(null);
        setSelectedGame(state?.selectedGame || null);
        if (state?.page === "team") { setPage("team"); setSelectedTeamPage(state.team); }
        else if (state?.page === "player") { setPage("player"); setPlayerPageId(state.pitcherId); }
        else { setPage("games"); }
      } else if (state.view === "game") {
        setCardData(null);
        setSelectedGame(state.selectedGame);
        setPage("games");
      } else if (state.view === "card" && state.pitcherId && state.gamePk) {
        const cardDate = state.date || date;
        setPage("games");
        setSelectedGame(state.selectedGame);
        setLoading(true);
        fetchPitcherCard(cardDate, state.pitcherId, state.gamePk, popLevel)
          .then(cd => { setCardData(cd); setLoading(false); })
          .catch(err => { setError(err.message); setLoading(false); });
      }
      // Store scroll target — a post-render effect will restore it once React finishes
      if (state?.scrollY != null) {
        pendingScrollY.current = state.scrollY;
      }
      setTimeout(() => { isPopState.current = false; }, 0);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [date, level]);

  // Restore scroll position AFTER React re-renders the list view
  useEffect(() => {
    if (pendingScrollY.current == null || cardData) return; // wait until card is gone
    const targetY = pendingScrollY.current;
    pendingScrollY.current = null;
    let attempts = 0;
    const tryScroll = () => {
      window.scrollTo(0, targetY);
      attempts++;
      if (Math.abs(window.scrollY - targetY) > 5 && attempts < 60) {
        requestAnimationFrame(tryScroll);
      }
    };
    requestAnimationFrame(tryScroll);
  }, [cardData, page, selectedGame]);

  useEffect(() => {
    if (!date) return;  // Wait for smart default date to resolve
    // Skip if initial load already populated games/data
    if (initialLoadDone.current) {
      initialLoadDone.current = false;
      return;
    }
    // Skip if navigateToGameCard already fetched everything
    if (skipDateFetchForCard.current) {
      skipDateFetchForCard.current = false;
      return;
    }
    setGames([]); setSelectedGame(null); setCardData(null);
    setPitchData([]); setResultsData([]);
    setLoading(true); setError(null);
    fetchGames(date, level)
      .then(g => { setGames(g); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [date, level]);

  useEffect(() => {
    if (games.length === 0) return;
    if (skipNextDataFetch.current) {
      skipNextDataFetch.current = false;
      return;
    }
    // Don't nuke an open card or fetch table data while viewing a card
    if (cardData) return;
    setLoading(true); setError(null);
    Promise.all([
      fetchPitchData(date, selectedGame, level),
      fetchPitcherResults(date, selectedGame, level),
    ]).then(([pd, pr]) => {
      setPitchData(pd); setResultsData(pr); setLoading(false);
    }).catch(e => { setError(e.message); setLoading(false); });
  }, [selectedGame, date, games.length, level]); // eslint-disable-line

  // Fetch linescore when a specific game is selected or card opens.
  // Poll every 60s during live games so scoreboard stays current.
  const linescoreGamePk = cardData?.result?.game_pk || selectedGame;
  useEffect(() => {
    if (!linescoreGamePk) { setLinescoreData(null); return; }
    let cancelled = false;
    const doFetch = () => {
      fetchGameLinescore(linescoreGamePk)
        .then(ls => { if (!cancelled) setLinescoreData(ls); })
        .catch(() => { if (!cancelled) setLinescoreData(null); });
    };
    doFetch(); // initial fetch
    const interval = setInterval(() => {
      // Only poll if game is still live (is_final === false)
      setLinescoreData(prev => {
        if (prev && prev.is_final === false) doFetch();
        return prev;
      });
    }, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [linescoreGamePk]);

  const filteredPitchData = useMemo(() => {
    let rows = pitchData;
    if (pitchFilter) rows = rows.filter(r => r.pitch_name === pitchFilter);
    return rows;
  }, [pitchData, pitchFilter]);

  const filteredResultsData = useMemo(() => {
    if (!rpOnly) return resultsData;
    return resultsData.filter(r => r.role === "RP");
  }, [resultsData, rpOnly]);

  // Build the hash fragment used for "open in new tab" links so they preserve level.
  const cardHash = (gameDate, pitcherId, gamePk) => buildHash(level, "card", gameDate, pitcherId, gamePk).replace(/^#/, "");
  const playerHash = (pitcherId) => buildHash(level, "player", pitcherId).replace(/^#/, "");

  const openCard = (pitcherId, gamePk, e) => {
    // Ctrl+Click / Cmd+Click / Middle-click → open in new tab, don't navigate current page
    if (isNewWindowClick(e) && date) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      openInNewWindow(cardHash(date, pitcherId, gamePk));
      return;
    }
    // Save scroll position NOW — before setLoading(true) unmounts the table and resets scrollY to 0
    const current = window.history.state;
    if (current) {
      window.history.replaceState({ ...current, scrollY: window.scrollY }, "");
    }
    setLoading(true); setError(null);
    fetchPitcherCard(date, pitcherId, gamePk, level)
      .then(cd => {
        setCardData(cd); setLoading(false);
        if (!isPopState.current) {
          pushState({ view: "card", selectedGame, pitcherId, gamePk, date }, "");
        }
      })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  const closeCard = () => {
    window.history.back();
  };

  const navigateToTeam = (teamAbbrev) => {
    setPage("team");
    setSelectedTeamPage(teamAbbrev);
    setCardData(null);
    pushState({ view: "list", page: "team", team: teamAbbrev }, "");
  };

  const navigateToPlayer = async (pitcherId, playerName, e) => {
    // Ctrl+Click / Cmd+Click / Middle-click → open in new tab, don't navigate current page
    if (isNewWindowClick(e) && pitcherId) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      openInNewWindow(playerHash(pitcherId));
      return;
    }
    // If we have a pitcher ID, navigate directly
    if (pitcherId) {
      setPage("player");
      setPlayerPageId(pitcherId);
      setCardData(null);
      pushState({ view: "list", page: "player", pitcherId }, "");
      return;
    }
    // Otherwise resolve from name via backend
    if (playerName) {
      try {
        const API = window.__BACKEND_PORT__
          ? `http://localhost:${window.__BACKEND_PORT__}`
          : process.env.NODE_ENV === "development" ? "http://localhost:8000" : "";
        const lvParam = level && level !== "mlb" ? `&level=${encodeURIComponent(level)}` : "";
        const res = await fetch(`${API}/api/resolve-pitcher?name=${encodeURIComponent(playerName)}${lvParam}`);
        const data = await res.json();
        if (data.pitcher_id) {
          // If Ctrl+Click was held, open resolved player in new tab
          if (isNewWindowClick(e)) {
            if (e && e.preventDefault) e.preventDefault();
            if (e && e.stopPropagation) e.stopPropagation();
            openInNewWindow(playerHash(data.pitcher_id));
            return;
          }
          setPage("player");
          setPlayerPageId(data.pitcher_id);
          setCardData(null);
          pushState({ view: "list", page: "player", pitcherId: data.pitcher_id }, "");
        }
      } catch (err) {
        console.error("Failed to resolve pitcher:", err);
      }
    }
  };

  const navigateToGameCard = (gameDate, pitcherId, gamePk, e) => {
    // Ctrl+Click / Cmd+Click / Middle-click → open in new tab, don't navigate current page
    if (isNewWindowClick(e)) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      openInNewWindow(cardHash(gameDate, pitcherId, gamePk));
      return;
    }
    // Save scroll position NOW — before setLoading(true) unmounts the content
    const current = window.history.state;
    if (current) {
      window.history.replaceState({ ...current, scrollY: window.scrollY }, "");
    }
    // Navigate from player page game log to the pitcher card for that game
    // Signal the date-change useEffect to skip resetting everything
    skipDateFetchForCard.current = true;
    // Skip the data fetch triggered by selectedGame change (prevents race condition
    // where stale date + new gamePk returns empty data before card loads)
    skipNextDataFetch.current = true;
    setPage("games");
    setSelectedGame(gamePk);
    setLoading(true);
    // Fetch card and games for that date in parallel
    Promise.all([
      fetchPitcherCard(gameDate, pitcherId, gamePk, level),
      fetchGames(gameDate, level),
    ]).then(([cd, g]) => {
      setDate(gameDate);
      setGames(g);
      setCardData(cd);
      setLoading(false);
      pushState({ view: "card", selectedGame: gamePk, pitcherId, gamePk, date: gameDate }, "");
    }).catch(e => { setError(e.message); setLoading(false); skipDateFetchForCard.current = false; });
  };

  const navigateBackToGames = () => {
    setPage("games");
    setCardData(null);
    pushState({ view: "list", page: "games", selectedGame: null }, "");
  };

  // Header nav component (reused in both header renders)
  const headerNav = (
    <div className="header-nav">
      <button
        className={`refresh-btn${refreshing ? " refreshing" : ""}`}
        onClick={handleRefresh}
        disabled={refreshing}
        title="Refresh data"
      >
        <span className={`refresh-icon${refreshing ? " spinning" : ""}`}>&#x21bb;</span>
        {lastRefresh ? <span className="refresh-ts">Updated {formatRefreshTime(lastRefresh)}</span> : null}
      </button>
      <select
        className="team-select"
        value={page === "team" ? selectedTeamPage || "" : ""}
        onChange={(e) => { if (e.target.value) navigateToTeam(e.target.value); }}
      >
        <option value="">Teams</option>
        {TEAMS_LIST.map(t => (
          <option key={t.abbrev} value={t.abbrev}>{t.name}</option>
        ))}
      </select>
      <div className="header-nav-spacer" />
      <SearchBar level={level} onSelectPlayer={(id, name, e) => navigateToPlayer(id, name, e)} />
    </div>
  );

  return (
    <div className="app">
      {/* === HEADER (always shown when no card view) === */}
      {!cardData && (
        <div className="header">
          <h1 className="app-title"><a href={window.location.pathname} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey && e.button !== 1) { e.preventDefault(); resetToDefault(); } }} style={{ color: "inherit", textDecoration: "none" }}>Live Pitch Dashboard</a></h1>
          <DatePicker date={date} onChange={setDate} />
          {headerNav}
        </div>
      )}

      {/* === TOAST NOTIFICATION === */}
      {toast && (
        <div className={`toast-notification toast-${toast.type}`}>
          {toast.message}
        </div>
      )}

      {/* === TEAM PAGE === */}
      {page === "team" && selectedTeamPage && !cardData && (
        <Suspense fallback={<div className="loading"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div></div>}>
          <TeamPage teamAbbrev={selectedTeamPage} level={level} onPlayerClick={(id, name, e) => navigateToPlayer(id, name, e)} onBack={navigateBackToGames} />
        </Suspense>
      )}

      {/* === PLAYER PAGE === */}
      {page === "player" && playerPageId && !cardData && (
        <Suspense fallback={<div className="loading"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div></div>}>
          <PlayerPage pitcherId={playerPageId} level={level} onBack={navigateBackToGames} onGameClick={navigateToGameCard} />
        </Suspense>
      )}

      {/* === GAMES PAGE (original daily view) === */}
      {page === "games" && !cardData && (
        <>
          <GameTabs games={games} selectedGame={selectedGame} level={level} onSelectLevel={selectLevel} onSelectGame={gp => {
            if (gp !== selectedGame && !isPopState.current) {
              pushState({ view: "game", selectedGame: gp }, "");
            }
            setSelectedGame(gp); setCardData(null);
          }} />

          {games.length > 0 && selectedGame && linescoreData && (
            <Scoreboard data={linescoreData} level={level} onInningClick={(inn, isTop) => setPbpModal({ inning: inn, isTop })} />
          )}

          {games.length > 0 && (
            <>
              <div className="controls-row">
                <button className={`view-btn${view === "pitcher-results" ? " active" : ""}`} onClick={() => setView("pitcher-results")}>
                  Pitcher Results
                </button>
                <button className={`view-btn${view === "pitch-data" ? " active" : ""}`} onClick={() => setView("pitch-data")}>
                  Pitch Data
                </button>
                <div className="toggle-group">
                  <label className="toggle-label">
                    <input type="checkbox" checked={spOnly} onChange={e => { setSpOnly(e.target.checked); if (e.target.checked) setRpOnly(false); }} />
                    <span>SP Only</span>
                  </label>
                  <label className="toggle-label">
                    <input type="checkbox" checked={rpOnly} onChange={e => { setRpOnly(e.target.checked); if (e.target.checked) setSpOnly(false); }} />
                    <span>RP Only</span>
                  </label>
                  <label className="toggle-label">
                    <input type="checkbox" checked={splitByTeam} onChange={e => setSplitByTeam(e.target.checked)} />
                    <span>By Team</span>
                  </label>
                  {view === "pitcher-results" && (
                    <div className="col-filter-inline">
                      <button className="col-filter-toggle" onClick={() => setShowColFilter(v => !v)}>
                        Columns {showColFilter ? "\u25B2" : "\u25BC"}
                      </button>
                      {showColFilter && (
                        <div className="col-filter-dropdown">
                          {PITCHER_RESULTS_COLUMNS.filter(c => c.key !== "pitcher").map(c => (
                            <label key={c.key} className="col-filter-label">
                              <input type="checkbox" checked={!resultsHiddenCols.includes(c.key)} onChange={() => setResultsHiddenCols(prev => prev.includes(c.key) ? prev.filter(k => k !== c.key) : [...prev, c.key])} />
                              {c.label}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {view === "pitch-data" && (
                <div className="pitch-type-filters">
                  {PITCH_TYPE_FILTERS.map(pt => (
                    <button key={pt}
                      className={`pitch-type-btn${pitchFilter === pt ? " active" : ""}`}
                      style={pitchFilter === pt
                        ? { background: PITCH_COLORS[pt] || "#555", color: "#1A1C30" }
                        : { background: "transparent", color: PITCH_COLORS[pt] || "#555", borderColor: PITCH_COLORS[pt] || "#555" }
                      }
                      onClick={() => setPitchFilter(pitchFilter === pt ? null : pt)}>
                      {pt}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {loading && <div className="loading"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div></div>}
      {error && <div className="error">{error}</div>}

      {!loading && !error && !cardData && page === "games" && (
        <div className={splitByTeam ? "table-card-none" : "table-card"}>
          <div className="table-container">
            {view === "pitch-data" && (
              <PitchDataTable data={filteredPitchData} date={date} level={level} onPitcherClick={openCard} splitByTeam={splitByTeam} spOnly={spOnly} isMobile={isMobile} sortKey={pitchSortKey} onSortKeyChange={setPitchSortKey} sortDir={pitchSortDir} onSortDirChange={setPitchSortDir} />
            )}
            {view === "pitcher-results" && (
              <PitcherResultsTable data={filteredResultsData} date={date} level={level} onPitcherClick={openCard} spOnly={spOnly} splitByTeam={splitByTeam} isMobile={isMobile} sortKey={resultsSortKey} onSortKeyChange={setResultsSortKey} sortDir={resultsSortDir} onSortDirChange={setResultsSortDir} hiddenCols={resultsHiddenCols} />
            )}
          </div>
        </div>
      )}

      {!loading && !error && cardData && (
        <>
          <div className="header">
            <h1 className="app-title"><a href={window.location.pathname} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey && e.button !== 1) { e.preventDefault(); resetToDefault(); } }} style={{ color: "inherit", textDecoration: "none" }}>Live Pitch Dashboard</a></h1>
            <DatePicker date={date} onChange={setDate} />
            {headerNav}
          </div>
          {games.length > 0 && (
            <GameTabs games={games} selectedGame={selectedGame} level={level} onSelectLevel={selectLevel} onSelectGame={gp => {
              if (gp !== selectedGame && !isPopState.current) {
                pushState({ view: "game", selectedGame: gp }, "");
              }
              setSelectedGame(gp); setCardData(null);
            }} />
          )}
          <div className="card-outer">
            <div className="card-top-row">
              <button className="back-btn" onClick={closeCard}>
                {"\u2190"} {selectedGame ? "Back to Game" : "Back to All Games"}
              </button>
              {linescoreData && (
                <Scoreboard data={linescoreData} level={level} pitcherId={cardData?.result?.pitcher_id} onInningClick={(inn, isTop) => setPbpModal({ inning: inn, isTop })} />
              )}
            </div>
            <PitcherCard cardData={cardData} date={date} linescoreData={linescoreData} isMobile={isMobile} level={level} onPlayerClick={(id, e) => navigateToPlayer(id, null, e)} onGameClick={(e) => {
              const gamePk = cardData?.result?.game_pk || selectedGame;
              const pitcherId = cardData?.result?.pitcher_id;
              if (isNewWindowClick(e) && gamePk && date && pitcherId) {
                if (e && e.preventDefault) e.preventDefault();
                if (e && e.stopPropagation) e.stopPropagation();
                openInNewWindow(cardHash(date, pitcherId, gamePk));
                return;
              }
              if (gamePk) {
                setSelectedGame(gamePk);
                setCardData(null);
                pushState({ view: "game", selectedGame: gamePk }, "");
                // Force data re-fetch even if selectedGame hasn't changed
                setLoading(true); setError(null);
                Promise.all([
                  fetchPitchData(date, gamePk, level),
                  fetchPitcherResults(date, gamePk, level),
                ]).then(([pd, pr]) => {
                  setPitchData(pd); setResultsData(pr); setLoading(false);
                }).catch(e => { setError(e.message); setLoading(false); });
              }
            }} onReclassify={(pitch) => setReclassifyPitch(pitch)} />
          </div>
        </>
      )}

      {!loading && !error && games.length === 0 && page === "games" && (
        <div className="no-data">No games found for this date. Try selecting a different date.</div>
      )}

      {pbpModal && linescoreData && (
        <PlayByPlayModal
          data={linescoreData}
          inning={pbpModal.inning}
          isTop={pbpModal.isTop}
          pitcherId={cardData?.result?.pitcher_id || null}
          level={level}
          onClose={() => setPbpModal(null)}
        />
      )}

      {reclassifyPitch_ && cardData && (
        <ReclassifyModal
          pitch={reclassifyPitch_}
          gamePk={cardData.game_pk || cardData.result?.game_pk || selectedGame}
          pitcherId={cardData.pitcher_id || cardData.result?.pitcher_id}
          date={date}
          onClose={() => setReclassifyPitch(null)}
          onConfirm={(req) => {
            // Carry the active level so the override is saved against the right namespace
            reclassifyPitch({ ...req, level }).then(() => {
              setReclassifyPitch(null);
              // Refresh the pitcher card data
              const pid = cardData.pitcher_id || cardData.result?.pitcher_id;
              const gpk = cardData.game_pk || cardData.result?.game_pk || selectedGame;
              if (pid && gpk) {
                setLoading(true);
                fetchPitcherCard(date, pid, gpk, level)
                  .then(cd => { setCardData(cd); setLoading(false); })
                  .catch(err => { setError(err.message); setLoading(false); });
              }
            }).catch(err => { setError(err.message); setReclassifyPitch(null); });
          }}
        />
      )}
    </div>
  );
}
