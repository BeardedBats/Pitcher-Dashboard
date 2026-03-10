import React from "react";
import { displayAbbrev } from "../constants";

function formatLabel(label) {
  // "SD @ CIN" → "SDP @ CIN"
  return label.replace(/\b([A-Z]{2,3})\b/g, (m) => displayAbbrev(m));
}

const NOT_STARTED_STATUSES = ["Scheduled", "Pre-Game", "Warmup", "Postponed", "Delayed Start"];

function isNotStarted(status) {
  return NOT_STARTED_STATUSES.includes(status);
}

export default function GameTabs({ games, selectedGame, onSelectGame }) {
  return (
    <div className="game-tabs">
      <button
        className={`game-tab${selectedGame === null ? " active" : ""}`}
        onClick={() => onSelectGame(null)}
      >
        All Games
      </button>
      {games.map(g => {
        const notStarted = isNotStarted(g.status);
        const noData = g.has_data === false && !notStarted;
        const disabled = notStarted;
        return (
          <button
            key={g.game_pk}
            className={`game-tab${selectedGame === g.game_pk ? " active" : ""}${noData ? " no-data" : ""}${disabled ? " not-started" : ""}`}
            onClick={() => !disabled && onSelectGame(g.game_pk)}
            title={disabled ? `Game hasn't started (${g.status})` : noData ? "Pitch data not yet available" : ""}
            disabled={disabled}
          >
            {formatLabel(g.label)}
          </button>
        );
      })}
    </div>
  );
}
