import React, { useEffect, useState, useMemo } from "react";
import { PITCH_COLORS, PITCH_DESC_COLORS, BATTED_BALL_COLORS, BIP_QUALITY_COLORS, displayAbbrev } from "../constants";
import { getResultColor, classifyBattedBall, getBIPQuality } from "../utils/formatting";
import { getTooltipResult } from "../utils/pitchFilters";
import useIsMobile from "../hooks/useIsMobile";
import StrikeZonePBP from "./StrikeZonePBP";

const TYPE_TO_NAME = {
  "Four-Seamer": "Four-Seamer", "Sinker": "Sinker", "Cutter": "Cutter",
  "Slider": "Slider", "Sweeper": "Sweeper", "Curveball": "Curveball",
  "Changeup": "Changeup", "Splitter": "Splitter", "Knuckleball": "Knuckleball",
};

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// BATTED_BALL_COLORS and BIP_QUALITY_COLORS imported from constants.js

function formatResult(result, trajectory) {
  if (!result) return "";
  const r = result.toLowerCase();
  if ((r === "field_out" || r === "force_out" || r === "fielders_choice" || r === "fielders_choice_out") && trajectory) {
    const t = trajectory.toLowerCase();
    let outType = "";
    if (t === "ground_ball") outType = "Groundout";
    else if (t === "fly_ball") outType = "Flyout";
    else if (t === "line_drive") outType = "Lineout";
    else if (t === "popup") outType = "Pop Out";
    if (outType) {
      if (r === "force_out") return outType + " (FC)";
      if (r === "fielders_choice" || r === "fielders_choice_out") return "Fielder's Choice";
      return outType;
    }
  }
  if (r === "catcher_interf") return "Catcher Interference";
  return result.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// Check if a result is a strikeout
function isStrikeout(result) {
  if (!result) return false;
  const r = result.toLowerCase();
  return r === "strikeout" || r === "strikeout_double_play";
}

// Compute inning stats for a half-inning's PAs filtered to a specific pitcher
function computeInningStats(pas, pitcherId) {
  let totalPitches = 0, hits = 0, bbs = 0, ks = 0, hrs = 0, runs = 0, er = 0;
  let outs = 0;

  for (const pa of pas) {
    if (pitcherId && pa.pitcher_id !== pitcherId) continue;
    const r = (pa.result || "").toLowerCase();
    const pitchCount = pa.pitches ? pa.pitches.length : 0;
    totalPitches += pitchCount;

    // Count events
    if (r === "strikeout" || r === "strikeout_double_play") ks++;
    if (r === "walk" || r === "intent_walk") bbs++;
    if (r === "single" || r === "double" || r === "triple" || r === "home_run") hits++;
    if (r === "home_run") hrs++;
    if (pa.rbi) runs += pa.rbi;

    // Count outs made
    if (r === "strikeout" || r === "field_out" || r === "force_out" || r === "sac_fly" || r === "sac_bunt" || r === "fielders_choice_out") outs++;
    if (r === "grounded_into_double_play" || r === "double_play" || r === "strikeout_double_play" || r === "sac_fly_double_play") outs += 2;
    if (r === "triple_play") outs += 3;
  }

  // IP: convert outs to innings pitched format
  const fullInnings = Math.floor(outs / 3);
  const partialOuts = outs % 3;
  const ip = fullInnings + partialOuts / 10; // display as "1.2" for 1 and 2/3

  return { ip: ip.toFixed(1), hits, bbs, ks, hrs, runs, pitches: totalPitches };
}

export default function PlayByPlayModal({ data, inning: initialInning, isTop: initialIsTop, pitcherId, onClose }) {
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState({});
  const [activePaIndex, setActivePaIndex] = useState(0);
  const [pitchHover, setPitchHover] = useState(null);
  const [currentInning, setCurrentInning] = useState(initialInning);
  const [currentIsTop, setCurrentIsTop] = useState(initialIsTop);

  // Build list of half-innings the selected pitcher appeared in (for navigation)
  const pitcherHalfInnings = useMemo(() => {
    if (!data?.plays || !pitcherId) return [];
    return data.plays.filter(half =>
      half.pas && half.pas.some(pa => pa.pitcher_id === pitcherId)
    ).map(half => ({ inning: half.inning, isTop: half.top }));
  }, [data, pitcherId]);

  // Find current position in pitcherHalfInnings
  const currentHalfIdx = useMemo(() => {
    return pitcherHalfInnings.findIndex(h => h.inning === currentInning && h.isTop === currentIsTop);
  }, [pitcherHalfInnings, currentInning, currentIsTop]);

  const hasPrev = currentHalfIdx > 0;
  const hasNext = currentHalfIdx < pitcherHalfInnings.length - 1;

  const goToPrev = () => {
    if (hasPrev) {
      const prev = pitcherHalfInnings[currentHalfIdx - 1];
      setCurrentInning(prev.inning);
      setCurrentIsTop(prev.isTop);
      setActivePaIndex(0);
      setExpanded({});
      setPitchHover(null);
    }
  };

  const goToNext = () => {
    if (hasNext) {
      const next = pitcherHalfInnings[currentHalfIdx + 1];
      setCurrentInning(next.inning);
      setCurrentIsTop(next.isTop);
      setActivePaIndex(0);
      setExpanded({});
      setPitchHover(null);
    }
  };

  // Close on ESC, arrow key navigation
  useEffect(() => {
    const handleKey = e => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && hasPrev) goToPrev();
      if (e.key === "ArrowRight" && hasNext) goToNext();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, hasPrev, hasNext, currentHalfIdx]);

  if (!data || !data.plays) return null;

  const half = data.plays.find(p => p.inning === currentInning && p.top === currentIsTop);
  if (!half || !half.pas || half.pas.length === 0) return null;

  const teamBatting = currentIsTop ? data.away_team : data.home_team;
  const teamPitching = currentIsTop ? data.home_team : data.away_team;

  // Compute score at start of this half-inning from linescore data
  const preHalfScore = useMemo(() => {
    if (!data.innings) return null;
    let away = 0, home = 0;
    for (const inn of data.innings) {
      if (inn.num < currentInning) {
        away += inn.away?.runs || 0;
        home += inn.home?.runs || 0;
      } else if (inn.num === currentInning && !currentIsTop) {
        // Bottom of inning: add top-half runs
        away += inn.away?.runs || 0;
      }
    }
    return { away, home };
  }, [data.innings, currentInning, currentIsTop]);

  // Compute inning stats
  const inningStats = computeInningStats(half.pas, pitcherId);

  const toggleExpand = (i) => {
    setExpanded(prev => ({ ...prev, [i]: !prev[i] }));
    setActivePaIndex(i);
  };

  const handlePAClick = (i) => {
    setActivePaIndex(i);
    setExpanded(prev => ({ ...prev, [i]: !prev[i] }));
  };

  const activePa = half.pas[activePaIndex];

  // Format prev/next labels
  const prevLabel = hasPrev ? `← ${ordinal(pitcherHalfInnings[currentHalfIdx - 1].inning)}` : null;
  const nextLabel = hasNext ? `${ordinal(pitcherHalfInnings[currentHalfIdx + 1].inning)} →` : null;

  return (
    <div className="pbp-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pbp-panel">
        <div className="pbp-header">
          {/* Left arrow / prev inning */}
          <button className="pbp-nav-btn" onClick={goToPrev} disabled={!hasPrev} title={hasPrev ? `Go to ${ordinal(pitcherHalfInnings[currentHalfIdx - 1].inning)}` : ""}>
            {prevLabel || ""}
          </button>

          <div className="pbp-title-block">
            <div className="pbp-title">
              {currentIsTop ? "Top" : "Bottom"} {ordinal(currentInning)} — {half.pas[0]?.pitcher || "Unknown"} vs. {displayAbbrev(teamPitching)}
            </div>
            <div className="pbp-inning-stats">
              {inningStats.ip} IP · {inningStats.runs} R · {inningStats.hits} H · {inningStats.bbs} BB · {inningStats.ks} K · {inningStats.hrs} HR · {inningStats.pitches} P
            </div>
          </div>

          {/* Right arrow / next inning */}
          <button className="pbp-nav-btn" onClick={goToNext} disabled={!hasNext} title={hasNext ? `Go to ${ordinal(pitcherHalfInnings[currentHalfIdx + 1].inning)}` : ""}>
            {nextLabel || ""}
          </button>
        </div>

        <div className="pbp-content">
          <div className="pbp-left-panel">
            {half.pas.map((pa, i) => {
              const isPitcherPA = pitcherId && pa.pitcher_id === pitcherId;
              const isExpanded = expanded[i];
              const isActive = activePaIndex === i;
              const isK = isStrikeout(pa.result);
              const lastPitch = pa.pitches && pa.pitches.length > 0 ? pa.pitches[pa.pitches.length - 1] : null;

              // Use tooltip result system for consistent colors
              const paResult = getTooltipResult({}, {
                desc: lastPitch?.desc || "",
                paResult: pa.result,
                isLastPitch: true,
                launchAngle: pa.launch_angle,
              });
              const resultLabel = paResult.label;
              const resultColor = paResult.color;

              // Detect runs scored by comparing total score to previous PA
              let runsScored = 0;
              if (pa.away_score != null && pa.home_score != null) {
                const curTotal = pa.away_score + pa.home_score;
                if (i > 0 && half.pas[i - 1].away_score != null && half.pas[i - 1].home_score != null) {
                  runsScored = curTotal - (half.pas[i - 1].away_score + half.pas[i - 1].home_score);
                } else if (i === 0 && preHalfScore) {
                  runsScored = curTotal - (preHalfScore.away + preHalfScore.home);
                }
              }

              return (
                <div key={i}>
                  {i > 0 && half.pas[i].pitcher !== half.pas[i - 1].pitcher && (
                    <div className="pbp-relief-row">
                      {half.pas[i].pitcher} relieved {half.pas[i - 1].pitcher}
                    </div>
                  )}
                  <div className={`pbp-pa${isPitcherPA ? " pbp-pa-hl" : ""}${isActive ? " pbp-pa-active" : ""}`}>
                    {/* Row 1: Batter name (+ runs scored) left, Result right */}
                    <div className="pbp-pa-top" onClick={() => handlePAClick(i)}>
                      <div className="pbp-pa-left">
                        <span className="pbp-pa-batter">{pa.batter}</span>
                        {runsScored > 0 && (
                          <span className="pbp-pa-rbi">
                            <span style={{ color: "#FF5EDC" }}>- {runsScored} Run{runsScored !== 1 ? "s" : ""} score{runsScored === 1 ? "s" : ""}.{" "}</span>
                            {pa.away_score != null && pa.home_score != null && (() => {
                              const awayDisp = displayAbbrev(data.away_team) || data.away_team;
                              const homeDisp = displayAbbrev(data.home_team) || data.home_team;
                              const battingTeam = currentIsTop ? data.away_team : data.home_team;
                              const awayScored = data.away_team === battingTeam;
                              const homeScored = data.home_team === battingTeam;
                              return (
                                <span>
                                  <span style={{ color: awayScored ? "#FFC46A" : "#E0E2EC", fontWeight: awayScored ? 700 : 600 }}>{awayDisp} {pa.away_score}</span>
                                  <span style={{ color: "rgba(180,184,210,0.6)" }}> - </span>
                                  <span style={{ color: homeScored ? "#FFC46A" : "#E0E2EC", fontWeight: homeScored ? 700 : 600 }}>{homeDisp} {pa.home_score}</span>
                                </span>
                              );
                            })()}
                          </span>
                        )}
                      </div>
                      <span className="pbp-pa-result" style={{ color: resultColor }}>
                        {resultLabel}
                        {paResult.isK && (
                          paResult.isCalledStrikeThree
                            ? <span style={{ marginLeft: 3 }}>(<span style={{ display: "inline-block", transform: "scaleX(-1)" }}>K</span>)</span>
                            : <span style={{ marginLeft: 3 }}>(K)</span>
                        )}
                      </span>
                    </div>


                    {/* Row 2: vs Pitcher left, MPH + Pitch Type right (all at-bats) */}
                    <div className="pbp-pa-meta-row" onClick={() => setActivePaIndex(i)} style={{ cursor: "pointer" }}>
                      <span className="pbp-pa-vs">vs {pa.pitcher}</span>
                      <span className="pbp-pa-secondary">
                        {lastPitch ? (
                          <>
                            <span style={{ fontWeight: 700, color: "#E0E2EC" }}>{lastPitch.speed ? Number(lastPitch.speed).toFixed(1) : ""}</span>
                            {lastPitch.type && (
                              <span style={{ color: PITCH_COLORS[lastPitch.type] || "#888", fontWeight: 600, marginLeft: 4 }}>{lastPitch.type}</span>
                            )}
                          </>
                        ) : null}
                      </span>
                    </div>

                    {/* Row 3: Play description — colored to match result */}
                    {pa.description && (
                      <div className="pbp-pa-desc" onClick={() => setActivePaIndex(i)} style={{ cursor: "pointer", color: resultColor }}>{pa.description}</div>
                    )}

                    {/* Row 4: EV/LA + batted ball type (after description, for balls in play) */}
                    {!isK && pa.launch_speed != null && (
                      <div className="pbp-pa-ev-la" onClick={() => setActivePaIndex(i)} style={{ cursor: "pointer" }}>
                        {pa.launch_speed.toFixed(1)} EV{pa.launch_angle != null ? ` · ${pa.launch_angle.toFixed(0)}° LA` : ""}
                        {(() => {
                          const bbType = classifyBattedBall(pa.launch_speed, pa.launch_angle);
                          const bbColor = bbType ? BATTED_BALL_COLORS[bbType] : null;
                          return bbType ? <span style={{ color: bbColor, fontStyle: "normal", fontWeight: 600, marginLeft: 6 }}>{bbType}</span> : null;
                        })()}
                      </div>
                    )}

                    {/* Expanded pitch-by-pitch */}
                    {isExpanded && pa.pitches && pa.pitches.length > 0 && (
                      <div className="pbp-pitches" onClick={(e) => { e.stopPropagation(); setActivePaIndex(i); }}>
                        <div className="pbp-pitch-hdr">
                          <span className="pbp-ph-num">#</span>
                          <span className="pbp-ph-count">CT.</span>
                          <span className="pbp-ph-speed">MPH</span>
                          <span className="pbp-ph-type">TYPE</span>
                          <span className="pbp-ph-desc">RESULT</span>
                        </div>
                        {pa.pitches.map((p, j) => {
                          const color = PITCH_COLORS[p.type] || PITCH_COLORS[TYPE_TO_NAME[p.type]] || "#888";
                          const mph = p.speed != null ? Number(p.speed).toFixed(1) : "—";
                          // Color the pitch description using tooltip result colors
                          const pitchResult = getTooltipResult(p, {
                            desc: p.desc,
                            paResult: j === pa.pitches.length - 1 ? pa.result : null,
                            isLastPitch: j === pa.pitches.length - 1,
                            launchAngle: j === pa.pitches.length - 1 ? pa.launch_angle : null,
                          });
                          return (
                            <div key={j} className="pbp-pitch-row">
                              <span className="pbp-ph-num">{p.num}</span>
                              <span className="pbp-ph-count">{p.count}</span>
                              <span className="pbp-ph-speed">{mph}</span>
                              <span className="pbp-ph-type" style={{ color }}>
                                {p.type}
                              </span>
                              <span className="pbp-ph-desc" style={{ color: pitchResult.color }}>{p.desc}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pbp-sz-panel" style={{ position: "sticky", top: 12, alignSelf: "flex-start" }}>
            {activePa && activePa.pitches && activePa.pitches.length > 0 && (
              <>
                <StrikeZonePBP
                  key={`${currentInning}-${currentIsTop}-${activePaIndex}`}
                  pitches={activePa.pitches}
                  pitchColors={PITCH_COLORS}
                  result={activePa.result}
                  resultLabel={formatResult(activePa.result, activePa.trajectory)}
                  batter={activePa.batter}
                  pitcher={activePa.pitcher}
                  outs={activePa.outs || 0}
                  stand={activePa.stand || "R"}
                  launchSpeed={activePa.launch_speed}
                  launchAngle={activePa.launch_angle}
                  battedBallType={classifyBattedBall(activePa.launch_speed, activePa.launch_angle)}
                  rbi={activePa.rbi || 0}
                  isStrikeoutResult={isStrikeout(activePa.result)}
                  lastPitch={activePa.pitches[activePa.pitches.length - 1]}
                  onPitchHover={setPitchHover}
                  homeScore={activePa.home_score}
                  awayScore={activePa.away_score}
                  awayTeam={data.away_team}
                  homeTeam={data.home_team}
                  pitcherTeam={teamPitching}
                  isMobile={isMobile}
                />
                {pitchHover && (() => {
                  const hp = pitchHover.pitch;
                  const hpColor = PITCH_COLORS[hp.type] || "#888";
                  const isLastPitch = activePa.pitches && activePa.pitches.indexOf(hp) === activePa.pitches.length - 1;
                  const result = getTooltipResult(hp, {
                    desc: hp.desc,
                    paResult: activePa.result,
                    isLastPitch,
                    launchAngle: isLastPitch ? activePa.launch_angle : null,
                  });

                  const isBIP = isLastPitch && hp.launch_speed != null && hp.launch_angle != null &&
                    (hp.desc || "").toLowerCase().includes("in play");
                  const bbTag = isBIP ? classifyBattedBall(hp.launch_speed, hp.launch_angle) : null;
                  const bbColor = bbTag ? (BATTED_BALL_COLORS[bbTag] || "rgba(180,184,210,0.7)") : null;

                  // Parse count into balls/strikes
                  const countParts = (hp.count || "0-0").split("-");
                  const balls = countParts[0] || "0";
                  const strikes = countParts[1] || "0";

                  return (
                    <div className="pitch-tooltip" style={(() => {
                      const tx = pitchHover.clientX + 16;
                      const ty = pitchHover.clientY - 16;
                      return {
                        position: "fixed",
                        left: tx + 300 > window.innerWidth ? pitchHover.clientX - 310 : tx,
                        top: ty < 10 ? pitchHover.clientY + 16 : (ty + 280 > window.innerHeight ? pitchHover.clientY - 280 : ty),
                        transform: "none",
                        minWidth: 280,
                        zIndex: 1000,
                        pointerEvents: "none",
                      };
                    })()}>
                      {/* Header row 1: Pitch type + mph (left) | Result (right) */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: isBIP ? 0 : 4 }}>
                        <div style={{ whiteSpace: "nowrap" }}>
                          <span style={{ color: hpColor, fontWeight: 600 }}>{hp.type}</span>
                          <span style={{ marginLeft: 6, color: "#e0e2ec" }}>
                            {hp.speed ? Number(hp.speed).toFixed(1) + " mph" : ""}
                          </span>
                        </div>
                        <div style={{ whiteSpace: "nowrap", color: result.color, fontWeight: 600, marginLeft: 12 }}>
                          {result.label}
                          {result.isK && (
                            result.isCalledStrikeThree
                              ? <span style={{ marginLeft: 3 }}>(<span style={{ display: "inline-block", transform: "scaleX(-1)" }}>K</span>)</span>
                              : <span style={{ marginLeft: 3 }}>(K)</span>
                          )}
                        </div>
                      </div>
                      {/* Header row 2 (BIP only): EV/LA (left) | Batted ball tag (right) */}
                      {isBIP && (
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                          <div style={{ fontSize: "0.85em", color: "rgba(180,184,210,0.7)" }}>
                            {hp.launch_speed.toFixed(1)} EV · {hp.launch_angle != null ? hp.launch_angle.toFixed(0) + "° LA" : ""}
                          </div>
                          {bbTag && (
                            <div style={{ color: bbColor, fontWeight: 600, fontSize: "0.85em", marginLeft: 12 }}>
                              {bbTag}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Body: text left, strikezone right */}
                      <div style={{ display: "flex", gap: 10 }}>
                        <div style={{ flex: 1 }}>
                          {/* vs Batter (left) | Strikeout sub-label (right) */}
                          <div className="pt-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, fontSize: "0.85em" }}>
                            <span>vs {activePa.batter}</span>
                            {result.isK && result.subLabel && (
                              <span style={{ color: "rgba(180,184,210,0.7)" }}>{result.subLabel}</span>
                            )}
                          </div>

                          {/* Inning + bases */}
                          <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                            {currentIsTop ? "Top" : "Bot"} {ordinal(currentInning)} | {activePa.outs || 0} Out{(activePa.outs || 0) !== 1 ? "s" : ""}
                          </div>

                          {/* Outs + count */}
                          <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                            {activePa.outs || 0} Outs | {balls}-{strikes}
                          </div>

                          {/* iVB + iHB + Extension */}
                          {hp.pfx_z != null && hp.pfx_x != null && (
                            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                              iVB {hp.pfx_z.toFixed(1)}" · iHB {(-hp.pfx_x).toFixed(1)}"
                              {hp.release_extension != null && ` · Ext ${hp.release_extension.toFixed(1)}ft`}
                            </div>
                          )}
                        </div>

                        {/* RIGHT: Mini Strikezone SVG, aligned to bottom */}
                        {hp.plate_x != null && hp.plate_z != null && (
                          <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-end", paddingTop: 0 }}>
                            <svg width="65" height="103" viewBox="0 0 65 103">
                              <rect x="12" y="17" width="41" height="50" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
                              {[1, 2].map(i => (
                                <line key={`v${i}`} x1={12 + (i * 41) / 3} y1="17" x2={12 + (i * 41) / 3} y2="67" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
                              ))}
                              {[1, 2].map(i => (
                                <line key={`h${i}`} x1="12" y1={17 + (i * 50) / 3} x2="53" y2={17 + (i * 50) / 3} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
                              ))}
                              <polygon points="32.5,87 42,92 42,99 23,99 23,92" fill="rgba(140,145,175,0.22)" stroke="rgba(160,164,190,0.35)" strokeWidth="0.8" />
                              {(() => {
                                const isLeft = (activePa.stand || "R") === "L";
                                const lx = isLeft ? 6 : 59;
                                const letters = isLeft ? ["L", "H", "B"] : ["R", "H", "B"];
                                return letters.map((ch, i) => (
                                  <text key={i} x={lx} y={33 + i * 10} fill="rgba(150,155,185,0.28)" fontSize="7" fontWeight="bold" textAnchor="middle" dominantBaseline="middle" fontFamily="'DM Sans', sans-serif">{ch}</text>
                                ));
                              })()}
                              <circle
                                cx={12 + ((-hp.plate_x + 0.83) / 1.66) * 41}
                                cy={17 + ((3.5 - hp.plate_z) / 2.0) * 50}
                                r="4" fill={hpColor} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8"
                              />
                            </svg>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
