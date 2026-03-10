import React, { useState, useEffect, useMemo, useCallback } from "react";
import DatePicker from "./components/DatePicker";
import GameTabs from "./components/GameTabs";
import PitchDataTable from "./components/PitchDataTable";
import PitcherResultsTable from "./components/PitcherResultsTable";
import PitcherCard from "./components/PitcherCard";
import Scoreboard from "./components/Scoreboard";
import PlayByPlayModal from "./components/PlayByPlayModal";
import ReclassifyModal from "./components/ReclassifyModal";
import SearchBar from "./components/SearchBar";
import LeaderboardPage from "./components/LeaderboardPage";
import TeamPage from "./components/TeamPage";
import PlayerPage from "./components/PlayerPage";
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

  // Track whether we're currently handling a popstate event to avoid pushing duplicate history
  const isPopState = React.useRef(false);

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
    if (current) {
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
      // Restore scroll position
      if (state?.scrollY != null) {
        setTimeout(() => window.scrollTo(0, state.scrollY), 50);
      }
      setTimeout(() => { isPopState.current = false; }, 0);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [date]);

  useEffect(() => {
    if (!date) return;  // Wait for smart default date to resolve
    // Skip if initial load already populated games/data
    if (initialLoadDone.current) {
      initialLoadDone.current = false;
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

  const openCard = (pitcherId, gamePk) => {
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

  const navigateToPlayer = (pitcherId) => {
    setPage("player");
    setPlayerPageId(pitcherId);
    setCardData(null);
    pushState({ view: "list", page: "player", pitcherId }, "");
  };

  const navigateToGameCard = (gameDate, pitcherId, gamePk) => {
    // Navigate from player page game log to the pitcher card for that game
    setPage("games");
    setDate(gameDate);
    setSelectedGame(gamePk);
    setLoading(true);
    fetchPitcherCard(gameDate, pitcherId, gamePk)
      .then(cd => {
        setCardData(cd);
        setLoading(false);
        pushState({ view: "card", selectedGame: gamePk, pitcherId, gamePk }, "");
      })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  const navigateBackToGames = () => {
    setPage("games");
    setCardData(null);
    pushState({ view: "list", page: "games", selectedGame: null }, "");
  };

  // Header nav component (reused in both header renders)
  const headerNav = (
    <div className="header-nav">
      <SearchBar onSelectPlayer={(id) => navigateToPlayer(id)} />
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
    </div>
  );

  return (
    <div className="app">
      {/* === HEADER (always shown when no card view) === */}
      {!cardData && (
        <div className="header">
          <h1 className="app-title" onClick={resetToDefault}>Live Pitch Dashboard</h1>
          {page === "games" && <DatePicker date={date} onChange={setDate} />}
          {headerNav}
        </div>
      )}

      {/* === LEADERBOARD PAGE === */}
      {page === "leaderboard" && !cardData && (
        <LeaderboardPage onPlayerClick={(id) => navigateToPlayer(id)} onBack={navigateBackToGames} />
      )}

      {/* === TEAM PAGE === */}
      {page === "team" && selectedTeamPage && !cardData && (
        <TeamPage teamAbbrev={selectedTeamPage} onPlayerClick={(id) => navigateToPlayer(id)} onBack={navigateBackToGames} />
      )}

      {/* === PLAYER PAGE === */}
      {page === "player" && playerPageId && !cardData && (
        <PlayerPage pitcherId={playerPageId} onBack={navigateBackToGames} onGameClick={navigateToGameCard} />
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
            <PitcherCard cardData={cardData} date={date} linescoreData={linescoreData} onPlayerClick={(id) => navigateToPlayer(id)} onGameClick={() => {
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
