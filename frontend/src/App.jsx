import React, { useState, useEffect, useMemo, useCallback, Suspense, lazy } from "react";
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
const LeaderboardPage = lazy(() => import("./components/LeaderboardPage"));
const TeamPage = lazy(() => import("./components/TeamPage"));
const PlayerPage = lazy(() => import("./components/PlayerPage"));
import { fetchGames, fetchPitchData, fetchPitcherResults, fetchPitcherCard, fetchDefaultDate, fetchGameLinescore, reclassifyPitch, fetchInitialLoad } from "./utils/api";
import { PITCH_TYPE_FILTERS, PITCH_COLORS, TEAMS_LIST } from "./constants";
import { TOP_400_NAMES } from "./top400";

function getYesterdayEST() {
  // Fallback: current time in US Eastern, minus 1 day
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Helper: check if Ctrl (or Cmd on Mac) was held during click event
function isNewWindowClick(e) {
  return e && (e.ctrlKey || e.metaKey);
}

// Open a hash route in a new Electron window (no-op if not in Electron)
function openInNewWindow(hash) {
  if (window.electronAPI?.openNewWindow) {
    window.electronAPI.openNewWindow(hash);
    return true;
  }
  return false;
}

export default function App() {
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
  const [splitByTeam, setSplitByTeam] = useState(false);
  const [pitchFilter, setPitchFilter] = useState("Four-Seamer");
  const [top400Only, setTop400Only] = useState(false);
  const [linescoreData, setLinescoreData] = useState(null);
  const [pbpModal, setPbpModal] = useState(null); // { inning, isTop } or null
  const [reclassifyPitch_, setReclassifyPitch] = useState(null); // pitch object to reclassify
  const [page, setPage] = useState("games"); // "games" | "leaderboard" | "team" | "player"
  const [playerPageId, setPlayerPageId] = useState(null);
  const [selectedTeamPage, setSelectedTeamPage] = useState(null);

  // Track whether this is the initial mount load (combined endpoint) vs user date change
  const initialLoadDone = React.useRef(false);
  // Ref to skip the date-change useEffect when navigating to a game card from player page
  const skipDateFetchForCard = React.useRef(false);

  // Fetch everything on mount in a single API call
  useEffect(() => {
    setLoading(true);
    fetchInitialLoad()
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
        // Fallback to sequential flow
        fetchDefaultDate()
          .then(d => setDate(d))
          .catch(() => setDate(getYesterdayEST()));
      });
  }, []);

  // Handle hash-based deep linking for new windows (e.g. #player/12345 or #card/2026-03-08/12345/789)
  const hashHandled = React.useRef(false);
  useEffect(() => {
    if (hashHandled.current) return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    hashHandled.current = true;
    // Clear the hash so it doesn't interfere with history
    window.history.replaceState(null, "", window.location.pathname);
    const parts = hash.split("/");
    if (parts[0] === "player" && parts[1]) {
      // #player/{pitcherId}
      setPage("player");
      setPlayerPageId(Number(parts[1]));
      setLoading(false);
    } else if (parts[0] === "card" && parts[1] && parts[2] && parts[3]) {
      // #card/{date}/{pitcherId}/{gamePk}
      const gameDate = parts[1];
      const pitcherId = Number(parts[2]);
      const gamePk = Number(parts[3]);
      skipDateFetchForCard.current = true;
      setPage("games");
      setSelectedGame(gamePk);
      setLoading(true);
      Promise.all([
        fetchPitcherCard(gameDate, pitcherId, gamePk),
        fetchGames(gameDate),
      ]).then(([cd, g]) => {
        setDate(gameDate);
        setGames(g);
        setCardData(cd);
        setLoading(false);
      }).catch(e => { setError(e.message); setLoading(false); });
    }
  }, []);

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
    pushState({ view: "list", page: "games", selectedGame: null }, "");
  }, []);

  // Browser back/forward navigation support
  useEffect(() => {
    // Set initial state
    window.history.replaceState({ view: "list", selectedGame: null }, "");
  }, []);

  // Helper: pushState that auto-saves current scroll position first
  const pushState = useCallback((state, title = "") => {
    const current = window.history.state;
    if (current && current.scrollY == null) {
      // Only save scrollY if not already captured (e.g. by openCard before loading)
      window.history.replaceState({ ...current, scrollY: window.scrollY }, "");
    }
    window.history.pushState(state, title);
  }, []);

  useEffect(() => {
    const handlePopState = (e) => {
      const state = e.state;
      isPopState.current = true;
      if (!state || state.view === "list") {
        setCardData(null);
        setSelectedGame(state?.selectedGame || null);
        setPage(state?.page || "games");
        if (state?.page === "leaderboard") { setPage("leaderboard"); }
        else if (state?.page === "team") { setPage("team"); setSelectedTeamPage(state.team); }
        else if (state?.page === "player") { setPage("player"); setPlayerPageId(state.pitcherId); }
        else { setPage("games"); }
      } else if (state.view === "game") {
        setCardData(null);
        setSelectedGame(state.selectedGame);
        setPage("games");
      } else if (state.view === "card" && state.pitcherId && state.gamePk) {
        setPage("games");
        setSelectedGame(state.selectedGame);
        setLoading(true);
        fetchPitcherCard(date, state.pitcherId, state.gamePk)
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
  }, [date]);

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
    fetchGames(date)
      .then(g => { setGames(g); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [date]);

  // Skip the next pitch/results fetch if initial load already provided the data
  const skipNextDataFetch = React.useRef(false);

  useEffect(() => {
    if (games.length === 0) return;
    if (skipNextDataFetch.current) {
      skipNextDataFetch.current = false;
      return;
    }
    setCardData(null); setLoading(true); setError(null);
    Promise.all([
      fetchPitchData(date, selectedGame),
      fetchPitcherResults(date, selectedGame),
    ]).then(([pd, pr]) => {
      setPitchData(pd); setResultsData(pr); setLoading(false);
    }).catch(e => { setError(e.message); setLoading(false); });
  }, [selectedGame, date, games.length]);

  // Fetch linescore when a specific game is selected or card opens
  const linescoreGamePk = cardData?.result?.game_pk || selectedGame;
  useEffect(() => {
    if (!linescoreGamePk) { setLinescoreData(null); return; }
    fetchGameLinescore(linescoreGamePk)
      .then(ls => setLinescoreData(ls))
      .catch(() => setLinescoreData(null));
  }, [linescoreGamePk]);

  const filteredPitchData = useMemo(() => {
    let rows = pitchData;
    if (pitchFilter) rows = rows.filter(r => r.pitch_name === pitchFilter);
    if (top400Only) rows = rows.filter(r => TOP_400_NAMES.has(r.pitcher));
    return rows;
  }, [pitchData, pitchFilter, top400Only]);

  const filteredResultsData = useMemo(() => {
    if (!top400Only) return resultsData;
    return resultsData.filter(r => TOP_400_NAMES.has(r.pitcher));
  }, [resultsData, top400Only]);

  const openCard = (pitcherId, gamePk, e) => {
    // Ctrl+Click / Cmd+Click → open in new window
    if (isNewWindowClick(e) && date) {
      openInNewWindow(`card/${date}/${pitcherId}/${gamePk}`);
      return;
    }
    // Save scroll position NOW — before setLoading(true) unmounts the table and resets scrollY to 0
    const current = window.history.state;
    if (current) {
      window.history.replaceState({ ...current, scrollY: window.scrollY }, "");
    }
    setLoading(true); setError(null);
    fetchPitcherCard(date, pitcherId, gamePk)
      .then(cd => {
        setCardData(cd); setLoading(false);
        if (!isPopState.current) {
          pushState({ view: "card", selectedGame, pitcherId, gamePk }, "");
        }
      })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  const closeCard = () => {
    window.history.back();
  };

  const navigateToLeaderboard = () => {
    setPage("leaderboard");
    setCardData(null);
    pushState({ view: "list", page: "leaderboard" }, "");
  };

  const navigateToTeam = (teamAbbrev) => {
    setPage("team");
    setSelectedTeamPage(teamAbbrev);
    setCardData(null);
    pushState({ view: "list", page: "team", team: teamAbbrev }, "");
  };

  const navigateToPlayer = async (pitcherId, playerName, e) => {
    // Ctrl+Click / Cmd+Click → open in new window
    if (isNewWindowClick(e) && pitcherId) {
      openInNewWindow(`player/${pitcherId}`);
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
        const res = await fetch(`${API}/api/resolve-pitcher?name=${encodeURIComponent(playerName)}`);
        const data = await res.json();
        if (data.pitcher_id) {
          // If Ctrl+Click was held, open resolved player in new window
          if (isNewWindowClick(e)) {
            openInNewWindow(`player/${data.pitcher_id}`);
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
    // Ctrl+Click / Cmd+Click → open in new window
    if (isNewWindowClick(e)) {
      openInNewWindow(`card/${gameDate}/${pitcherId}/${gamePk}`);
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
    setPage("games");
    setSelectedGame(gamePk);
    setLoading(true);
    // Fetch card and games for that date in parallel
    Promise.all([
      fetchPitcherCard(gameDate, pitcherId, gamePk),
      fetchGames(gameDate),
    ]).then(([cd, g]) => {
      setDate(gameDate);
      setGames(g);
      setCardData(cd);
      setLoading(false);
      pushState({ view: "card", selectedGame: gamePk, pitcherId, gamePk }, "");
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
      <button className={`nav-link${page === "leaderboard" ? " active" : ""}`} onClick={navigateToLeaderboard}>
        Leaderboard
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
      <SearchBar onSelectPlayer={(id, name) => navigateToPlayer(id, name)} />
    </div>
  );

  return (
    <div className="app">
      {/* === HEADER (always shown when no card view) === */}
      {!cardData && (
        <div className="header">
          <h1 className="app-title" onClick={resetToDefault}>Live Pitch Dashboard</h1>
          <DatePicker date={date} onChange={setDate} />
          {headerNav}
        </div>
      )}

      {/* === LEADERBOARD PAGE === */}
      {page === "leaderboard" && !cardData && (
        <Suspense fallback={<div className="loading-indicator">Loading...</div>}>
          <LeaderboardPage onPlayerClick={(id, name, e) => navigateToPlayer(id, name, e)} onBack={navigateBackToGames} />
        </Suspense>
      )}

      {/* === TEAM PAGE === */}
      {page === "team" && selectedTeamPage && !cardData && (
        <Suspense fallback={<div className="loading-indicator">Loading...</div>}>
          <TeamPage teamAbbrev={selectedTeamPage} onPlayerClick={(id, name, e) => navigateToPlayer(id, name, e)} onBack={navigateBackToGames} />
        </Suspense>
      )}

      {/* === PLAYER PAGE === */}
      {page === "player" && playerPageId && !cardData && (
        <Suspense fallback={<div className="loading-indicator">Loading...</div>}>
          <PlayerPage pitcherId={playerPageId} onBack={navigateBackToGames} onGameClick={navigateToGameCard} />
        </Suspense>
      )}

      {/* === GAMES PAGE (original daily view) === */}
      {page === "games" && !cardData && (
        <>
          {games.length > 0 && (
            <GameTabs games={games} selectedGame={selectedGame} onSelectGame={gp => {
              if (gp !== selectedGame && !isPopState.current) {
                pushState({ view: "game", selectedGame: gp }, "");
              }
              setSelectedGame(gp); setCardData(null);
            }} />
          )}

          {games.length > 0 && selectedGame && linescoreData && (
            <Scoreboard data={linescoreData} onInningClick={(inn, isTop) => setPbpModal({ inning: inn, isTop })} />
          )}

          {games.length > 0 && (
            <>
              <div className="controls-row">
                <button className={`view-btn${view === "pitcher-results" ? " active" : ""}`} onClick={() => setView("pitcher-results")}>
                  All Pitcher Results
                </button>
                <button className={`view-btn${view === "pitch-data" ? " active" : ""}`} onClick={() => setView("pitch-data")}>
                  All Pitch Data
                </button>
                <div className="toggle-group">
                  <label className="toggle-label">
                    <input type="checkbox" checked={spOnly} onChange={e => setSpOnly(e.target.checked)} />
                    <span>SP Only</span>
                  </label>
                  <label className="toggle-label">
                    <input type="checkbox" checked={splitByTeam} onChange={e => setSplitByTeam(e.target.checked)} />
                    <span>Separate by Team</span>
                  </label>
                  <label className="toggle-label">
                    <input type="checkbox" checked={top400Only} onChange={e => setTop400Only(e.target.checked)} />
                    <span>Top 400 Only</span>
                  </label>
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

      {loading && <div className="loading">Loading...</div>}
      {error && <div className="error">{error}</div>}

      {!loading && !error && !cardData && page === "games" && (
        <div className={splitByTeam ? "table-card-none" : "table-card"}>
          <div className="table-container">
            {view === "pitch-data" && (
              <PitchDataTable data={filteredPitchData} onPitcherClick={openCard} splitByTeam={splitByTeam} spOnly={spOnly} top400Names={TOP_400_NAMES} />
            )}
            {view === "pitcher-results" && (
              <PitcherResultsTable data={filteredResultsData} onPitcherClick={openCard} spOnly={spOnly} splitByTeam={splitByTeam} top400Names={TOP_400_NAMES} />
            )}
          </div>
        </div>
      )}

      {!loading && !error && cardData && (
        <>
          <div className="header">
            <h1 className="app-title" onClick={resetToDefault}>Live Pitch Dashboard</h1>
            <DatePicker date={date} onChange={setDate} />
            {headerNav}
          </div>
          {games.length > 0 && (
            <GameTabs games={games} selectedGame={selectedGame} onSelectGame={gp => {
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
                <Scoreboard data={linescoreData} pitcherId={cardData?.result?.pitcher_id} onInningClick={(inn, isTop) => setPbpModal({ inning: inn, isTop })} />
              )}
            </div>
            <PitcherCard cardData={cardData} date={date} linescoreData={linescoreData} onPlayerClick={(id, e) => navigateToPlayer(id, null, e)} onGameClick={() => {
              const gamePk = cardData?.result?.game_pk || selectedGame;
              if (gamePk) {
                setSelectedGame(gamePk);
                setCardData(null);
                pushState({ view: "game", selectedGame: gamePk }, "");
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
            reclassifyPitch(req).then(() => {
              setReclassifyPitch(null);
              // Refresh the pitcher card data
              const pid = cardData.pitcher_id || cardData.result?.pitcher_id;
              const gpk = cardData.game_pk || cardData.result?.game_pk || selectedGame;
              if (pid && gpk) {
                setLoading(true);
                fetchPitcherCard(date, pid, gpk)
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
