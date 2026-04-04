import React, { useState, useMemo } from "react";
import { PITCHER_RESULTS_COLUMNS, TEAM_FULL_NAMES, displayAbbrev } from "../constants";
import { fmtPct, fmtInt } from "../utils/formatting";
import { isTop400 } from "../top400";

const TEAM_SPLIT_HIDE = ["team", "opponent"];
const MOBILE_HIDE = ["hand"];
const DEFAULT_HIDDEN = ["team", "hand"];

export default function PitcherResultsTable({ data, onPitcherClick, spOnly, splitByTeam, top400Names, isMobile, sortKey: sortKeyProp, onSortKeyChange, sortDir: sortDirProp, onSortDirChange }) {
  const [sortKeyLocal, setSortKeyLocal] = useState(null);
  const [sortDirLocal, setSortDirLocal] = useState("asc");
  const sortKey = onSortKeyChange ? sortKeyProp : sortKeyLocal;
  const setSortKey = onSortKeyChange || setSortKeyLocal;
  const sortDir = onSortDirChange ? sortDirProp : sortDirLocal;
  const setSortDir = onSortDirChange || setSortDirLocal;
  const [hiddenCols, setHiddenCols] = useState(DEFAULT_HIDDEN);
  const [showColFilter, setShowColFilter] = useState(false);

  const toggleCol = (key) => {
    setHiddenCols(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const filtered = useMemo(() => {
    let rows = data || [];
    if (spOnly) {
      const spMap = {};
      rows.forEach(r => {
        const k = r.team + "|" + r.game_pk;
        if (!(k in spMap) || r.appearance_order < spMap[k]) {
          spMap[k] = r.appearance_order;
        }
      });
      rows = rows.filter(r => r.appearance_order === spMap[r.team + "|" + r.game_pk]);
    }
    return rows;
  }, [data, spOnly]);

  const sorted = useMemo(() => {
    if (sortKey) {
      return [...filtered].sort((a, b) => {
        let av = a[sortKey], bv = b[sortKey];
        if (av == null) return 1; if (bv == null) return -1;
        // Sort team column by full name, not abbreviation
        if (sortKey === "team") { av = TEAM_FULL_NAMES[av] || av; bv = TEAM_FULL_NAMES[bv] || bv; }
        if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        const primary = sortDir === "asc" ? av - bv : bv - av;
        if (primary === 0 && sortKey === "er") {
          const aip = parseFloat(a.ip) || 0;
          const bip = parseFloat(b.ip) || 0;
          return bip - aip; // higher IP first on ER tie
        }
        return primary;
      });
    }
    return [...filtered].sort((a, b) => {
      if (a.team !== b.team) return (TEAM_FULL_NAMES[a.team] || a.team).localeCompare(TEAM_FULL_NAMES[b.team] || b.team);
      return a.appearance_order - b.appearance_order;
    });
  }, [filtered, sortKey, sortDir]);

  // Compute max pitcher name width across ALL data for consistent team card sizing
  const maxPitcherWidth = useMemo(() => {
    if (!splitByTeam) return 170;
    const names = (data || []).map(r => r.pitcher).filter(Boolean);
    if (!names.length) return 170;
    const maxLen = Math.max(...names.map(n => n.length));
    return Math.max(170, Math.ceil(maxLen * 7.5) + 20);
  }, [data, splitByTeam]);

  const getColWidth = (key) => {
    if (key === "pitcher") return isMobile ? 130 : maxPitcherWidth;
    if (key === "hand") return 52;
    if (key === "opponent") return 175;
    if (key === "csw_pct") return 65;
    return 50;
  };

  const dim = (val) => (val === "--" || val === "-") ? <span style={{ color: "rgb(180, 185, 219)" }}>{val}</span> : val;

  const formatGameLine = (row) => {
    if (!row.opponent) return <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    const isHome = row.home_team && row.team === row.home_team;
    const prefix = isHome ? "vs." : "@";
    const teamAbbr = displayAbbrev(row.team) || row.team;
    const oppAbbr = displayAbbrev(row.opponent) || row.opponent;
    const homeScore = row.home_score != null ? row.home_score : "";
    const awayScore = row.away_score != null ? row.away_score : "";
    const teamScore = isHome ? homeScore : awayScore;
    const oppScore = isHome ? awayScore : homeScore;
    const gs = row.game_state || "";
    if (teamScore === "" && oppScore === "") {
      return `${teamAbbr} ${prefix} ${oppAbbr}`;
    }
    return `${teamAbbr} ${teamScore} ${prefix} ${oppAbbr} ${oppScore}${gs ? ` (${gs})` : ""}`;
  };

  const renderCell = (row, col) => {
    const v = row[col.key];
    if (col.key === "pitcher") {
      if (!v) return <span className="pitcher-name" style={{ color: "rgb(180, 185, 219)" }}>--</span>;
      const isTop = top400Names && isTop400(v);
      const nameClass = top400Names ? (isTop ? "pitcher-name pitcher-top400" : "pitcher-name") : "pitcher-name";
      return <span className={nameClass}>{v}</span>;
    }
    if (col.key === "team") return displayAbbrev(v) || <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    if (col.key === "hand") {
      if (!v) return <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
      return v === "R" ? "RHP" : v === "L" ? "LHP" : v;
    }
    if (col.key === "opponent") return formatGameLine(row);
    if (col.key === "csw_pct") return dim(fmtPct(v));
    if (col.key === "ip") return v != null ? v : <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    return dim(fmtInt(v));
  };

  if (!sorted.length) return <div className="no-data">No pitcher results available.</div>;

  // Build opponent label for team header (e.g. "@ NYY" or "vs. KCR")
  const getTeamOppLabel = (rows) => {
    const first = rows[0];
    if (!first || !first.opponent) return "";
    const prefix = first.home_team && first.team === first.home_team ? "vs." : "@";
    return `${prefix} ${displayAbbrev(first.opponent)}`;
  };

  // Filterable columns (exclude "pitcher" — always visible)
  const filterableCols = PITCHER_RESULTS_COLUMNS.filter(c => c.key !== "pitcher");

  const renderTable = (rows, teamLabel, isCard) => {
    let cols = isCard ? PITCHER_RESULTS_COLUMNS.filter(c => !TEAM_SPLIT_HIDE.includes(c.key)) : PITCHER_RESULTS_COLUMNS;
    if (!isCard) cols = cols.filter(c => !hiddenCols.includes(c.key));
    if (isMobile) cols = cols.filter(c => !MOBILE_HIDE.includes(c.key));
    const oppLabel = isCard ? getTeamOppLabel(rows) : "";
    const totalWidth = isCard && !isMobile ? cols.reduce((sum, c) => sum + getColWidth(c.key), 0) : undefined;
    return (
      <div className={isCard ? "team-card-wrapper" : ""} key={teamLabel || "all"} style={isCard && !isMobile ? { width: totalWidth + "px" } : undefined}>
        {teamLabel && (
          <div className="team-split-header">
            {teamLabel}
            {oppLabel && <span className="team-split-opp"> {oppLabel}</span>}
          </div>
        )}
        <div className={isCard ? "team-card" : "table-wrapper"}>
        <table style={isCard && !isMobile ? { tableLayout: "fixed", width: "100%" } : undefined}>
          {isCard && !isMobile && (
            <colgroup>
              {cols.map(c => <col key={c.key} style={{ width: getColWidth(c.key) + "px" }} />)}
            </colgroup>
          )}
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c.key}
                  className={isMobile && c.key === "pitcher" ? "mobile-sticky-col" : ""}
                  style={{ textAlign: c.align || "left", ...(isMobile && c.key === "pitcher" ? { left: 0, minWidth: 130 } : {}) }}
                  onClick={() => handleSort(c.key)}>
                  <span className={sortKey === c.key ? "sort-active" : ""}>{c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="clickable-row"
                  onClick={(e) => onPitcherClick && onPitcherClick(r.pitcher_id, r.game_pk, e)}
                  onMouseDown={(e) => { if (e.button === 1 && onPitcherClick) { e.preventDefault(); onPitcherClick(r.pitcher_id, r.game_pk, e); } }}>
                {cols.map(c => (
                  <td key={c.key}
                    className={isMobile && c.key === "pitcher" ? "mobile-sticky-col" : ""}
                    style={{ textAlign: c.align || "left", ...(isMobile && c.key === "pitcher" ? { left: 0, minWidth: 130 } : {}) }}>
                    {renderCell(r, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    );
  };

  if (splitByTeam) {
    const teamOrder = [];
    const teamMap = {};
    sorted.forEach(r => {
      const k = r.team || "Unknown";
      if (!teamMap[k]) { teamMap[k] = []; teamOrder.push(k); }
      teamMap[k].push(r);
    });
    teamOrder.sort((a, b) => (TEAM_FULL_NAMES[a] || a).localeCompare(TEAM_FULL_NAMES[b] || b));
    return <div className="team-cards-grid">{teamOrder.map(team => renderTable(teamMap[team], TEAM_FULL_NAMES[team] || team, true))}</div>;
  }

  return (
    <div>
      <div className="col-filter-bar">
        <button className="col-filter-toggle" onClick={() => setShowColFilter(v => !v)}>
          Columns {showColFilter ? "\u25B2" : "\u25BC"}
        </button>
        {showColFilter && (
          <div className="col-filter-checkboxes">
            {filterableCols.map(c => (
              <label key={c.key} className="col-filter-label">
                <input type="checkbox" checked={!hiddenCols.includes(c.key)} onChange={() => toggleCol(c.key)} />
                {c.label}
              </label>
            ))}
          </div>
        )}
      </div>
      {renderTable(sorted, null, false)}
    </div>
  );
}
