import React, { useState, useMemo } from "react";
import { PITCH_COLORS, PITCH_DATA_COLUMNS, TEAM_FULL_NAMES, displayAbbrev } from "../constants";

const TEAM_SPLIT_HIDE = ["team", "opponent"];
import { getCellHighlight, fmt, fmtPct, fmtInt, getVeloEmphasis, getIHBEmphasis } from "../utils/formatting";
import { isTop400 } from "../top400";

const DELTA_KEYS = ["velo", "usage", "usage_vs_r", "usage_vs_l", "ihb", "ext", "ivb"];
const DELTA_THRESHOLDS = {
  velo: { up: 1.0, down: -1.0 },
  usage: { up: 5, down: -5 },
  usage_vs_r: { up: 5, down: -5 },
  usage_vs_l: { up: 5, down: -5 },
  ivb: { up: 2, down: -2 },
  ihb: { up: 2, down: -2 },
  ext: { up: 0.3, down: -0.2 },
};

function getDeltaClass(key, delta) {
  const t = DELTA_THRESHOLDS[key];
  if (!t) return "";
  if (delta >= t.up) return "delta-up";
  if (delta <= t.down) return "delta-down";
  return "";
}

// Fastball types where +iVB = elite (red)
const FASTBALL_TYPES = ["Four-Seamer", "Sinker"];
// Pitch types where +iHB (arm-side) = red, -iHB (glove-side) = blue
const IHB_ARM_SIDE_TYPES = ["Four-Seamer", "Sinker", "Changeup"];

const MOBILE_HIDE_COLS = ["hand", "team", "opponent"];

export default function PitchDataTable({ data, date, onPitcherClick, columns, splitByTeam, spOnly, pitcherHand, sortable = true, showChange, seasonAvgs, batterFilter, top400Names, isMobile, sortKey: sortKeyProp, onSortKeyChange, sortDir: sortDirProp, onSortDirChange, selectedPitchType, onPitchTypeClick }) {
  const [sortKeyLocal, setSortKeyLocal] = useState(null);
  const [sortDirLocal, setSortDirLocal] = useState("asc");
  const sortKey = onSortKeyChange ? sortKeyProp : sortKeyLocal;
  const setSortKey = onSortKeyChange || setSortKeyLocal;
  const sortDir = onSortDirChange ? sortDirProp : sortDirLocal;
  const setSortDir = onSortDirChange || setSortDirLocal;
  const cols = columns || PITCH_DATA_COLUMNS;

  const handleSort = (key) => {
    if (!sortable) return;
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
    if (sortable && sortKey) {
      return [...filtered].sort((a, b) => {
        let av = a[sortKey], bv = b[sortKey];
        if (av == null) return 1; if (bv == null) return -1;
        // Sort team column by full name, not abbreviation
        if (sortKey === "team") { av = TEAM_FULL_NAMES[av] || av; bv = TEAM_FULL_NAMES[bv] || bv; }
        if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        return sortDir === "asc" ? av - bv : bv - av;
      });
    }
    if (!sortable) return filtered;
    return [...filtered].sort((a, b) => {
      if (a.team !== b.team) return (TEAM_FULL_NAMES[a.team] || a.team).localeCompare(TEAM_FULL_NAMES[b.team] || b.team);
      if (a.appearance_order !== b.appearance_order) return a.appearance_order - b.appearance_order;
      return (a.pitch_name || "").localeCompare(b.pitch_name || "");
    });
  }, [filtered, sortKey, sortDir, sortable]);

  const pctKeys = ["usage", "usage_vs_r", "usage_vs_l", "strike_pct", "cs_pct", "swstr_pct", "csw_pct"];
  const gradientKeys = ["ivb", "ext"];
  const HYPHEN_TOTAL_KEYS = new Set(["velo", "usage", "ivb", "ihb", "havaa", "ext"]);

  // Compute totals row from data (weighted averages for pct columns)
  const computeTotals = (rows) => {
    if (!rows || rows.length === 0) return null;
    let totalCount = 0, totalVsR = 0, totalVsL = 0;
    let totalStrikes = 0, totalCS = 0, totalWhiffs = 0, totalCSW = 0;
    for (const r of rows) {
      const n = r.count || 0;
      totalCount += n;
      totalVsR += r.count_vs_r || 0;
      totalVsL += r.count_vs_l || 0;
      if (r.strike_pct != null) totalStrikes += (r.strike_pct / 100) * n;
      if (r.cs_pct != null) totalCS += (r.cs_pct / 100) * n;
      if (r.swstr_pct != null) totalWhiffs += (r.swstr_pct / 100) * n;
      if (r.csw_pct != null) totalCSW += (r.csw_pct / 100) * n;
    }
    return {
      pitch_name: "Total",
      count: totalCount,
      usage_vs_r: totalCount > 0 ? Math.round((totalVsR / totalCount) * 100) : 0,
      usage_vs_l: totalCount > 0 ? Math.round((totalVsL / totalCount) * 100) : 0,
      strike_pct: totalCount > 0 ? Math.round((totalStrikes / totalCount) * 100) : 0,
      cs_pct: totalCount > 0 ? Math.round((totalCS / totalCount) * 100) : 0,
      swstr_pct: totalCount > 0 ? Math.round((totalWhiffs / totalCount) * 100) : 0,
      csw_pct: totalCount > 0 ? Math.round((totalCSW / totalCount) * 100) : 0,
    };
  };

  const dim = (val) => (val === "--" || val === "-") ? <span style={{ color: "rgb(180, 185, 219)" }}>{val}</span> : val;

  // Determine which usage column should show deltas based on batter filter
  const shouldShowDelta = (key) => {
    if (!showChange) return false;
    if (key === "usage") return !batterFilter || batterFilter === "all";
    if (key === "usage_vs_l") return batterFilter === "L";
    if (key === "usage_vs_r") return batterFilter === "R";
    // All other delta keys always show
    if (DELTA_KEYS.includes(key) && key !== "usage_vs_l" && key !== "usage_vs_r") return true;
    return false;
  };

  // Check if season averages have data for ANY pitch in the current table.
  // If no pitch matches, skip all delta spacing so the table stays compact.
  const hasAnySeasonData = useMemo(() => {
    if (!showChange || !seasonAvgs) return false;
    const pitchNames = (data || []).map(r => r.pitch_name).filter(Boolean);
    return pitchNames.some(name => seasonAvgs[name]);
  }, [showChange, seasonAvgs, data]);

  // Compute max pitcher name width across ALL data for consistent team card sizing
  const maxPitcherWidth = useMemo(() => {
    if (!splitByTeam) return 170;
    const names = (data || []).map(r => r.pitcher).filter(Boolean);
    if (!names.length) return 170;
    const maxLen = Math.max(...names.map(n => n.length));
    // ~7.5px per char at 14px DM Sans font-weight 500 + 20px padding
    return Math.max(170, Math.ceil(maxLen * 7.5) + 20);
  }, [data, splitByTeam]);

  // Placeholder span keeps column width stable when some rows lack delta data
  const deltaPlaceholder = <span className="delta-placeholder" />;
  const deltaNew = <span className="delta-value delta-new">(NEW)</span>;

  const renderDelta = (key, currentVal, pitchName, hand) => {
    if (!shouldShowDelta(key)) return null;
    if (!hasAnySeasonData) return null;
    if (!seasonAvgs || !pitchName) return deltaPlaceholder;
    const avg = seasonAvgs[pitchName];
    // Pitch not in previous season — show (NEW) on velo column only, placeholder on others
    if (!avg) {
      if (key === "velo") return deltaNew;
      return deltaPlaceholder;
    }
    // Resolve season value for this delta key.
    // For usage_vs_l / usage_vs_r, prefer the hand-split value from the
    // season payload if present (season-to-date mode provides these, and
    // the previous-season endpoint now does too). Fall back to overall
    // `usage` for older cached payloads that don't include the split.
    let seasonVal;
    if (key === "usage_vs_l") {
      seasonVal = avg.usage_vs_l != null ? avg.usage_vs_l : avg.usage;
    } else if (key === "usage_vs_r") {
      seasonVal = avg.usage_vs_r != null ? avg.usage_vs_r : avg.usage;
    } else {
      seasonVal = avg[key];
    }
    if (seasonVal == null) return deltaPlaceholder;
    if (key === "ihb") seasonVal = -seasonVal;
    const delta = currentVal - seasonVal;
    const usageKeys = ["usage", "usage_vs_r", "usage_vs_l"];
    const text = usageKeys.includes(key)
      ? `(${delta >= 0 ? "+" : ""}${Math.round(delta)}%)`
      : `(${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`;

    // For iHB/iVB deltas, use directional coloring with prev/current context
    if (key === "ihb") {
      const color = getIhbDeltaColor(delta, pitchName, hand, seasonVal, currentVal);
      if (color) return <span className="delta-value" style={{ color }}>{text}</span>;
    }
    if (key === "ivb") {
      const color = getIvbDeltaColor(delta, pitchName, seasonVal, currentVal);
      if (color) return <span className="delta-value" style={{ color }}>{text}</span>;
    }

    const cls = getDeltaClass(key, delta);
    if (!cls) return <span className="delta-value delta-neutral">{text}</span>;
    return <span className={`delta-value ${cls}`}>{text}</span>;
  };

  // Color logic for iHB DELTA values (change from season avg)
  // Four-seamer special: Cut zone (|val| < 6): more cut (negative) = red, less cut (positive) = blue
  //                      Run zone (|val| > 6): more run (positive) = red, less run (negative) = blue
  // Others: RHP arm-side = Red+/Blue-, LHP arm-side = Red-/Blue+
  const getIhbDeltaColor = (delta, pitchName, hand, prevVal, currentVal) => {
    if (delta == null || isNaN(delta) || delta === 0) return null;
    if (Math.abs(delta) < 1.0) return null;
    const isPositive = delta > 0;

    if (pitchName === "Four-Seamer" && prevVal != null && currentVal != null) {
      const absPrev = Math.abs(prevVal);
      const absCur = Math.abs(currentVal);
      if (absPrev < 6 || absCur < 6) {
        // Cut zone: negative delta = more cut = elite (red)
        return isPositive ? "#55e8ff" : "#FF839B";
      }
      if (absPrev > 6 && absCur > 6) {
        // Run zone: positive delta = more run = elite (red)
        return isPositive ? "#FF839B" : "#55e8ff";
      }
    }

    const isArmSide = IHB_ARM_SIDE_TYPES.includes(pitchName);
    const isLHP = hand === "L";
    const armSidePositiveIsRed = isArmSide !== isLHP;
    if (armSidePositiveIsRed) {
      return isPositive ? "#FF839B" : "#55e8ff";
    } else {
      return isPositive ? "#55e8ff" : "#FF839B";
    }
  };

  // Color logic for iVB DELTA values (change from season avg)
  // Sinker special: If prev > 10 OR new > 8 → red for increase, blue for decrease
  //                 If prev < 10 OR new < 8 → blue for increase, red for decrease
  // FF: + = red, - = blue. Others: + = blue, - = red
  const getIvbDeltaColor = (delta, pitchName, prevVal, currentVal) => {
    if (delta == null || isNaN(delta) || delta === 0) return null;
    if (Math.abs(delta) < 1.0) return null;
    const isPositive = delta > 0;

    if (pitchName === "Sinker" && prevVal != null && currentVal != null) {
      if (prevVal > 10 || currentVal > 8) {
        return isPositive ? "#FF839B" : "#55e8ff";
      }
      if (prevVal < 10 || currentVal < 8) {
        return isPositive ? "#55e8ff" : "#FF839B";
      }
    }

    const isFastball = FASTBALL_TYPES.includes(pitchName);
    if (isFastball) {
      return isPositive ? "#FF839B" : "#55e8ff";
    } else {
      return isPositive ? "#55e8ff" : "#FF839B";
    }
  };

  const NARROW_DELTA_KEYS = new Set(["velo", "ext", "ivb", "ihb"]);

  // Value + delta inline: td's text-align:right aligns the whole group.
  // cell-delta is a fixed-width inline-block so its ) aligns with the header.
  const cellDelta = (valEl, deltaEl, colKey) => {
    if (!showChange || !hasAnySeasonData || deltaEl === null) return valEl;
    if (isMobile) return valEl; // Hide deltas on mobile
    const cls = NARROW_DELTA_KEYS.has(colKey) ? "cell-delta cell-delta-narrow" : "cell-delta";
    return <span className="cell-with-delta">{valEl}<span className={cls}>{deltaEl || deltaPlaceholder}</span></span>;
  };

  // Helper to get emphasis frame for velo and ihb columns
  const getEmphasisFrame = (key, value, pitchName, hand) => {
    if (key === "velo") {
      return getVeloEmphasis(pitchName, value);
    }
    if (key === "ihb") {
      return getIHBEmphasis(pitchName, value, hand);
    }
    return getCellHighlight(key, value, pitchName);
  };

  const renderCell = (row, col) => {
    const v = row[col.key];
    if (col.key === "pitcher") {
      if (!v) return <span className="pitcher-name" style={{ color: "rgb(180, 185, 219)" }}>--</span>;
      const isTop = top400Names && isTop400(v);
      const nameClass = top400Names ? (isTop ? "pitcher-name pitcher-top400" : "pitcher-name") : "pitcher-name";
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
    if (col.key === "opponent") {
      if (!v) return <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
      const prefix = row.home_team && row.team === row.home_team ? "vs." : "@";
      return `${prefix} ${displayAbbrev(v)}`;
    }
    if (col.key === "pitch_name") {
      const c = PITCH_COLORS[v] || "#D9D9D9";
      return <span style={{ color: c, fontWeight: 600 }}>{v}</span>;
    }
    if (col.key === "count" || col.key === "whiffs") return dim(fmtInt(v));

    // Velo — emphasis frames for elite/poor
    if (col.key === "velo") {
      const fmtVal = fmt(v);
      const hl = getVeloEmphasis(row.pitch_name, v);
      const delta = (v != null && !isNaN(v)) ? renderDelta(col.key, Number(v), row.pitch_name) : null;
      if (hl) return cellDelta(<span className={`highlight-cell hl-${hl}`}>{fmtVal}</span>, delta, col.key);
      return cellDelta(dim(fmtVal), delta, col.key);
    }

    // iHB — negate display, red/blue frames for extremes only
    if (col.key === "ihb") {
      const negated = v != null && !isNaN(v) ? -Number(v) : v;
      const fmtVal = fmt(negated);
      const hand = row.hand || pitcherHand;
      // Guard: no color when |value| < 1.0
      const hl = (negated != null && !isNaN(negated) && Math.abs(negated) >= 1.0)
        ? getEmphasisFrame(col.key, negated, row.pitch_name, hand)
        : null;
      const delta = (negated != null && !isNaN(negated)) ? renderDelta("ihb", negated, row.pitch_name, hand) : null;
      if (hl) return cellDelta(<span className={`highlight-cell hl-${hl}`}>{fmtVal}</span>, delta, col.key);
      return cellDelta(dim(fmtVal), delta, col.key);
    }

    // iVB — red/blue frames for extremes only
    if (col.key === "ivb") {
      const fmtVal = fmt(v);
      // Guard: no color when |value| < 1.0
      const hl = (v != null && !isNaN(v) && Math.abs(v) >= 1.0)
        ? getCellHighlight(col.key, v, row.pitch_name)
        : null;
      const delta = (v != null && !isNaN(v)) ? renderDelta("ivb", Number(v), row.pitch_name) : null;
      if (hl) return cellDelta(<span className={`highlight-cell hl-${hl}`}>{fmtVal}</span>, delta, col.key);
      return cellDelta(dim(fmtVal), delta, col.key);
    }

    // Delta-enabled columns (velo, usage, ext, usage_vs_r, usage_vs_l)
    if (DELTA_KEYS.includes(col.key)) {
      if (pctKeys.includes(col.key)) {
        const display = dim(fmtPct(v));
        const delta = (v != null && !isNaN(v)) ? renderDelta(col.key, Number(v), row.pitch_name) : null;
        return cellDelta(display, delta, col.key);
      }
      const fmtVal = fmt(v);
      if (gradientKeys.includes(col.key)) {
        // Guard: no color when |value| < 1.0
        const hl = (v != null && !isNaN(v) && Math.abs(v) >= 1.0)
          ? getCellHighlight(col.key, v, row.pitch_name)
          : null;
        const delta = (v != null && !isNaN(v)) ? renderDelta(col.key, Number(v), row.pitch_name) : null;
        if (hl) return cellDelta(<span className={`highlight-cell hl-${hl}`}>{fmtVal}</span>, delta, col.key);
        return cellDelta(dim(fmtVal), delta, col.key);
      }
      const delta = (v != null && !isNaN(v)) ? renderDelta(col.key, Number(v), row.pitch_name) : null;
      return cellDelta(dim(fmtVal), delta, col.key);
    }
    if (pctKeys.includes(col.key)) return dim(fmtPct(v));
    const fmtVal = fmt(v);
    if (gradientKeys.includes(col.key)) {
      // Guard: no color when |value| < 1.0
      const hl = (v != null && !isNaN(v) && Math.abs(v) >= 1.0)
        ? getCellHighlight(col.key, v, row.pitch_name)
        : null;
      if (hl) return <span className={`highlight-cell hl-${hl}`}>{fmtVal}</span>;
    }
    return dim(fmtVal);
  };

  // Build opponent label for team header
  const getTeamOppLabel = (rows) => {
    const first = rows[0];
    if (!first || !first.opponent) return "";
    const prefix = first.home_team && first.team === first.home_team ? "vs." : "@";
    return `${prefix} ${displayAbbrev(first.opponent)}`;
  };

  // Compute column widths for team cards
  const getColWidth = (key) => {
    if (key === "pitcher") return maxPitcherWidth;
    if (key === "pitch_name") return 95;
    if (key === "hand") return 52;
    if (key === "strike_pct" || key === "swstr_pct") return 72;
    return 62;
  };

  const renderTable = (rows, teamLabel, isCard) => {
    let activeCols = isCard ? cols.filter(c => !TEAM_SPLIT_HIDE.includes(c.key)) : cols;
    if (isMobile) activeCols = activeCols.filter(c => !MOBILE_HIDE_COLS.includes(c.key));
    const oppLabel = isCard ? getTeamOppLabel(rows) : "";
    // Compute total table width for consistent card sizing
    const totalWidth = isCard && !isMobile ? activeCols.reduce((sum, c) => sum + getColWidth(c.key), 0) : undefined;

    // Compute sticky left offsets for mobile (pitcher + pitch_name)
    const stickyKeys = isMobile ? ["pitcher", "pitch_name"] : [];
    const stickyLeftMap = {};
    if (isMobile) {
      let left = 0;
      for (const key of stickyKeys) {
        const col = activeCols.find(c => c.key === key);
        if (col) {
          stickyLeftMap[key] = left;
          left += key === "pitcher" ? 110 : 80;
        }
      }
    }

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
              {activeCols.map(c => {
                return <col key={c.key} style={{ width: getColWidth(c.key) + "px" }} />;
              })}
            </colgroup>
          )}
          <thead>
            <tr>
              {activeCols.map(c => {
                const isSticky = stickyKeys.includes(c.key);
                const stickyStyle = isSticky ? { position: "sticky", left: stickyLeftMap[c.key], zIndex: 3, background: "var(--surface2)", minWidth: c.key === "pitcher" ? 110 : 80 } : {};
                return (
                  <th key={c.key}
                      className={[c.dividerRight ? "col-divider-right" : "", isSticky ? "mobile-sticky-col" : ""].filter(Boolean).join(" ")}
                      style={{ textAlign: c.align || "right", cursor: sortable ? "pointer" : "default", ...stickyStyle }}
                      onClick={() => handleSort(c.key)}>
                    <span className={sortable && sortKey === c.key ? "sort-active" : ""}>{c.label}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isDimmedRow = selectedPitchType && r.pitch_name !== selectedPitchType;
              return (
              <tr key={i} className={[onPitcherClick ? "clickable-row" : "", onPitchTypeClick ? "clickable-row" : ""].filter(Boolean).join(" ")}
                  style={isDimmedRow ? { opacity: 0.4 } : undefined}
                  onClick={(e) => {
                    if (onPitchTypeClick && r.pitch_name) { onPitchTypeClick(r.pitch_name); }
                    else if (onPitcherClick) { onPitcherClick(r.pitcher_id, r.game_pk, e); }
                  }}
                  onMouseDown={(e) => { if (e.button === 1 && onPitcherClick) { e.preventDefault(); onPitcherClick(r.pitcher_id, r.game_pk, e); } }}>
                {activeCols.map(c => {
                  const isSticky = stickyKeys.includes(c.key);
                  const stickyStyle = isSticky ? { position: "sticky", left: stickyLeftMap[c.key], zIndex: 2, background: "var(--surface2)", minWidth: c.key === "pitcher" ? 110 : 80 } : {};
                  return <td key={c.key} className={[c.dividerRight ? "col-divider-right" : "", isSticky ? "mobile-sticky-col" : ""].filter(Boolean).join(" ")} style={{ textAlign: c.align || "left", ...stickyStyle }}>{renderCell(r, c)}</td>;
                })}
              </tr>
              );
            })}
            {(() => {
              const t = computeTotals(rows);
              if (!t) return null;
              return (
                <tr className="pp-total-row" style={{ ...(isMobile ? { position: "sticky", bottom: 0, zIndex: 2 } : {}), cursor: selectedPitchType && onPitchTypeClick ? "pointer" : undefined }} onClick={() => selectedPitchType && onPitchTypeClick && onPitchTypeClick(selectedPitchType)}>
                  {activeCols.map(c => {
                    let val;
                    if (c.key === "pitch_name") val = <span className="pp-total-label">Total</span>;
                    else if (HYPHEN_TOTAL_KEYS.has(c.key)) val = "—";
                    else if (c.key === "count") val = t.count;
                    else if (pctKeys.includes(c.key) && t[c.key] != null) val = t[c.key] + "%";
                    else val = t[c.key] != null ? t[c.key] : "—";
                    const isSticky = stickyKeys.includes(c.key);
                    const totalStickyStyle = isSticky ? { position: "sticky", left: stickyLeftMap[c.key], zIndex: 4, background: "#363957", minWidth: c.key === "pitcher" ? 110 : 80 } : {};
                    return (
                      <td key={c.key}
                          className={[c.dividerRight ? "col-divider-right" : "", isSticky ? "mobile-sticky-col" : ""].filter(Boolean).join(" ")}
                          style={{ textAlign: c.align || "left", ...totalStickyStyle }}>
                        {val}
                      </td>
                    );
                  })}
                </tr>
              );
            })()}
          </tbody>
        </table>
        </div>
      </div>
    );
  };

  if (!sorted.length) return <div className="no-data">No pitch data available.</div>;

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
