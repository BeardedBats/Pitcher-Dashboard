import React, { useState, useEffect, useMemo } from "react";
import StrikeZonePlot from "./StrikeZonePlot";
import StrikeZonePBP from "./StrikeZonePBP";
import MovementPlot from "./MovementPlot";
import PitchDataTable from "./PitchDataTable";
import { PITCH_COLORS, PITCH_DESC_COLORS, RESULT_COLORS, CARD_PITCH_DATA_COLUMNS, displayAbbrev } from "../constants";
import { getResultColor } from "../utils/formatting";
import { fetchSeasonAverages } from "../utils/api";

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Format out-type result with trajectory
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

function classifyBattedBall(launchSpeed, launchAngle) {
  if (launchSpeed == null || launchAngle == null) return null;
  const ev = launchSpeed, la = launchAngle;
  if (ev >= 98) {
    const laMin = Math.max(8, 26 - (ev - 98) * 1.5);
    const laMax = Math.min(50, 30 + (ev - 98) * 1.3);
    if (la >= laMin && la <= laMax) return "Barrel";
  }
  if (ev >= 95 && la >= 10 && la <= 50) return "Solid";
  if (la < 10) return "Poorly/Topped";
  if (ev >= 80 && la >= 10 && la <= 25) return "Flare/Burner";
  if (la > 50) return "Poorly/Under";
  if (la > 25 && ev < 80) return "Poorly/Under";
  if (ev < 80) return "Poorly/Weak";
  if (ev >= 95) return "Solid";
  return "Flare/Burner";
}

const BATTED_BALL_COLORS = {
  "Barrel": "#ffa3a3", "Solid": "#F59E0B", "Flare/Burner": "#8feaff",
  "Poorly/Under": "#65ff9c", "Poorly/Topped": "#65ff9c", "Poorly/Weak": "#65ff9c",
};

function isStrikeout(result) {
  if (!result) return false;
  const r = result.toLowerCase();
  return r === "strikeout" || r === "strikeout_double_play";
}

function computeInningStats(pas, pitcherId) {
  let totalPitches = 0, hits = 0, bbs = 0, ks = 0, hrs = 0, runs = 0;
  let outs = 0;
  for (const pa of pas) {
    if (pitcherId && pa.pitcher_id !== pitcherId) continue;
    const r = (pa.result || "").toLowerCase();
    totalPitches += pa.pitches ? pa.pitches.length : 0;
    if (r === "strikeout" || r === "strikeout_double_play") ks++;
    if (r === "walk" || r === "intent_walk") bbs++;
    if (["single", "double", "triple", "home_run"].includes(r)) hits++;
    if (r === "home_run") hrs++;
    if (pa.rbi) runs += pa.rbi;
    if (["strikeout", "field_out", "force_out", "sac_fly", "sac_bunt", "fielders_choice_out"].includes(r)) outs++;
    if (["grounded_into_double_play", "double_play", "strikeout_double_play", "sac_fly_double_play"].includes(r)) outs += 2;
    if (r === "triple_play") outs += 3;
  }
  const ip = (Math.floor(outs / 3) + (outs % 3) / 10).toFixed(1);
  return { ip, hits, bbs, ks, hrs, runs, pitches: totalPitches };
}

export default function PitcherCard({ cardData, date, linescoreData, onGameClick, onReclassify, onPlayerClick }) {
  if (!cardData) return null;
  const { name, team, hand, opponent, pitches, sz_top, sz_bot,
    pitch_table, pitch_table_vs_l, pitch_table_vs_r, result, pitcher_id } = cardData;

  const dateDisplay = date || "";
  const isHome = result && result.home_team === team;
  const oppPrefix = isHome ? "vs." : "@";

  // Batter hand filter
  const [batterFilter, setBatterFilter] = useState("all");

  // Strikezone color mode
  const [szColorMode, setSzColorMode] = useState("pitch-type");

  // Metrics view toggle
  const [metricsView, setMetricsView] = useState("pitch-data"); // "pitch-data" | "play-by-play"

  // PBP inline state: which PA is active (shows SZ) and which are expanded (pitch-by-pitch)
  const [pbpActivePa, setPbpActivePa] = useState("0-0"); // "segIdx-paIdx"
  const [pbpExpanded, setPbpExpanded] = useState({});
  const [pbpPitchHover, setPbpPitchHover] = useState(null);

  // Show change toggle
  const [showChange, setShowChange] = useState(true);
  const [seasonAvgs, setSeasonAvgs] = useState(null);
  const [loadingAvgs, setLoadingAvgs] = useState(false);

  // Determine which season to compare against
  const currentYear = date ? parseInt(date.slice(0, 4)) : new Date().getFullYear();
  const prevSeason = currentYear - 1;

  useEffect(() => {
    if (showChange && !seasonAvgs && pitcher_id) {
      setLoadingAvgs(true);
      fetchSeasonAverages(pitcher_id, prevSeason)
        .then(avgs => { setSeasonAvgs(avgs); setLoadingAvgs(false); })
        .catch(() => { setSeasonAvgs({}); setLoadingAvgs(false); });
    }
  }, [showChange, seasonAvgs, pitcher_id, prevSeason]);

  // Select correct pitch table based on batter filter
  const activePitchTable = useMemo(() => {
    let table;
    if (batterFilter === "L" && pitch_table_vs_l) table = pitch_table_vs_l;
    else if (batterFilter === "R" && pitch_table_vs_r) table = pitch_table_vs_r;
    else table = pitch_table;
    // Sort by count descending
    if (table) return [...table].sort((a, b) => (b.count || 0) - (a.count || 0));
    return [];
  }, [batterFilter, pitch_table, pitch_table_vs_l, pitch_table_vs_r]);

  // Build play-by-play data for this pitcher from linescore
  const pitcherPBP = useMemo(() => {
    if (!linescoreData?.plays || !pitcher_id) return null;
    // Collect half-innings where this pitcher appeared
    const segments = [];
    for (const half of linescoreData.plays) {
      const pitcherPAs = (half.pas || []).filter(pa => pa.pitcher_id === pitcher_id);
      if (pitcherPAs.length === 0) continue;
      segments.push({
        inning: half.inning,
        isTop: half.top,
        label: `${half.top ? "Top" : "Bot"} ${half.inning}`,
        pas: pitcherPAs,
        allPas: half.pas || [],
      });
    }
    if (segments.length === 0) return null;
    const totalPAs = segments.reduce((sum, s) => sum + s.pas.length, 0);
    return { segments, totalPAs };
  }, [linescoreData, pitcher_id]);

  // Filter pitches for plots when batter hand filter is active
  const filteredPitches = useMemo(() => {
    if (!pitches) return [];
    if (batterFilter === "L") return pitches.filter(p => p.stand === "L");
    if (batterFilter === "R") return pitches.filter(p => p.stand === "R");
    return pitches;
  }, [pitches, batterFilter]);

  return (
    <div className="card">
      {/* ===== TOP ROW: Player Info + Box Score ===== */}
      <div className="card-top">
        <div className="card-info">
          <div className="card-name" onClick={() => onPlayerClick && pitcher_id && onPlayerClick(pitcher_id)} style={onPlayerClick ? { cursor: "pointer" } : {}}>{name}</div>
          <div className="card-meta">
            {displayAbbrev(team)} · {hand}HP ·{" "}
            {onGameClick ? (
              <span className="card-game-link" onClick={onGameClick} role="button" tabIndex={0}>
                {dateDisplay} {oppPrefix} {displayAbbrev(opponent)}
              </span>
            ) : (
              <span>{dateDisplay} {oppPrefix} {displayAbbrev(opponent)}</span>
            )}
          </div>
        </div>
        {result && (
          <div className="card-gameline-box">
            <div className="card-gameline-header">Box Score</div>
            <table className="card-gameline-table">
              <thead>
                <tr>
                  <th>Pitcher</th><th>IP</th><th>ER</th><th>Hits</th><th>BB</th>
                  <th className="gameline-divider-right">K</th>
                  <th>Whiffs</th><th>CSW%</th><th>#</th><th>HR</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="card-pitcher-name" style={{ color: "#f0c040" }}>{name}</td>
                  <td>{result.ip}</td>
                  <td>{result.er}</td>
                  <td>{result.hits}</td>
                  <td>{result.bbs}</td>
                  <td className="gameline-divider-right">{result.ks}</td>
                  <td>{result.whiffs}</td>
                  <td>{result.csw_pct != null ? Math.round(result.csw_pct) + "%" : "-"}</td>
                  <td>{result.pitches}</td>
                  <td>{result.hrs}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===== PITCH TYPE METRICS / PLAY-BY-PLAY ===== */}
      <div className="card-section">
        <div className="metrics-header">
          <div className="metrics-subnav">
            <button className={`metrics-subnav-btn${metricsView === "pitch-data" ? " active" : ""}`} onClick={() => setMetricsView("pitch-data")}>
              Pitch Type Metrics
            </button>
            {pitcherPBP && (
              <button className={`metrics-subnav-btn${metricsView === "play-by-play" ? " active" : ""}`} onClick={() => setMetricsView("play-by-play")}>
                Play-by-Play
              </button>
            )}
          </div>
          {metricsView === "pitch-data" && (
            <div className="metrics-controls">
              <select className="batter-filter-select" value={batterFilter}
                onChange={e => setBatterFilter(e.target.value)}>
                <option value="all">Vs All</option>
                <option value="L">vs. LHB</option>
                <option value="R">vs. RHB</option>
              </select>
              <label className="change-toggle">
                <input type="checkbox" checked={showChange} onChange={e => setShowChange(e.target.checked)} />
                <span>Show Change</span>
              </label>
            </div>
          )}
        </div>
        {metricsView === "pitch-data" && (
          <div className="metrics-card">
            <PitchDataTable data={activePitchTable} columns={CARD_PITCH_DATA_COLUMNS}
              splitByTeam={false} spOnly={false} pitcherHand={hand}
              sortable={false}
              showChange={showChange} seasonAvgs={seasonAvgs}
              batterFilter={batterFilter} />
            {loadingAvgs && <div className="loading-avgs">Loading season averages...</div>}
          </div>
        )}
        {metricsView === "play-by-play" && pitcherPBP && (() => {
          // Find the active PA object for the SZ plot
          const [activeSegIdx, activePaIdx] = pbpActivePa.split("-").map(Number);
          const activeSeg = pitcherPBP.segments[activeSegIdx];
          const activePa = activeSeg?.pas[activePaIdx] || null;

          return (
            <div className="card-pbp">
              {pitcherPBP.segments.map((seg, si) => {
                const stats = computeInningStats(seg.allPas, pitcher_id);
                return (
                  <div key={si} className="card-pbp-segment">
                    <div className="card-pbp-inning-header">
                      <span className="card-pbp-inning-label">{seg.label}</span>
                      <span className="card-pbp-inning-stats">
                        {stats.ip} IP · {stats.runs} R · {stats.hits} H · {stats.bbs} BB · {stats.ks} K · {stats.hrs} HR · {stats.pitches} P
                      </span>
                    </div>
                    {seg.pas.map((pa, pi) => {
                      const paKey = `${si}-${pi}`;
                      const isActive = pbpActivePa === paKey;
                      const isExp = pbpExpanded[paKey];
                      const resultLabel = formatResult(pa.result, pa.trajectory);
                      const resultColor = getResultColor(pa.result);
                      const isK = isStrikeout(pa.result);
                      const lastPitch = pa.pitches?.length > 0 ? pa.pitches[pa.pitches.length - 1] : null;
                      const bbType = !isK ? classifyBattedBall(pa.launch_speed, pa.launch_angle) : null;
                      const bbColor = bbType ? BATTED_BALL_COLORS[bbType] : null;

                      const handleClick = () => {
                        setPbpActivePa(paKey);
                        setPbpPitchHover(null);
                        setPbpExpanded(prev => ({ ...prev, [paKey]: !prev[paKey] }));
                      };

                      return (
                        <div key={pi} className="card-pbp-pa-row">
                          {/* Left: PA info (50% width) */}
                          <div className={`card-pbp-pa-card${isActive ? " card-pbp-pa-active" : ""}`} onClick={handleClick}>
                            <div className="card-pbp-row1">
                              <div className="card-pbp-left">
                                <span className="card-pbp-batter">{pa.batter}</span>
                                {pa.rbi > 0 && <span className="card-pbp-rbi">– {pa.rbi} RBI</span>}
                              </div>
                              <span className="card-pbp-result" style={{ color: resultColor }}>{resultLabel}</span>
                            </div>
                            <div className="card-pbp-row2">
                              <span className="card-pbp-vs">vs {pa.pitcher}</span>
                              <span className="card-pbp-pitch-meta">
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
                            {pa.description && (
                              <div className="card-pbp-desc" style={{ color: resultColor }}>{pa.description}</div>
                            )}
                            {!isK && pa.launch_speed != null && (
                              <div className="card-pbp-evla">
                                {pa.launch_speed.toFixed(1)} EV{pa.launch_angle != null ? ` · ${pa.launch_angle.toFixed(0)}° LA` : ""}
                                {bbType && <span style={{ color: bbColor, fontStyle: "normal", fontWeight: 600, marginLeft: 6 }}>{bbType}</span>}
                              </div>
                            )}
                            {/* Expanded pitch-by-pitch table */}
                            {isExp && pa.pitches?.length > 0 && (
                              <div className="pbp-pitches" onClick={e => { e.stopPropagation(); setPbpActivePa(paKey); setPbpPitchHover(null); }}>
                                <div className="pbp-pitch-hdr">
                                  <span className="pbp-ph-num">#</span>
                                  <span className="pbp-ph-count">CT.</span>
                                  <span className="pbp-ph-speed">MPH</span>
                                  <span className="pbp-ph-type">TYPE</span>
                                  <span className="pbp-ph-desc">RESULT</span>
                                </div>
                                {pa.pitches.map((p, j) => {
                                  const pColor = PITCH_COLORS[p.type] || "#888";
                                  return (
                                    <div key={j} className="pbp-pitch-row">
                                      <span className="pbp-ph-num">{p.num}</span>
                                      <span className="pbp-ph-count">{p.count}</span>
                                      <span className="pbp-ph-speed">{p.speed != null ? Number(p.speed).toFixed(1) : "—"}</span>
                                      <span className="pbp-ph-type" style={{ color: pColor }}>{p.type}</span>
                                      <span className="pbp-ph-desc">{p.desc}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                          {/* Right: SZ plot (only next to active PA) */}
                          {isActive && pa.pitches?.length > 0 && (
                            <div className="card-pbp-sz" style={{ position: "absolute", top: 0, left: 689, zIndex: 10 }}>
                              <StrikeZonePBP
                                pitches={pa.pitches}
                                pitchColors={PITCH_COLORS}
                                result={pa.result}
                                resultLabel={resultLabel}
                                batter={pa.batter}
                                pitcher={pa.pitcher}
                                outs={pa.outs || 0}
                                stand={pa.stand || "R"}
                                launchSpeed={pa.launch_speed}
                                launchAngle={pa.launch_angle}
                                battedBallType={bbType}
                                rbi={pa.rbi || 0}
                                isStrikeoutResult={isK}
                                lastPitch={lastPitch}
                                onPitchHover={setPbpPitchHover}
                              />
                              {pbpPitchHover && (() => {
                                const hp = pbpPitchHover.pitch;
                                const hpColor = PITCH_COLORS[hp.type] || "#888";
                                const desc = (hp.desc || "").toLowerCase().replace(/\s+/g, "_");
                                const descLabel = hp.desc || "";
                                const descColor = PITCH_DESC_COLORS[desc] || "#ccc";
                                const isLastPitch = pa.pitches && pa.pitches.indexOf(hp) === pa.pitches.length - 1;
                                const paResultRaw = isLastPitch ? pa.result : null;
                                const paResultLbl = paResultRaw ? formatResult(paResultRaw, pa.trajectory) : null;
                                return (
                                  <div className="pitch-tooltip" style={{
                                    left: pbpPitchHover.x,
                                    top: pbpPitchHover.y - 10,
                                    minWidth: 260,
                                  }}>
                                    <div style={{ display: "flex", gap: 10 }}>
                                      <div style={{ flex: 1 }}>
                                        <div className="pt-row" style={{ marginBottom: 4 }}>
                                          <span style={{ color: hpColor, fontWeight: 600 }}>{hp.type}</span>
                                          <span style={{ marginLeft: 6 }}>{hp.speed ? hp.speed + " mph" : ""}</span>
                                        </div>
                                        <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                                          vs {pa.batter}
                                        </div>
                                        <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                                          {seg.isTop ? "Top" : "Bot"} {ordinal(seg.inning)} | {pa.outs || 0} Out{(pa.outs || 0) !== 1 ? "s" : ""}
                                        </div>
                                        <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                                          {hp.count || "0-0"}
                                        </div>
                                        {hp.pfx_z != null && hp.pfx_x != null && (
                                          <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                                            iVB {hp.pfx_z.toFixed(1)}" · iHB {(-hp.pfx_x).toFixed(1)}"
                                            {hp.release_extension != null && ` · Ext ${hp.release_extension.toFixed(1)}ft`}
                                          </div>
                                        )}
                                        {descLabel && (
                                          <div className="pt-row" style={{ color: descColor, fontWeight: 500, fontSize: "0.85em" }}>
                                            {descLabel}
                                            {paResultLbl && (
                                              <span style={{ color: getResultColor(paResultRaw), marginLeft: 6 }}>
                                                ({paResultLbl}{hp.launch_speed != null ? ` | ${hp.launch_speed.toFixed(1)} EV` : ""}{hp.launch_angle != null ? `, ${hp.launch_angle.toFixed(0)}° LA` : ""})
                                              </span>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                      {hp.plate_x != null && hp.plate_z != null && (
                                        <svg width="65" height="103" viewBox="0 0 65 103" style={{ flexShrink: 0 }}>
                                          <rect x="12" y="17" width="41" height="50" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
                                          {[1, 2].map(i => (
                                            <line key={"v" + i} x1={12 + (i * 41) / 3} y1="17" x2={12 + (i * 41) / 3} y2="67" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
                                          ))}
                                          {[1, 2].map(i => (
                                            <line key={"h" + i} x1="12" y1={17 + (i * 50) / 3} x2="53" y2={17 + (i * 50) / 3} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
                                          ))}
                                          <polygon points="32.5,87 42,92 42,99 23,99 23,92" fill="rgba(140,145,175,0.22)" stroke="rgba(160,164,190,0.35)" strokeWidth="0.8" />
                                          <circle
                                            cx={12 + ((-hp.plate_x + 0.83) / 1.66) * 41}
                                            cy={17 + ((3.5 - hp.plate_z) / 2.0) * 50}
                                            r="4" fill={hpColor} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8"
                                          />
                                        </svg>
                                      )}
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {/* Relief tracking */}
              {(() => {
                if (!linescoreData?.plays) return null;
                const allPlays = linescoreData.plays;
                let lastPitcherPA = null;
                let relieverName = null;
                for (const half of allPlays) {
                  for (let i = 0; i < (half.pas || []).length; i++) {
                    if (half.pas[i].pitcher_id === pitcher_id) {
                      lastPitcherPA = { halfIndex: allPlays.indexOf(half), paIndex: i, inning: half.inning, isTop: half.top };
                    }
                  }
                }
                if (lastPitcherPA) {
                  const half = allPlays[lastPitcherPA.halfIndex];
                  for (let i = lastPitcherPA.paIndex + 1; i < half.pas.length; i++) {
                    if (half.pas[i].pitcher_id !== pitcher_id) { relieverName = half.pas[i].pitcher; break; }
                  }
                }
                if (relieverName) return <div className="card-pbp-relief">{relieverName} relieved {name}</div>;
                return null;
              })()}
            </div>
          );
        })()}
      </div>

      {/* ===== VISUALS: Strike zones side by side + Movement ===== */}
      <div className="card-visuals-section">
        <div className="sz-mode-select-row">
          <select className="sz-mode-select" value={szColorMode} onChange={e => setSzColorMode(e.target.value)}>
            <option value="pitch-type">Pitch Types</option>
            <option value="pitch-result">Pitch Results</option>
            <option value="pa-result">PA Results</option>
          </select>
        </div>
        <div className="card-visuals">
          <div className="card-sz-pair">
            {(batterFilter === "all" || batterFilter === "L") && (
              <div className="viz-card">
                <div className="viz-card-label">vs LHB</div>
                <StrikeZonePlot pitches={filteredPitches} szTop={sz_top} szBot={sz_bot} stand="L" colorMode={szColorMode} />
              </div>
            )}
            {(batterFilter === "all" || batterFilter === "R") && (
              <div className="viz-card">
                <div className="viz-card-label">vs RHB</div>
                <StrikeZonePlot pitches={filteredPitches} szTop={sz_top} szBot={sz_bot} stand="R" colorMode={szColorMode} />
              </div>
            )}
        </div>
          <div className="viz-card">
            <div className="viz-card-label">Pitch Movement</div>
            <MovementPlot pitches={filteredPitches} hand={hand} onReclassify={onReclassify} />
          </div>
        </div>
      </div>
    </div>
  );
}
