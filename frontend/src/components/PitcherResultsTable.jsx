import React, { useState, useMemo } from "react";
import { PITCHER_RESULTS_COLUMNS, PITCH_COLORS, TEAM_FULL_NAMES, displayAbbrev } from "../constants";
import { fmtPct, fmtInt } from "../utils/formatting";

const TEAM_SPLIT_HIDE = ["team", "opponent"];
const MOBILE_HIDE = ["hand"];

// IP string like "7.1" represents 7⅓ innings (decimal part = outs: 0, 1, or 2)
function ipToNumeric(ip) {
  if (ip == null) return 0;
  const parts = String(ip).split(".");
  const whole = parseInt(parts[0], 10) || 0;
  const thirds = parseInt(parts[1] || "0", 10) || 0;
  return whole + thirds / 3;
}

const DECISION_COLORS = {
  W: "#6DE95D",
  L: "#FF839B",
  HLD: "#55e8ff",
  S: "#ffc277",
  BS: "#FF5EDC",
};

export default function PitcherResultsTable({ data, date, onPitcherClick, spOnly, splitByTeam, isMobile, sortKey: sortKeyProp, onSortKeyChange, sortDir: sortDirProp, onSortDirChange, hiddenCols = [] }) {
  const [sortKeyLocal, setSortKeyLocal] = useState("ip");
  const [sortDirLocal, setSortDirLocal] = useState("desc");
  const sortKey = onSortKeyChange ? sortKeyProp : sortKeyLocal;
  const setSortKey = onSortKeyChange || setSortKeyLocal;
  const sortDir = onSortDirChange ? sortDirProp : sortDirLocal;
  const setSortDir = onSortDirChange || setSortDirLocal;

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const filtered = useMemo(() => {
    let rows = data || [];
    if (spOnly) {
      // Prefer backend-classified role (which handles opener swaps). Fall back to
      // per-team minimum appearance_order if rows don't carry a role yet.
      const hasRole = rows.some(r => r && r.role);
      if (hasRole) {
        rows = rows.filter(r => r.role === "SP");
      } else {
        const spMap = {};
        rows.forEach(r => {
          const k = r.team + "|" + r.game_pk;
          if (!(k in spMap) || r.appearance_order < spMap[k]) {
            spMap[k] = r.appearance_order;
          }
        });
        rows = rows.filter(r => r.appearance_order === spMap[r.team + "|" + r.game_pk]);
      }
    }
    return rows;
  }, [data, spOnly]);

  const sorted = useMemo(() => {
    if (sortKey) {
      return [...filtered].sort((a, b) => {
        let av = a[sortKey], bv = b[sortKey];
        if (av == null) return 1; if (bv == null) return -1;
        // IP sort: "7.1" means 7⅓ innings, not 7.1
        if (sortKey === "ip") {
          av = ipToNumeric(av);
          bv = ipToNumeric(bv);
        }
        // Sort team column by full name, not abbreviation
        if (sortKey === "team") { av = TEAM_FULL_NAMES[av] || av; bv = TEAM_FULL_NAMES[bv] || bv; }
        if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        const primary = sortDir === "asc" ? av - bv : bv - av;
        if (primary === 0 && sortKey === "er") {
          const aip = ipToNumeric(a.ip);
          const bip = ipToNumeric(b.ip);
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
    if (key === "csw_pct" || key === "strike_pct" || key === "par_pct") return 65;
    if (key === "velo") return 96;
    return 50;
  };

  const dim = (val) => (val === "--" || val === "-") ? <span style={{ color: "rgb(180, 185, 219)" }}>{val}</span> : val;

  const formatGameLine = (row) => {
    if (!row.opponent) return <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    const isHome = row.home_team && row.team === row.home_team;
    const homeAbbr = displayAbbrev(row.home_team) || row.home_team || "";
    const awayAbbr = displayAbbrev(row.away_team) || row.away_team || "";
    const homeScore = row.home_score != null ? row.home_score : "";
    const awayScore = row.away_score != null ? row.away_score : "";
    const gs = row.game_state || "";
    const decColor = DECISION_COLORS[row.decision];
    const baseHighlight = { color: "#d0d0d0", fontWeight: 600 };
    const decHighlight = decColor ? { color: decColor, fontWeight: 700 } : baseHighlight;
    const awayStyle = !isHome ? decHighlight : undefined;
    const homeStyle = isHome ? decHighlight : undefined;
    if (homeScore === "" && awayScore === "") {
      return <span style={{ fontSize: 12, color: "#a5a5a5" }}><span style={awayStyle}>{awayAbbr}</span> - <span style={homeStyle}>{homeAbbr}</span></span>;
    }
    return (
      <span style={{ fontSize: 12, color: "#a5a5a5" }}>
        <span style={awayStyle}>{awayAbbr} {awayScore}</span> - <span style={homeStyle}>{homeAbbr} {homeScore}</span>{gs ? ` (${gs})` : ""}
      </span>
    );
  };

  const renderVeloCell = (row) => {
    const v = row.velo;
    if (v == null) return <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    const pitch = row.velo_pitch;
    const color = PITCH_COLORS[pitch] || "#D9D9D9";
    const delta = row.velo_delta;
    let deltaEl = null;
    if (delta != null && !isNaN(delta)) {
      const cls = delta >= 1.0 ? "delta-up" : delta <= -1.0 ? "delta-down" : "delta-neutral";
      const text = `(${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`;
      deltaEl = <span className={`delta-value ${cls}`} style={{ marginLeft: 4 }}>{text}</span>;
    }
    return (
      <span style={{ whiteSpace: "nowrap" }}>
        <span style={{ color, fontWeight: 600 }}>{Number(v).toFixed(1)}</span>
        {deltaEl}
      </span>
    );
  };

  const renderCell = (row, col) => {
    const v = row[col.key];
    if (col.key === "pitcher") {
      if (!v) return <span className="pitcher-name" style={{ color: "rgb(180, 185, 219)" }}>--</span>;
      const isSP = row.role === "SP";
      const nameClass = isSP ? "pitcher-name pitcher-sp-highlight" : "pitcher-name";
      if (onPitcherClick && row.pitcher_id && row.game_pk && date) {
        return <a className={nameClass} href={`#card/${date}/${row.pitcher_id}/${row.game_pk}`} rel="nofollow" onClick={(e) => e.preventDefault()} onMouseDown={(e) => { if (e.button === 1) e.stopPropagation(); }} style={{ textDecoration: "none" }}>{v}</a>;
      }
      return <span className={nameClass}>{v}</span>;
    }
    if (col.key === "team") return displayAbbrev(v) || <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    if (col.key === "hand") {
      if (!v) return <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
      return v === "R" ? "RHP" : v === "L" ? "LHP" : v;
    }
    if (col.key === "opponent") return formatGameLine(row);
    if (col.key === "csw_pct" || col.key === "strike_pct" || col.key === "par_pct") return dim(fmtPct(v));
    if (col.key === "ip") return v != null ? v : <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    if (col.key === "velo") return renderVeloCell(row);
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
              {cols.map(c => {
                const classes = [];
                if (isMobile && c.key === "pitcher") classes.push("mobile-sticky-col");
                if (c.dividerRight) classes.push("col-divider-right");
                return (
                  <th key={c.key}
                    className={classes.join(" ")}
                    title={c.tooltip || undefined}
                    style={{ textAlign: c.align || "left", ...(isMobile && c.key === "pitcher" ? { left: 0, minWidth: 130 } : {}) }}
                    onClick={() => handleSort(c.key)}>
                    <span className={sortKey === c.key ? "sort-active" : ""}>{c.label}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="clickable-row"
                  onClick={(e) => onPitcherClick && onPitcherClick(r.pitcher_id, r.game_pk, e)}
                  onMouseDown={(e) => { if (e.button === 1 && onPitcherClick) { e.preventDefault(); onPitcherClick(r.pitcher_id, r.game_pk, e); } }}>
                {cols.map(c => {
                  const classes = [];
                  if (isMobile && c.key === "pitcher") classes.push("mobile-sticky-col");
                  if (c.dividerRight) classes.push("col-divider-right");
                  return (
                    <td key={c.key}
                      className={classes.join(" ")}
                      style={{ textAlign: c.align || "left", ...(isMobile && c.key === "pitcher" ? { left: 0, minWidth: 130 } : {}) }}>
                      {renderCell(r, c)}
                    </td>
                  );
                })}
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

  return renderTable(sorted, null, false);
}
