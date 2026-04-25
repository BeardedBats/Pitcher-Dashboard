import React from "react";
import { displayTeamAbbrev } from "../constants";

const NOT_STARTED_STATUSES = ["Scheduled", "Pre-Game", "Delayed Start", "Cancelled", "Suspended"];

function isNotStarted(status) {
  return NOT_STARTED_STATUSES.includes(status);
}

function isWarmup(status) {
  return status === "Warmup";
}

function isLive(status, abstractState) {
  return abstractState === "Live" || ["In Progress", "Manager challenge"].includes(status);
}

function isFinal(status, abstractState) {
  return abstractState === "Final" || status === "Final" || status === "Game Over" || status === "Completed Early";
}

function ordinalInning(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function GameTabs({ games, selectedGame, onSelectGame, level = "mlb", onSelectLevel }) {
  const [viewMode, setViewMode] = React.useState("all");

  const handleAllGames = () => {
    setViewMode("all");
    onSelectGame(null);
  };

  const handleViewGames = () => {
    if (viewMode === "games") {
      setViewMode("all");
      onSelectGame(null);
    } else {
      setViewMode("games");
    }
  };

  return (
    <div className="game-tabs-container">
      <div className="games-tabs-toolbar">
        {onSelectLevel && (
          <>
            <div className="level-tabs">
              <button
                type="button"
                className={`level-tab${level === "mlb" ? " active" : ""}`}
                onClick={() => onSelectLevel("mlb")}
              >MLB</button>
              <button
                type="button"
                className={`level-tab${level === "aaa" ? " active" : ""}`}
                onClick={() => onSelectLevel("aaa")}
              >AAA</button>
            </div>
            <span className="games-tabs-divider" aria-hidden="true">|</span>
          </>
        )}
        <div className="game-tabs-switcher">
          <div
            className={`game-tab-switch${viewMode === "all" ? " active" : ""}`}
            onClick={handleAllGames}
            role="button" tabIndex={0}
          >
            All Games
          </div>
          <div
            className={`game-tab-switch${viewMode === "games" ? " active" : ""}`}
            onClick={handleViewGames}
            role="button" tabIndex={0}
          >
            View Games
          </div>
        </div>
      </div>
      {viewMode === "games" && (
        <div className="game-tabs">
      {games.map(g => {
        const notStarted = isNotStarted(g.status);
        const warmup = isWarmup(g.status);
        const live = isLive(g.status, g.abstract_state);
        const final_ = isFinal(g.status, g.abstract_state);
        const noData = g.has_data === false && !notStarted && !warmup;
        const pregame = notStarted || warmup;

        const awayAbbr = displayTeamAbbrev(g.away_team, level);
        const homeAbbr = displayTeamAbbrev(g.home_team, level);
        const awayWinning = (live || final_) && g.away_score != null && g.home_score != null && g.away_score > g.home_score;
        const homeWinning = (live || final_) && g.away_score != null && g.home_score != null && g.home_score > g.away_score;

        // Game state line
        let gameState = "";
        if (warmup) {
          gameState = "Warmup";
        } else if (notStarted) {
          gameState = g.game_time_et || "";
        } else if (live) {
          const half = g.inning_half === "Top" ? "Top" : "Bot";
          gameState = `${half} ${ordinalInning(g.current_inning || 1)}`;
        } else if (final_) {
          gameState = "Final";
        }

        const clickable = !notStarted || warmup;

        return (
          <div
            key={g.game_pk}
            className={`game-tab${selectedGame === g.game_pk ? " active" : ""}${noData ? " no-data" : ""}${(notStarted && !warmup) ? " not-started" : ""}`}
            onClick={() => clickable && onSelectGame(g.game_pk)}
            title={notStarted && !warmup ? `Game hasn't started (${g.status})` : noData ? "Pitch data not yet available" : ""}
            role="button" tabIndex={clickable ? 0 : -1}
          >
            {/* Line 1: Starting Pitchers */}
            <div className="game-tab__pitchers">
              {g.away_sp || "TBD"} vs. {g.home_sp || "TBD"}
            </div>
            {/* Line 2: Teams with scores */}
            <div className="game-tab__teams">
              <span className={awayWinning ? "game-tab__winner" : ""}>
                {awayAbbr}{(live || final_) && g.away_score != null ? ` ${g.away_score}` : ""}
              </span>
              <span className="game-tab__sep">{pregame ? " vs. " : " – "}</span>
              <span className={homeWinning ? "game-tab__winner" : ""}>
                {(live || final_) && g.home_score != null ? `${g.home_score} ` : ""}{homeAbbr}
              </span>
            </div>
            {/* Line 3: Game state */}
            {gameState && (
              <div className={`game-tab__state${final_ ? " game-tab__state--final" : ""}`}>
                {gameState}
              </div>
            )}
          </div>
        );
      })}
        </div>
      )}
    </div>
  );
}
