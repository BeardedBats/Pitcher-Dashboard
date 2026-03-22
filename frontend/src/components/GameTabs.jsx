import React from "react";
import { displayAbbrev } from "../constants";

function formatLabel(label) {
  // "SD @ CIN" → "SDP @ CIN"
  return label.replace(/\b([A-Z]{2,3})\b/g, (m) => displayAbbrev(m));
}

const NOT_STARTED_STATUSES = ["Scheduled", "Pre-Game", "Warmup", "Postponed", "Delayed Start", "Cancelled", "Suspended"];

function isNotStarted(status) {
  return NOT_STARTED_STATUSES.includes(status);
}

export default function GameTabs({ games, selectedGame, onSelectGame }) {
  return (
    <div className="game-tabs">
      <div
        className={`game-tab${selectedGame === null ? " active" : ""}`}
        onClick={() => onSelectGame(null)}
        role="button" tabIndex={0}
      >
        All Games
      </div>
      {games.map(g => {
        const notStarted = isNotStarted(g.status);
        const noData = g.has_data === false && !notStarted;
        return (
          <div
            key={g.game_pk}
            className={`game-tab${selectedGame === g.game_pk ? " active" : ""}${noData ? " no-data" : ""}${notStarted ? " not-started" : ""}`}
            onClick={() => !notStarted && onSelectGame(g.game_pk)}
            title={notStarted ? `Game hasn't started (${g.status})` : noData ? "Pitch data not yet available" : ""}
            role="button" tabIndex={notStarted ? -1 : 0}
          >
            {formatLabel(g.label)}
          </div>
        );
      })}
    </div>
  );
}
