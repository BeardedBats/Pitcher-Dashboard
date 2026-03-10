import React, { useState, useRef, useCallback, useEffect } from "react";
import { displayAbbrev } from "../constants";

export default function Scoreboard({ data, pitcherId, onInningClick }) {
  const [tooltip, setTooltip] = useState(null); // { inning, top, x, y, above }
  const [clampedPos, setClampedPos] = useState(null); // { left, top, bottom }
  const boardRef = useRef(null);
  const tooltipRef = useRef(null);

  if (!data || !data.innings || data.innings.length === 0) return null;

  const { away_team, home_team, innings, totals, plays, pitcher_exit } = data;
  const maxInnings = Math.max(9, innings.length);

  // Find pitcher exit info
  const exit = pitcherId && pitcher_exit ? pitcher_exit[String(pitcherId)] : null;

  // Get plays for a half-inning
  const getPlays = (inning, isTop) => {
    if (!plays) return [];
    const half = plays.find(p => p.inning === inning && p.top === isTop);
    return half ? half.pas : [];
  };

  // Convert number to ordinal (1 -> "1st", 2 -> "2nd", etc.)
  function ordinal(n) {
    const s = ["th","st","nd","rd"];
    const v = n % 100;
    return n + (s[(v-20)%10] || s[v] || s[0]);
  }

  const handleMouseEnter = useCallback((e, inning, isTop) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({
      inning, top: isTop,
      x: rect.left + rect.width / 2,
      y: isTop ? rect.bottom + 6 : rect.top - 6,
      above: !isTop,
    });
    setClampedPos(null); // Reset clamped position
  }, []);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  const isExitCell = (inning, isTop) => {
    if (!exit) return false;
    return exit.last_inning === inning && exit.last_top === isTop;
  };

  const tooltipPas = tooltip ? getPlays(tooltip.inning, tooltip.top) : [];

  // Check if featured pitcher is pitching in this tooltip's inning
  const tooltipPitcherId = tooltipPas.length > 0 ? tooltipPas[0]?.pitcher_id : null;
  const isFeaturedPitcherPitching = pitcherId && tooltipPitcherId === pitcherId;

  // Handle tooltip viewport clamping
  useEffect(() => {
    if (!tooltip || !tooltipRef.current) return;

    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const padding = 10;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = tooltip.x;
    let top = tooltip.y;
    let above = tooltip.above;

    // Clamp left to viewport
    if (left - tooltipRect.width / 2 < padding) {
      left = tooltipRect.width / 2 + padding;
    } else if (left + tooltipRect.width / 2 > viewportWidth - padding) {
      left = viewportWidth - tooltipRect.width / 2 - padding;
    }

    // Check if tooltip would go below viewport, if so, show above instead
    if (!above && top + tooltipRect.height > viewportHeight - padding) {
      above = true;
    }

    // Check if tooltip would go above viewport, if so, show below instead
    if (above && top - tooltipRect.height < padding) {
      above = false;
      // Reposition below the cell
      top = tooltip.y + 12;
    }

    setClampedPos({ left, top, above });
  }, [tooltip]);

  return (
    <div className="scoreboard-wrap" ref={boardRef}>
      <table className="scoreboard">
        <thead>
          <tr>
            <th className="sb-team-hdr"></th>
            {Array.from({ length: maxInnings }, (_, i) => (
              <th key={i} className="sb-inn-hdr">{i + 1}</th>
            ))}
            <th className="sb-stat-hdr sb-rhe">R</th>
            <th className="sb-stat-hdr sb-rhe">H</th>
            <th className="sb-stat-hdr sb-rhe">E</th>
          </tr>
        </thead>
        <tbody>
          {/* Away row */}
          <tr>
            <td className="sb-team">{displayAbbrev(away_team)}</td>
            {Array.from({ length: maxInnings }, (_, i) => {
              const inn = innings[i];
              const runs = inn ? inn.away.runs : "";
              const exitCell = isExitCell(i + 1, true);
              return (
                <td key={i}
                  className={`sb-cell sb-inn${exitCell ? " sb-exit" : ""}`}
                  onMouseEnter={e => inn && handleMouseEnter(e, i + 1, true)}
                  onMouseLeave={handleMouseLeave}
                  onClick={() => inn && onInningClick && onInningClick(i + 1, true)}>
                  {runs !== "" ? runs : ""}
                </td>
              );
            })}
            <td className="sb-cell sb-stat sb-rhe">{totals.away.runs}</td>
            <td className="sb-cell sb-stat sb-rhe">{totals.away.hits}</td>
            <td className="sb-cell sb-stat sb-rhe">{totals.away.errors}</td>
          </tr>
          {/* Home row */}
          <tr>
            <td className="sb-team">{displayAbbrev(home_team)}</td>
            {Array.from({ length: maxInnings }, (_, i) => {
              const inn = innings[i];
              const runs = inn ? (inn.home.runs !== undefined ? inn.home.runs : "") : "";
              const exitCell = isExitCell(i + 1, false);
              return (
                <td key={i}
                  className={`sb-cell sb-inn${exitCell ? " sb-exit" : ""}`}
                  onMouseEnter={e => inn && handleMouseEnter(e, i + 1, false)}
                  onMouseLeave={handleMouseLeave}
                  onClick={() => inn && onInningClick && onInningClick(i + 1, false)}>
                  {runs !== "" ? runs : ""}
                </td>
              );
            })}
            <td className="sb-cell sb-stat sb-rhe">{totals.home.runs}</td>
            <td className="sb-cell sb-stat sb-rhe">{totals.home.hits}</td>
            <td className="sb-cell sb-stat sb-rhe">{totals.home.errors}</td>
          </tr>
        </tbody>
      </table>

      {/* Hover tooltip */}
      {tooltip && tooltipPas.length > 0 && (
        <div ref={tooltipRef} className="sb-tooltip"
          style={{
            left: clampedPos ? clampedPos.left : tooltip.x,
            ...(clampedPos?.above
              ? { bottom: `calc(100vh - ${clampedPos?.top || tooltip.y}px)` }
              : { top: clampedPos?.top || tooltip.y }),
            transform: "translateX(-50%)",
          }}>
          <div className="sb-tooltip-hdr" style={{
            fontSize: "14px",
            fontWeight: 700,
            marginBottom: "8px",
            display: "flex",
            flexDirection: "row",
            gap: "4px",
            alignItems: "baseline",
            textTransform: "none",
            letterSpacing: "normal",
          }}>
            <span style={{
              color: isFeaturedPitcherPitching ? "var(--accent, #38BDF8)" : "var(--text-bright)",
            }}>
              {tooltip.top ? `Top ${ordinal(tooltip.inning)}` : `Bot ${ordinal(tooltip.inning)}`}
            </span>
            <span style={{ color: "var(--text-dim)" }}>—</span>
            <span style={{
              color: isFeaturedPitcherPitching ? "var(--accent, #38BDF8)" : "var(--text-bright)",
            }}>
              {tooltipPas[0]?.pitcher || "Unknown"}
            </span>
            <span style={{ color: "var(--text-dim)" }}>vs.</span>
            <span style={{ color: "var(--text-dim)" }}>
              {displayAbbrev(tooltip.top ? home_team : away_team)}
            </span>
          </div>
          {tooltipPas.map((pa, i) => {
            const prevPa = i > 0 ? tooltipPas[i - 1] : null;
            const isPitcherChange = prevPa && prevPa.pitcher_id !== pa.pitcher_id;

            return (
              <React.Fragment key={i}>
                {isPitcherChange && (
                  <div className="sb-tooltip-relief">
                    {prevPa.pitcher} relieved by {pa.pitcher}
                  </div>
                )}
                <div className={`sb-tooltip-pa${isFeaturedPitcherPitching && pa.pitcher_id === pitcherId ? " sb-hl" : ""}`}
                  style={isFeaturedPitcherPitching && pa.pitcher_id === pitcherId ? {
                    color: "var(--text-bright)",
                    fontWeight: 600,
                  } : {}}>
                  {pa.description || `${pa.batter}: ${pa.result}`}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
