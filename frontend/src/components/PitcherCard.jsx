import React, { useState, useEffect, useMemo } from "react";
import StrikeZonePlot from "./StrikeZonePlot";
import StrikeZonePBP from "./StrikeZonePBP";
import MovementPlot from "./MovementPlot";
import PitchDataTable from "./PitchDataTable";
import PitchFilterDropdown from "./PitchFilterDropdown";
import ResultsTable from "./ResultsTable";
import UsageTable from "./UsageTable";
import VelocityTrend from "./VelocityTrend";
import VelocityTrendV2 from "./VelocityTrendV2";
import { PITCH_COLORS, PITCH_DESC_COLORS, RESULT_COLORS, CARD_PITCH_DATA_COLUMNS, displayAbbrev, displayTeamAbbrev, getOpponentTierColor } from "../constants";
import { getResultColor } from "../utils/formatting";
import { fetchSeasonAverages, fetchPitcherSchedule } from "../utils/api";
import { classifyPitchResult, isRunScored, isStrikeoutPitch, isBallInPlay, classifyBIPQuality, classifyBattedBallFull, getTooltipResult, getPADescriptionSpans, isCIOrErrorEvent, RESULT_FILTER_OPTIONS, RESULT_QUICK_ACTIONS } from "../utils/pitchFilters";
import { vpToZoomCoord } from "../utils/desktopZoom";

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
      if (r === "fielders_choice" || r === "fielders_choice_out") return "Fielder's Choice";
      return outType;
    }
  }
  if (r === "catcher_interf") return "Catcher Interference";
  return result.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

const BATTED_BALL_COLORS = {
  "Barrel": "#ffa3a3", "Solid": "#ffc277", "Burner": "#ffc277",
  "Flare": "#8feaff",
  "Under": "#65ff9c", "Topped": "#65ff9c", "Poor": "#65ff9c",
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
    totalPitches += pa.pitches ? pa.pitches.filter(p => !p.is_action).length : 0;
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

export default function PitcherCard({ cardData, date, linescoreData, onGameClick, onReclassify, onPlayerClick, isMobile, level = "mlb" }) {
  if (!cardData) return null;
  const { name, team, hand, opponent, pitches, sz_top, sz_bot,
    pitch_table, pitch_table_vs_l, pitch_table_vs_r, result, pitcher_id,
    season_totals: inlineSeasonTotals } = cardData;

  const dateDisplay = date || "";
  const isHome = result && result.home_team === team;
  const oppPrefix = isHome ? "vs." : "@";
  // For MiLB cards, suffix the player name with their parent MLB org so the
  // org affiliation is always visible (e.g., "Jackson Ferris (LAD)"). The
  // rest of the card uses the raw MiLB abbreviation (OKC, BUF, ...) instead
  // of the parent so opponent matchups read naturally at the level played.
  const parentOrgAbbrev = level === "aaa" ? displayTeamAbbrev(team, level) : null;
  const milbAbbrev = (abbr) => level === "aaa" ? displayAbbrev(abbr) : displayTeamAbbrev(abbr, level);
  const nameWithOrg = parentOrgAbbrev ? `${name} (${parentOrgAbbrev})` : name;
  const playerHref = level === "aaa" ? `#aaa/player/${pitcher_id}` : `#player/${pitcher_id}`;
  const cardHref = level === "aaa"
    ? `#aaa/card/${date}/${pitcher_id}/${result?.game_pk || ""}`
    : `#card/${date}/${pitcher_id}/${result?.game_pk || ""}`;

  // Determine if game is final and compute projected decision for live games
  const isFinal = linescoreData?.is_final !== false; // default to true if unknown
  const gameLive = linescoreData && linescoreData.is_final === false;
  const projectedDecision = useMemo(() => {
    if (!gameLive || !linescoreData?.totals || !result) return null;
    const dec = result.decision;
    if (dec) return null; // already has a real decision
    const homeRuns = linescoreData.totals.home?.runs || 0;
    const awayRuns = linescoreData.totals.away?.runs || 0;
    const teamRuns = isHome ? homeRuns : awayRuns;
    const oppRuns = isHome ? awayRuns : homeRuns;
    if (teamRuns > oppRuns) return "W";
    if (teamRuns < oppRuns) return "L";
    return "ND";
  }, [gameLive, linescoreData, result, isHome]);

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

  // Season-average deltas: we can compare the current game against either the
  // pitcher's previous season (e.g. 2025) OR their season-to-date up to this
  // start (e.g. 2026 before this game). Both are cached separately once fetched.
  const [currentSeasonAvgs, setCurrentSeasonAvgs] = useState(null); // 2026 STD
  const [prevSeasonAvgs, setPrevSeasonAvgs] = useState(null);       // 2025
  const [loadingAvgs, setLoadingAvgs] = useState(false);
  const [compareTo, setCompareTo] = useState(null); // "current" | "prev" | null (pending)
  const [schedule, setSchedule] = useState(null);

  // Cross-component pitch hover highlight (shared between SZ plots and movement plot)
  const [crossHoverPitch, setCrossHoverPitch] = useState(null);
  // Pitch type selected by clicking a row in the pitch data table
  const [selectedPitchType, setSelectedPitchType] = useState(null);

  // Pitch-type filter for plots (null = all selected on init)
  const [pitchTypeFilter, setPitchTypeFilter] = useState(null);
  // Pitch-result filter for plots (null = all selected on init)
  const [resultFilter, setResultFilter] = useState(null);
  // Contact quality filter: "all" | "hard" | "weak"
  const [contactFilter, setContactFilter] = useState("all");

  // Determine which season to compare against
  const currentYear = date ? parseInt(date.slice(0, 4)) : new Date().getFullYear();
  const prevSeason = currentYear - 1;
  const gamePk = result?.game_pk;

  // Helper: does a season-averages payload actually contain any pitch data?
  const hasAvgData = (avgs) => avgs && typeof avgs === "object" && Object.keys(avgs).length > 0;

  // Fetch current-season-to-date averages (excluding this game) on mount.
  // If there's prior data, default compareTo to "current"; otherwise default
  // to "prev" and lazily fetch the previous season below.
  useEffect(() => {
    if (currentSeasonAvgs !== null || !pitcher_id || !date) return;
    setLoadingAvgs(true);
    fetchSeasonAverages(pitcher_id, currentYear, { beforeDate: date, excludeGamePk: gamePk })
      .then(avgs => {
        const payload = avgs || {};
        setCurrentSeasonAvgs(payload);
        // Only set default once — user selection should survive re-renders.
        setCompareTo(prev => prev || (hasAvgData(payload) ? "current" : "prev"));
        setLoadingAvgs(false);
      })
      .catch(() => {
        setCurrentSeasonAvgs({});
        setCompareTo(prev => prev || "prev");
        setLoadingAvgs(false);
      });
  }, [currentSeasonAvgs, pitcher_id, date, gamePk, currentYear]);

  // Fetch previous-season averages on demand (when selected, or as fallback).
  useEffect(() => {
    if (prevSeasonAvgs !== null || !pitcher_id) return;
    if (compareTo !== "prev") return;
    setLoadingAvgs(true);
    fetchSeasonAverages(pitcher_id, prevSeason)
      .then(avgs => { setPrevSeasonAvgs(avgs || {}); setLoadingAvgs(false); })
      .catch(() => { setPrevSeasonAvgs({}); setLoadingAvgs(false); });
  }, [prevSeasonAvgs, pitcher_id, prevSeason, compareTo]);

  // The season averages object passed to PitchDataTable for delta rendering
  const seasonAvgs = compareTo === "current" ? currentSeasonAvgs : prevSeasonAvgs;

  // Dual season totals (MLB + MiLB) wired in v9. Fall back to legacy
  // single `season_totals` field for older cached payloads.
  const hasAvailableLevels = Array.isArray(cardData.available_levels);
  const hasMlbLevel = hasAvailableLevels ? cardData.available_levels.includes("mlb") : true;
  const hasMilbLevel = hasAvailableLevels ? cardData.available_levels.includes("aaa") : true;
  const seasonTotalsMlb = hasMlbLevel && (cardData.season_totals_mlb && cardData.season_totals_mlb.games)
    ? cardData.season_totals_mlb : null;
  const seasonTotalsMilb = hasMilbLevel && (cardData.season_totals_milb && cardData.season_totals_milb.games)
    ? cardData.season_totals_milb : null;
  // Backward-compat: if neither dual field is present, treat the legacy
  // `season_totals` as belonging to the card's level.
  const legacySeasonTotals = (!seasonTotalsMlb && !seasonTotalsMilb && inlineSeasonTotals && inlineSeasonTotals.games)
    ? inlineSeasonTotals : null;
  // MLB game cards never display the MiLB row — only AAA cards show both
  // levels when the pitcher has games at MLB and MiLB this season.
  const showBothLevels = level === "aaa" && !!seasonTotalsMlb && !!seasonTotalsMilb;

  // Fetch next scheduled starts. The schedule sheet is MLB-only (Probables
  // tab on the staff Google Sheet) — skip the fetch entirely for AAA so
  // we don't render a stale/empty "Next Three Starts" section.
  useEffect(() => {
    if (level === "aaa") { setSchedule(null); return; }
    if (name && date) {
      fetchPitcherSchedule(name, date)
        .then(data => setSchedule(data?.starts || []))
        .catch(() => setSchedule(null));
    }
  }, [name, date, level]);

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
      let pitcherPAs = (half.pas || []).filter(pa => pa.pitcher_id === pitcher_id);
      // Apply batter hand filter
      if (batterFilter === "L") pitcherPAs = pitcherPAs.filter(pa => pa.stand === "L");
      else if (batterFilter === "R") pitcherPAs = pitcherPAs.filter(pa => pa.stand === "R");
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
  }, [linescoreData, pitcher_id, batterFilter]);

  // Available pitch types in this game (for filter options)
  const availablePitchTypes = useMemo(() => {
    if (!pitches) return [];
    const types = new Set(pitches.map(p => p.pitch_name).filter(Boolean));
    return [...types].sort();
  }, [pitches]);

  // Lazy-init pitch type filter to all types
  const effectivePitchTypeFilter = useMemo(() => {
    if (pitchTypeFilter === null) return new Set(availablePitchTypes);
    return pitchTypeFilter;
  }, [pitchTypeFilter, availablePitchTypes]);

  // Lazy-init result filter to all options
  const effectiveResultFilter = useMemo(() => {
    if (resultFilter === null) return new Set(RESULT_FILTER_OPTIONS);
    return resultFilter;
  }, [resultFilter]);

  // Filter pitches for plots: batter hand + pitch type + result + contact quality
  const filteredPitches = useMemo(() => {
    if (!pitches) return [];
    let fp = pitches;
    if (batterFilter === "L") fp = fp.filter(p => p.stand === "L");
    else if (batterFilter === "R") fp = fp.filter(p => p.stand === "R");
    // Apply pitch type filter
    if (pitchTypeFilter !== null) {
      fp = fp.filter(p => effectivePitchTypeFilter.has(p.pitch_name));
    }
    // Apply contact quality filter (Hard BIP / Weak BIP) — only balls in play
    if (contactFilter !== "all") {
      fp = fp.filter(p => {
        if (!isBallInPlay(p)) return false;
        const quality = classifyBIPQuality(p.launch_speed, p.launch_angle);
        return contactFilter === "hard" ? quality === "Hard" : quality === "Weak";
      });
    }
    // Apply result filter
    if (resultFilter !== null) {
      fp = fp.filter(p => {
        const cat = classifyPitchResult(p);
        // "Run(s)" is an overlay — check separately
        if (effectiveResultFilter.has("Run(s)") && isRunScored(p)) return true;
        // "Strikeout" is an overlay — strikeout PA's last pitch is classified as
        // Called Strike or Whiff by description, so check the event directly
        if (effectiveResultFilter.has("Strikeout") && isStrikeoutPitch(p)) return true;
        // "Walk" overlay — the ball-four pitch that ends a walk PA only. Requires:
        // balls==3 pre-pitch, pitch outcome is a ball, PA event is a walk, not HBP.
        if (effectiveResultFilter.has("Walk")) {
          const ev = (p.events || "").toLowerCase();
          const desc = (p.description || "").toLowerCase();
          if (p.balls === 3 && cat === "Ball" && ev === "walk" && desc !== "hit_by_pitch") return true;
        }
        return effectiveResultFilter.has(cat) || (cat === "Other");
      });
    }
    return fp;
  }, [pitches, batterFilter, pitchTypeFilter, effectivePitchTypeFilter, contactFilter, resultFilter, effectiveResultFilter]);

  return (
    <div className="card">
      {/* ===== TOP ROW: Player Info + Box Score ===== */}
      <div className="card-top">
        <div className="card-info">
          {onPlayerClick && pitcher_id ? (
            <a className="card-name" href={playerHref} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onPlayerClick(pitcher_id, e); } }} style={{ cursor: "pointer", textDecoration: "none" }}>{nameWithOrg}</a>
          ) : (
            <div className="card-name">{nameWithOrg}</div>
          )}
          <div className="card-meta">
            {milbAbbrev(team)} · {hand}HP ·{" "}
            {onGameClick ? (
              <a className="card-game-link" href={cardHref} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onGameClick(e); } }} role="button" tabIndex={0}>
                {dateDisplay} {oppPrefix} {milbAbbrev(opponent)}
              </a>
            ) : (
              <span>{dateDisplay} {oppPrefix} {milbAbbrev(opponent)}</span>
            )}
          </div>
          {cardData.game_weather && (
            <div style={{ fontSize: 13, color: "var(--text)", opacity: 0.8, marginTop: 4 }}>
              Game Temperature:{" "}
              {cardData.game_weather.type === "dome"
                ? "Dome"
                : <>{cardData.game_weather.temp}°{cardData.game_weather.precip && <>{" "}<strong>{cardData.game_weather.precip}</strong></>}</>
              }
            </div>
          )}
          {schedule && (
            <div className="card-schedule" style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 4 }}>
              <div style={{ color: "var(--text)", fontWeight: 500, marginBottom: 2 }}>Next Three Starts:</div>
              {schedule.map((s, i) => (
                <div key={i} style={{ lineHeight: 1.5 }}>
                  <span style={{ color: "#c8cbe0", fontWeight: 600 }}>{s.date}:</span>{" "}
                  <span style={{ color: getOpponentTierColor(s.opponent, s.is_away), fontWeight: 700 }}>{s.is_away ? "@ " : "vs. "}{displayAbbrev(s.opponent)}</span>
                  {s.day && <span style={{ color: "var(--text-dim)" }}> ({s.day})</span>}
                </div>
              ))}
              {Array.from({ length: Math.max(0, 3 - (schedule.length || 0)) }).map((_, i) => (
                <div key={`tbd-${i}`} style={{ lineHeight: 1.5 }}>TBD</div>
              ))}
            </div>
          )}
        </div>
        {result && (
          <div className="card-gameline-box">
            <div className="card-gameline-header">
              <span>Box Score</span>
              {gameLive && <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400, marginLeft: "auto" }}>* = Decision if the game ended now</span>}
            </div>
            <table className="card-gameline-table">
              <thead>
                <tr>
                  <th>Pitcher</th><th>Dec</th><th>IP</th><th>R</th><th>ER</th><th>Hits</th><th>BB</th>
                  <th className="gameline-divider-right">K</th>
                  <th>Whiffs</th><th>SwStr%</th><th>CSW%</th><th>Strike%</th><th>2Str%</th><th>PAR%</th><th>#</th><th>HR</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="card-pitcher-name" style={{ color: "#ffc277" }}>{nameWithOrg}</td>
                  {(() => {
                    const dec = result.decision || (projectedDecision ? projectedDecision : "ND");
                    const isProjected = !result.decision && projectedDecision;
                    const label = isProjected ? dec + "*" : dec;
                    const color = dec === "W" ? "#6DE95D" : dec === "L" ? "#FF839B" : "#8a8eb0";
                    return <td style={{ color, fontWeight: dec !== "ND" ? 700 : 500 }}>{label}</td>;
                  })()}
                  <td>{result.ip}</td>
                  <td>{result.runs != null ? result.runs : "-"}</td>
                  <td>{result.er}</td>
                  <td>{result.hits}</td>
                  <td>{result.bbs}</td>
                  <td className="gameline-divider-right">{result.ks}</td>
                  <td>{result.whiffs}</td>
                  <td>{result.swstr_pct != null ? Math.round(result.swstr_pct) + "%" : "-"}</td>
                  <td>{result.csw_pct != null ? Math.round(result.csw_pct) + "%" : "-"}</td>
                  <td>{result.strike_pct != null ? Math.round(result.strike_pct) + "%" : "-"}</td>
                  <td>{result.two_str_pct != null ? Math.round(result.two_str_pct) + "%" : "-"}</td>
                  <td>{result.par_pct != null ? Math.round(result.par_pct) + "%" : "-"}</td>
                  <td>{result.pitches}</td>
                  <td>{result.hrs}</td>
                </tr>
                {(() => {
                  // Build the totals rows: MLB + MiLB if both, else single row.
                  const renderTotalsRow = (st, label, key) => {
                    if (!st || !(st.games >= 1)) return null;
                    const g = st.games;
                    const gs = st.games_started || 0;
                    const ipThirds = st.ip_thirds || 0;
                    const ip = ipThirds / 3;
                    const bf = st.batters_faced || 0;
                    const wins = st.wins || 0;
                    const losses = st.losses || 0;
                    const ipg = ip > 0 ? (ip / g).toFixed(1) : "-";
                    const era = ip > 0 ? ((st.er / ip) * 9).toFixed(2) : "-";
                    const whip = ip > 0 ? ((st.hits + st.bbs) / ip).toFixed(2) : "-";
                    const h9 = ip > 0 ? ((st.hits / ip) * 9).toFixed(1) : "-";
                    const bbPct = bf > 0 ? (st.bbs / bf * 100).toFixed(1) + "%" : "-";
                    const kPct = bf > 0 ? (st.ks / bf * 100).toFixed(1) + "%" : "-";
                    const whfg = g > 0 ? (st.whiffs / g).toFixed(1) : "-";
                    const ppg = g > 0 ? Math.round(st.pitches / g) : "-";
                    const hr9 = ip > 0 ? ((st.hrs / ip) * 9).toFixed(2) : "-";
                    const gamesLabel = gs > 0 && gs !== g ? `${g} Games (${gs} GS)` : `${g} Games`;
                    // Asterisk on the 3 pitch-level columns when MiLB row had
                    // AA games whose PBP failed to load (data is then AAA-only).
                    const partial = new Set(st.partial_fields || []);
                    const ast = (col) => partial.has(col)
                      ? <span className="partial-marker" title="Only Triple-A data available">*</span>
                      : null;
                    return (
                      <tr className="pp-total-row" key={key}>
                        <td className="card-pitcher-name pp-total-label"><span className="rate-label">{label}</span>{gamesLabel}</td>
                        <td><span className="rate-label">W-L</span>{wins}-{losses}</td>
                        <td><span className="rate-label">IP/G</span>{ipg}</td>
                        <td><span className="rate-label">ERA</span>{era}</td>
                        <td><span className="rate-label">WHIP</span>{whip}</td>
                        <td><span className="rate-label">H/9</span>{h9}</td>
                        <td><span className="rate-label">BB%</span>{bbPct}</td>
                        <td className="gameline-divider-right"><span className="rate-label">K%</span>{kPct}</td>
                        <td><span className="rate-label">Whf/G</span>{whfg}</td>
                        <td><span className="rate-label">SwStr%</span>{st.swstr_pct != null ? Math.round(st.swstr_pct) + "%" : "-"}</td>
                        <td><span className="rate-label">CSW%</span>{st.csw_pct != null ? Math.round(st.csw_pct) + "%" : "-"}{ast("csw_pct")}</td>
                        <td><span className="rate-label">Str%</span>{st.strike_pct != null ? Math.round(st.strike_pct) + "%" : "-"}</td>
                        <td><span className="rate-label">2Str%</span>{st.two_str_pct != null ? Math.round(st.two_str_pct) + "%" : "-"}{ast("two_str_pct")}</td>
                        <td><span className="rate-label">PAR%</span>{st.par_pct != null ? Math.round(st.par_pct) + "%" : "-"}{ast("par_pct")}</td>
                        <td><span className="rate-label">PPG</span>{ppg}</td>
                        <td><span className="rate-label">HR/9</span>{hr9}</td>
                      </tr>
                    );
                  };
                  if (showBothLevels) {
                    return [
                      renderTotalsRow(seasonTotalsMlb, "MLB Total", "row-mlb"),
                      renderTotalsRow(seasonTotalsMilb, "MiLB Total", "row-milb"),
                    ];
                  }
                  // Single-level: pick the level-appropriate totals so MLB
                  // cards never fall back to MiLB data and vice versa.
                  const single = level === "aaa"
                    ? (seasonTotalsMilb || legacySeasonTotals)
                    : (seasonTotalsMlb || legacySeasonTotals);
                  return renderTotalsRow(single, "Season Total", "row-single");
                })()}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===== PITCH TYPE METRICS / PLAY-BY-PLAY ===== */}
      <div className="card-section">
        <div className="metrics-header">
          {isMobile ? (
            <select className="metrics-subnav-mobile" value={metricsView} onChange={e => setMetricsView(e.target.value)}>
              <option value="pitch-data">Pitch Overview</option>
              <option value="results">Results</option>
              <option value="usage">Usage</option>
              <option value="velocity-trend">Velocity Trend</option>
              {pitcherPBP && <option value="play-by-play">Play-by-Play</option>}
            </select>
          ) : (
            <div className="metrics-subnav">
              <button className={`metrics-subnav-btn${metricsView === "pitch-data" ? " active" : ""}`} onClick={() => setMetricsView("pitch-data")}>
                Pitch Overview
              </button>
              <button className={`metrics-subnav-btn${metricsView === "results" ? " active" : ""}`} onClick={() => setMetricsView("results")}>
                Results
              </button>
              <button className={`metrics-subnav-btn${metricsView === "usage" ? " active" : ""}`} onClick={() => setMetricsView("usage")}>
                Usage
              </button>
              <button className={`metrics-subnav-btn${metricsView === "velocity-trend" ? " active" : ""}`} onClick={() => setMetricsView("velocity-trend")}>
                Velocity Trend
              </button>
              {pitcherPBP && (
                <button className={`metrics-subnav-btn${metricsView === "play-by-play" ? " active" : ""}`} onClick={() => setMetricsView("play-by-play")}>
                  Play-by-Play
                </button>
              )}
            </div>
          )}
          <div className="metrics-controls">
            <div className="filter-pill-group">
              <span className="filter-pill-label">Compare to</span>
              <select className="game-filter-select" value={compareTo || "current"}
                onChange={e => setCompareTo(e.target.value)}>
                <option value="current">{currentYear}</option>
                <option value="prev">{prevSeason}</option>
              </select>
            </div>
            <div className="filter-pill-group">
              <span className="filter-pill-label">LHB/RHB</span>
              <select className="game-filter-select" value={batterFilter}
                onChange={e => setBatterFilter(e.target.value)}>
                <option value="all">vs. All</option>
                <option value="L">vs LHB</option>
                <option value="R">vs RHB</option>
              </select>
            </div>
          </div>
        </div>
        {metricsView === "pitch-data" && (
          <div className="metrics-card">
            <PitchDataTable data={activePitchTable} columns={CARD_PITCH_DATA_COLUMNS}
              splitByTeam={false} spOnly={false} pitcherHand={hand}
              sortable={false}
              showChange={true} seasonAvgs={seasonAvgs}
              batterFilter={batterFilter} isMobile={isMobile}
              selectedPitchType={selectedPitchType}
              onPitchTypeClick={(type) => setSelectedPitchType(prev => prev === type ? null : type)} />
            {loadingAvgs && <div className="loading-avgs"><div className="loading-bars loading-bars-sm"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div></div>}
          </div>
        )}
        {metricsView === "results" && (
          <div className="metrics-card">
            <ResultsTable pitches={pitches} batterFilter={batterFilter} gameFilter="all" isMobile={isMobile}
              selectedPitchType={selectedPitchType}
              onPitchTypeClick={(type) => setSelectedPitchType(prev => prev === type ? null : type)} />
          </div>
        )}
        {metricsView === "usage" && (
          <div className="metrics-card">
            <UsageTable pitches={pitches} batterFilter={batterFilter} gameFilter="all" isMobile={isMobile}
              selectedPitchType={selectedPitchType}
              onPitchTypeClick={(type) => setSelectedPitchType(prev => prev === type ? null : type)} />
          </div>
        )}
        {metricsView === "velocity-trend" && (
          <div className="metrics-card">
            <VelocityTrendV2 pitches={filteredPitches} onReclassify={onReclassify} isMobile={isMobile} linescoreData={linescoreData} pitcherId={pitcher_id} level={level} />
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
                      <span className="card-pbp-inning-stats" style={{ fontSize: 12, marginLeft: 6 }}>
                        {"- "}{stats.ip} IP · {stats.runs} Runs · {stats.hits} Hits · {stats.bbs} BB · {stats.ks} K · {stats.hrs} HR · {stats.pitches} Pitches
                      </span>
                    </div>
                    {seg.pas.map((pa, pi) => {
                      const paKey = `${si}-${pi}`;
                      const isActive = pbpActivePa === paKey;
                      const isExp = pbpExpanded[paKey];
                      const isFinalPa = si === pitcherPBP.segments.length - 1 && pi === seg.pas.length - 1;
                      const isK = isStrikeout(pa.result);
                      const realPitches = pa.pitches?.filter(p => !p.is_action) || [];
                      const lastPitch = realPitches.length > 0 ? realPitches[realPitches.length - 1] : null;
                      const bbType = !isK ? classifyBattedBallFull(pa.launch_speed, pa.launch_angle) : null;
                      const bbColor = bbType ? BATTED_BALL_COLORS[bbType] : null;

                      // Use tooltip result system for consistent colors
                      const paResult = getTooltipResult({}, {
                        desc: lastPitch?.desc || "",
                        paResult: pa.result,
                        isLastPitch: true,
                        launchAngle: pa.launch_angle,
                      });
                      const resultLabel = paResult.label;
                      const resultColor = paResult.color;

                      // Detect runs scored by comparing score to previous PA in the full half-inning
                      let runsScored = 0;
                      if (pa.away_score != null && pa.home_score != null) {
                        const curTotal = pa.away_score + pa.home_score;
                        const allIdx = seg.allPas.indexOf(pa);
                        if (allIdx > 0) {
                          const prev = seg.allPas[allIdx - 1];
                          if (prev.away_score != null && prev.home_score != null) {
                            runsScored = curTotal - (prev.away_score + prev.home_score);
                          }
                        } else if (allIdx === 0 && linescoreData?.innings) {
                          // First PA of half-inning: compute pre-inning score
                          let preAway = 0, preHome = 0;
                          for (const inn of linescoreData.innings) {
                            if (inn.num < seg.inning) {
                              preAway += inn.away?.runs || 0;
                              preHome += inn.home?.runs || 0;
                            } else if (inn.num === seg.inning && !seg.isTop) {
                              preAway += inn.away?.runs || 0;
                            }
                          }
                          runsScored = curTotal - (preAway + preHome);
                        }
                      }

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
                                {runsScored > 0 && (
                                  <span className="card-pbp-rbi">
                                    <span style={{ color: "#FF5EDC" }}>- {runsScored} Run{runsScored !== 1 ? "s" : ""} score{runsScored === 1 ? "s" : ""}.{" "}</span>
                                    {pa.away_score != null && pa.home_score != null && (() => {
                                      const awayDisp = displayTeamAbbrev(linescoreData.away_team, level) || linescoreData.away_team;
                                      const homeDisp = displayTeamAbbrev(linescoreData.home_team, level) || linescoreData.home_team;
                                      const battingTeam = seg.isTop ? linescoreData.away_team : linescoreData.home_team;
                                      const awayScored = linescoreData.away_team === battingTeam;
                                      const homeScored = linescoreData.home_team === battingTeam;
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
                              <span className="card-pbp-result" style={{ color: resultColor }}>
                                {paResult.isError && paResult.errorOutType
                                  ? <>{paResult.errorOutType} <span style={{ color: "#ffa3a3" }}>(Error)</span></>
                                  : resultLabel}
                                {paResult.isK && (
                                  paResult.isCalledStrikeThree
                                    ? <span style={{ marginLeft: 3 }}>(<span style={{ display: "inline-block", transform: "scaleX(-1)" }}>K</span>)</span>
                                    : <span style={{ marginLeft: 3 }}>(K)</span>
                                )}
                              </span>
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
                            {pa.description && (() => {
                              const isCIErr = paResult.isError || isCIOrErrorEvent(pa.result);
                              const _r = (pa.result || "").toLowerCase().replace(/\s+/g, "_");
                              const _isHit = _r === "single" || _r === "double" || _r === "triple";
                              const isHitWithOut = _isHit && /\bout at\b|\bout advancing\b|\bthrown out\b/i.test(pa.description);
                              const baseColor = isCIErr ? "#feffa3" : resultColor;
                              return (
                                <div className="card-pbp-desc" style={{ color: baseColor }}>
                                  {getPADescriptionSpans(pa.description, { isCIOrError: isCIErr, isHitWithOut }).map((s, idx) => (
                                    <span key={idx} style={s.style || undefined}>{s.text}</span>
                                  ))}
                                </div>
                              );
                            })()}
                            {!isK && pa.launch_speed != null && (
                              <div className="card-pbp-evla">
                                {pa.launch_speed.toFixed(1)} EV{pa.launch_angle != null ? ` · ${pa.launch_angle.toFixed(0)}° LA` : ""}
                                {bbType && <span style={{ color: bbColor, fontStyle: "normal", fontWeight: 600, marginLeft: 6 }}>{bbType}</span>}
                              </div>
                            )}
                            {/* Expanded pitch-by-pitch table */}
                            {isExp && pa.pitches?.length > 0 && (
                              <div className="pbp-pitches">
                                <div className="pbp-pitch-hdr">
                                  <span className="pbp-ph-num">#</span>
                                  <span className="pbp-ph-count">CT.</span>
                                  <span className="pbp-ph-speed">MPH</span>
                                  <span className="pbp-ph-type">TYPE</span>
                                  <span className="pbp-ph-desc">RESULT</span>
                                </div>
                                {pa.pitches.map((p, j) => {
                                  if (p.is_action) {
                                    const _actDesc = (p.desc || "").toLowerCase();
                                    const _actEvt = (p.event_type || "").toLowerCase();
                                    const _isWpPb = _actDesc.includes("wild pitch") || _actDesc.includes("passed ball")
                                      || _actEvt.includes("wild_pitch") || _actEvt.includes("passed_ball");
                                    const actionColor = (p.is_error || _isWpPb) ? "#ffa3a3" : p.scored ? "#FF5EDC" : "rgba(180,184,210,0.7)";
                                    return (
                                      <div key={j} className="pbp-pitch-row pbp-action-row">
                                        <span className="pbp-action-desc" style={{ color: actionColor }}>{p.desc}</span>
                                      </div>
                                    );
                                  }
                                  const pColor = PITCH_COLORS[p.type] || "#888";
                                  const lastPitchIdx = pa.pitches.filter(x => !x.is_action).length - 1;
                                  const pitchOnlyIdx = pa.pitches.filter((x, k) => !x.is_action && k <= j).length - 1;
                                  const isLastPitch = pitchOnlyIdx === lastPitchIdx;
                                  const pResult = getTooltipResult(p, {
                                    desc: p.desc,
                                    paResult: isLastPitch ? pa.result : null,
                                    isLastPitch,
                                    launchAngle: isLastPitch ? pa.launch_angle : null,
                                  });
                                  return (
                                    <div key={j} className="pbp-pitch-row">
                                      <span className="pbp-ph-num">{p.num}</span>
                                      <span className="pbp-ph-count">{p.count}</span>
                                      <span className="pbp-ph-speed">{p.speed != null ? Number(p.speed).toFixed(1) : "—"}</span>
                                      <span className="pbp-ph-type" style={{ color: pColor }}>{p.type}</span>
                                      <span className="pbp-ph-desc" style={{ color: pResult.color }}>{p.desc}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                          {/* Right: SZ plot (only next to active PA) */}
                          {isActive && realPitches.length > 0 && (
                            <div className="card-pbp-sz" style={{ position: "absolute", top: isFinalPa ? "auto" : 0, bottom: isFinalPa ? 0 : "auto", left: 689, zIndex: 10 }}>
                              <StrikeZonePBP
                                pitches={realPitches}
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
                                const isLastPitch = realPitches.indexOf(hp) === realPitches.length - 1;
                                const result = getTooltipResult(hp, {
                                  desc: hp.desc,
                                  paResult: pa.result,
                                  isLastPitch,
                                  launchAngle: isLastPitch ? pa.launch_angle : null,
                                });

                                const isBIP = isLastPitch && hp.launch_speed != null && hp.launch_angle != null &&
                                  (hp.desc || "").toLowerCase().includes("in play");
                                const bbTag2 = isBIP ? classifyBattedBallFull(hp.launch_speed, hp.launch_angle) : null;
                                const bbColor2 = bbTag2 ? (BATTED_BALL_COLORS[bbTag2] || "rgba(180,184,210,0.7)") : null;

                                const countParts = (hp.count || "0-0").split("-");
                                const balls = countParts[0] || "0";
                                const strikes = countParts[1] || "0";

                                return (
                                  <div className="pitch-tooltip" style={(() => {
                                    const tx = pbpPitchHover.clientX + 16;
                                    const ty = pbpPitchHover.clientY - 16;
                                    const leftVp = tx + 300 > window.innerWidth ? pbpPitchHover.clientX - 310 : tx;
                                    const topVp = ty < 10 ? pbpPitchHover.clientY + 16 : (ty + 280 > window.innerHeight ? pbpPitchHover.clientY - 280 : ty);
                                    return {
                                      position: "fixed",
                                      // Compensate for body { zoom: 1.25 } on desktop.
                                      left: vpToZoomCoord(leftVp),
                                      top: vpToZoomCoord(topVp),
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
                                        {result.isError && result.errorOutType
                                          ? <>{result.errorOutType} <span style={{ color: "#ffa3a3" }}>(Error)</span></>
                                          : result.label}
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
                                        {bbTag2 && (
                                          <div style={{ color: bbColor2, fontWeight: 600, fontSize: "0.85em", marginLeft: 12 }}>
                                            {bbTag2}
                                          </div>
                                        )}
                                      </div>
                                    )}

                                    {/* vs Batter (left) | Strikeout sub-label (right) — full width above body columns */}
                                    <div className="pt-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, fontSize: "0.85em" }}>
                                      <span>vs {pa.batter}</span>
                                      {result.isK && result.subLabel && (
                                        <span style={{ color: "rgba(180,184,210,0.7)" }}>{result.subLabel}</span>
                                      )}
                                    </div>

                                    {/* Body: text left, strikezone right */}
                                    <div style={{ display: "flex", gap: 10 }}>
                                      <div style={{ flex: 1 }}>
                                        <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                                          {seg.isTop ? "Top" : "Bot"} {ordinal(seg.inning)} | {pa.outs || 0} Out{(pa.outs || 0) !== 1 ? "s" : ""}
                                        </div>
                                        <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                                          {pa.outs || 0} Outs | {balls}-{strikes}
                                        </div>
                                        {hp.pfx_z != null && hp.pfx_x != null && (
                                          <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                                            iVB {hp.pfx_z.toFixed(1)}" · iHB {(-hp.pfx_x).toFixed(1)}"
                                            {hp.release_extension != null && ` · Ext ${hp.release_extension.toFixed(1)}ft`}
                                          </div>
                                        )}
                                      </div>
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
                                              const isLeft = (pa.stand || "R") === "L";
                                              const lx = isLeft ? 6 : 59;
                                              const letters = isLeft ? ["L", "H", "B"] : ["R", "H", "B"];
                                              return letters.map((ch, idx) => (
                                                <text key={idx} x={lx} y={33 + idx * 10} fill="rgba(150,155,185,0.28)" fontSize="7" fontWeight="bold" textAnchor="middle" dominantBaseline="middle" fontFamily="'DM Sans', sans-serif">{ch}</text>
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
        <div className="sz-mode-select-row filter-controls-row">
          <div className="filter-pill-group">
            <span className="filter-pill-label">Plot Display</span>
            <select className="sz-mode-select" value={szColorMode} onChange={e => setSzColorMode(e.target.value)}>
              <option value="pitch-type">Pitch Types</option>
              <option value="pitch-result">Pitch Results</option>
              <option value="pa-result">PA Results</option>
            </select>
          </div>
          <div className="filter-pill-group">
            <span className="filter-pill-label">Pitch Type Filter</span>
            <PitchFilterDropdown
              label="All Pitches"
              options={availablePitchTypes}
              selected={effectivePitchTypeFilter}
              onChange={setPitchTypeFilter}
              colorMap={PITCH_COLORS}
            />
          </div>
          <div className="filter-pill-group">
            <span className="filter-pill-label">Result Filter</span>
            <PitchFilterDropdown
              label="Results"
              options={RESULT_FILTER_OPTIONS}
              selected={effectiveResultFilter}
              onChange={setResultFilter}
              columns={2}
              quickActions={RESULT_QUICK_ACTIONS}
            />
          </div>
          <div className="filter-pill-group">
            <span className="filter-pill-label">Contact</span>
            <select className="game-filter-select" value={contactFilter} onChange={e => setContactFilter(e.target.value)}>
              <option value="all">All Pitches</option>
              <option value="hard">Hard BIP</option>
              <option value="weak">Weak BIP</option>
            </select>
          </div>
        </div>
        <div className="card-visuals">
          <div className="card-sz-pair">
            {(batterFilter === "all" || batterFilter === "L") && (
              <div className="viz-card">
                <div className="viz-card-label">vs LHB</div>
                <StrikeZonePlot pitches={filteredPitches} szTop={sz_top} szBot={sz_bot} stand="L" colorMode={szColorMode} onReclassify={onReclassify} isMobile={isMobile} highlightPitch={crossHoverPitch} highlightType={!crossHoverPitch ? selectedPitchType : null} onPitchHover={setCrossHoverPitch} />
              </div>
            )}
            {(batterFilter === "all" || batterFilter === "R") && (
              <div className="viz-card">
                <div className="viz-card-label">vs RHB</div>
                <StrikeZonePlot pitches={filteredPitches} szTop={sz_top} szBot={sz_bot} stand="R" colorMode={szColorMode} onReclassify={onReclassify} isMobile={isMobile} highlightPitch={crossHoverPitch} highlightType={!crossHoverPitch ? selectedPitchType : null} onPitchHover={setCrossHoverPitch} />
              </div>
            )}
        </div>
          <div className="viz-card">
            <div className="viz-card-label">Pitch Movement</div>
            <MovementPlot pitches={filteredPitches} hand={hand} onReclassify={onReclassify} isMobile={isMobile} highlightPitch={crossHoverPitch} highlightType={!crossHoverPitch ? selectedPitchType : null} onPitchHover={setCrossHoverPitch} />
          </div>
        </div>
      </div>
    </div>
  );
}
