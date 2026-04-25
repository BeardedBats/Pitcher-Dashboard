import React, { useState, useEffect, useMemo } from "react";
import { PITCH_COLORS, CARD_PITCH_DATA_COLUMNS, displayTeamAbbrev, displayAbbrev as displayMlbAbbrev, isAAATeam } from "../constants";
import { fetchSeasonAverages, fetchPitcherSchedule, fetchGameLinescore } from "../utils/api";
import { getOpponentTierColor } from "../constants";
import useIsMobile from "../hooks/useIsMobile";
import PitchDataTable from "./PitchDataTable";
import StrikeZonePlot from "./StrikeZonePlot";
import MovementPlot from "./MovementPlot";
import PitchFilterDropdown from "./PitchFilterDropdown";
import ResultsTable from "./ResultsTable";
import UsageTable from "./UsageTable";
import ErrorPill from "./ErrorPill";
import { classifyPitchResult, isRunScored, isStrikeoutPitch, isBallInPlay, classifyBIPQuality, RESULT_FILTER_OPTIONS, RESULT_QUICK_ACTIONS } from "../utils/pitchFilters";
import VelocityTrend from "./VelocityTrend";

const API = window.__BACKEND_PORT__
  ? `http://localhost:${window.__BACKEND_PORT__}`
  : process.env.NODE_ENV === "development" ? "http://localhost:8000" : "";

export default function PlayerPage({ pitcherId, onBack, onGameClick, onChangeLevel, level = "mlb" }) {
  const isMobile = useIsMobile();
  // For MiLB views we want the raw minor-league abbreviation (BUF, OKC, …)
  // in the game log and header — not the parent MLB org. Parent abbrev is
  // used only as the org suffix after the player name (e.g., "Jackson
  // Ferris (LAD)"). At MLB level this collapses to the standard MLB display
  // abbrev mapping, so MLB views are unchanged.
  const displayAbbrev = (abbr) => level === "aaa" ? displayMlbAbbrev(abbr) : displayTeamAbbrev(abbr, level);
  const parentOrg = (abbr) => level === "aaa" ? displayTeamAbbrev(abbr, level) : null;
  // Track whether we've already attempted the smart redirect for this pitcher
  // so we don't bounce back and forth between MLB / Minors views on every
  // re-render (the redirect changes `level`, which would re-trigger).
  const smartRedirectedRef = React.useRef(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadMsg, setLoadMsg] = useState("Loading player data...");
  const [seasonAvgs, setSeasonAvgs] = useState(null);
  const [loadingAvgs, setLoadingAvgs] = useState(false);
  const [batterFilter, setBatterFilter] = useState("all");
  const [szColorMode, setSzColorMode] = useState("pitch-type");
  const [metricsView, setMetricsView] = useState("pitch-data"); // "pitch-data" | "results" | "velocity-trend"

  const [schedule, setSchedule] = useState(null);

  // Pitch-type, result, and contact filters for plots
  const [pitchTypeFilter, setPitchTypeFilter] = useState(null);
  const [resultFilter, setResultFilter] = useState(null);
  const [contactFilter, setContactFilter] = useState("all");
  const [crossHoverPitch, setCrossHoverPitch] = useState(null);

  // Game filter for plots AND pitch metrics
  const [gameFilter, setGameFilter] = useState("all");

  // Previous MLB season (resolved at fetch time — may be 2024 or earlier for
  // players returning from injury / first-year starters / etc.)
  const [prevSeason, setPrevSeason] = useState(null);
  const currentYear = new Date().getFullYear();

  // Live-game tracking for the regular season table. If the most recent
  // game in the log is currently in progress (linescore.is_final === false)
  // we project a W/L/ND from the current score and append "*" in the Dec
  // column to flag it as not yet final.
  const [liveGame, setLiveGame] = useState(null); // { game_pk, projectedDecision }

  useEffect(() => {
    setLoading(true);
    setLoadMsg("Loading player data...");
    let cancelled = false;
    let pollTimer = null;
    const pollStatus = () => {
      fetch(`${API}/api/warmup-status`)
        .then((r) => r.json())
        .then((s) => { if (!cancelled && s.progress && s.loading) setLoadMsg(s.progress); })
        .catch(() => {});
      if (!cancelled) pollTimer = setTimeout(pollStatus, 2000);
    };
    pollTimer = setTimeout(pollStatus, 1000);

    const params = new URLSearchParams({
      pitcher_id: pitcherId,
      start_date: "2026-03-25",
    });
    if (level && level !== "mlb") params.set("level", level);
    fetch(`${API}/api/player-page?${params}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { cancelled = true; clearTimeout(pollTimer); setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { cancelled = true; clearTimeout(pollTimer); setLoading(false); } });

    return () => { cancelled = true; clearTimeout(pollTimer); };
  }, [pitcherId, level]);

  // Always fetch season averages for change display.
  // auto_fallback resolves the most recent prior MLB season with data — so
  // deltas and (NEW) tags are relative to the player's actual last MLB season,
  // not a hardcoded year.
  useEffect(() => {
    if (!seasonAvgs && pitcherId) {
      setLoadingAvgs(true);
      fetchSeasonAverages(pitcherId, currentYear, { autoFallback: true, level })
        .then(payload => {
          const avgs = payload?.averages || {};
          setSeasonAvgs(avgs);
          setPrevSeason(payload?.season || null);
          setLoadingAvgs(false);
        })
        .catch(() => { setSeasonAvgs({}); setPrevSeason(null); setLoadingAvgs(false); });
    }
  }, [seasonAvgs, pitcherId, currentYear, level]);

  // Select correct pitch table based on batter filter AND game filter
  const activePitchData = useMemo(() => {
    if (!data) return [];
    let table;
    if (gameFilter !== "all" && data.per_game_summaries) {
      const gameSummary = data.per_game_summaries[String(gameFilter)];
      if (gameSummary) {
        if (batterFilter === "L") table = gameSummary.vs_l;
        else if (batterFilter === "R") table = gameSummary.vs_r;
        else table = gameSummary.all;
      }
    }
    if (!table) {
      if (batterFilter === "L" && data.pitch_summary_vs_l) table = data.pitch_summary_vs_l;
      else if (batterFilter === "R" && data.pitch_summary_vs_r) table = data.pitch_summary_vs_r;
      else table = data.pitch_summary;
    }
    if (table) return [...table].sort((a, b) => (b.count || 0) - (a.count || 0));
    return [];
  }, [data, batterFilter, gameFilter]);

  // Sorted game log (by date ascending for numbering, descending for display).
  // For AAA: drop FSL/non-AAA rows from the displayed log so the "Across X
  // Triple-A Games" header matches the table contents 1:1. The data scope
  // is limited to Statcast-tracked levels (AAA + FSL); non-Statcast minors
  // (AA, High-A non-FSL, Low-A, Rookie) never appear in this pipeline.
  const sortedLog = useMemo(() => {
    if (!data?.game_log) return [];
    let log = [...data.game_log].sort((a, b) => a.date.localeCompare(b.date));
    if (level === "aaa") {
      log = log.filter(g => isAAATeam(g.team));
    }
    return log;
  }, [data, level]);

  // Smart redirect: after data loads, examine which levels the pitcher has
  // and switch to the right one if the URL didn't already match.
  // - MLB-only via #aaa → switch to #player (hide pill, show MLB)
  // - MiLB-only via #player → switch to #aaa/player (hide pill, show Minors)
  // - Both available → first load defaults to season_totals_primary
  // Subsequent toggle clicks (handled by user) bypass this since
  // `smartRedirectedRef.current === pitcherId` after the first attempt.
  useEffect(() => {
    if (!data) return;
    if (smartRedirectedRef.current === pitcherId) return;
    const hasMlb = !!(data.season_totals_mlb && data.season_totals_mlb.games);
    const hasMilb = !!(data.season_totals_milb && data.season_totals_milb.games);
    let target = null;
    if (hasMlb && !hasMilb && level !== "mlb") target = "mlb";
    else if (!hasMlb && hasMilb && level !== "aaa") target = "aaa";
    else if (hasMlb && hasMilb && data.season_totals_primary && data.season_totals_primary !== level) {
      target = data.season_totals_primary === "mlb" ? "mlb" : "aaa";
    }
    smartRedirectedRef.current = pitcherId;
    if (target && onChangeLevel) onChangeLevel(target);
  }, [data, pitcherId, level, onChangeLevel]);

  // Reset the smart-redirect guard when navigating to a different pitcher
  useEffect(() => { smartRedirectedRef.current = null; }, [pitcherId]);

  // Fetch next scheduled starts (must be after sortedLog definition).
  // Skip for AAA — the schedule sheet is MLB-only.
  useEffect(() => {
    if (level === "aaa") { setSchedule(null); return; }
    if (data?.info?.name) {
      const lastGame = sortedLog.length > 0 ? sortedLog[sortedLog.length - 1].date : "";
      fetchPitcherSchedule(data.info.name, lastGame)
        .then(d => setSchedule(d?.starts || []))
        .catch(() => setSchedule(null));
    }
  }, [data?.info?.name, sortedLog, level]);

  // Detect a live game on the latest entry in the regular season log. We
  // poll every 60s while it stays live so the projected decision tracks
  // the current score. is_final === false from the linescore endpoint is
  // the source of truth — game_log boxscores can lag mid-game.
  useEffect(() => {
    if (sortedLog.length === 0) { setLiveGame(null); return; }
    const last = sortedLog[sortedLog.length - 1];
    if (!last?.game_pk) { setLiveGame(null); return; }
    let cancelled = false;
    const compute = (ls) => {
      if (!ls || ls.is_final !== false || !ls.totals) return null;
      const homeRuns = ls.totals.home?.runs || 0;
      const awayRuns = ls.totals.away?.runs || 0;
      const isHome = last.home_team && last.team === last.home_team;
      const teamRuns = isHome ? homeRuns : awayRuns;
      const oppRuns = isHome ? awayRuns : homeRuns;
      let dec = "ND";
      if (teamRuns > oppRuns) dec = "W";
      else if (teamRuns < oppRuns) dec = "L";
      return { game_pk: last.game_pk, projectedDecision: dec };
    };
    const doFetch = () => {
      fetchGameLinescore(last.game_pk)
        .then(ls => { if (!cancelled) setLiveGame(compute(ls)); })
        .catch(() => { if (!cancelled) setLiveGame(null); });
    };
    doFetch();
    const interval = setInterval(() => {
      // Stop polling once it's no longer live.
      setLiveGame(prev => { if (prev) doFetch(); return prev; });
    }, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sortedLog]);

  // Game options for dropdown: numbered by date order
  const gameOptions = useMemo(() => {
    return sortedLog.map((g, i) => ({
      idx: i + 1,
      date: g.date,
      game_pk: g.game_pk,
      opponent: g.opponent,
      label: `${i + 1}. ${formatCompactDate(g.date)} vs ${displayAbbrev(g.opponent)}`,
    }));
  }, [sortedLog]);

  // Available pitch types for filter
  const availablePitchTypes = useMemo(() => {
    if (!data?.pitches) return [];
    let ps = data.pitches;
    if (gameFilter !== "all") {
      ps = ps.filter(p => String(p.game_pk) === String(gameFilter));
    }
    const types = new Set(ps.map(p => p.pitch_name).filter(Boolean));
    return [...types].sort();
  }, [data, gameFilter]);

  const effectivePitchTypeFilter = useMemo(() => {
    if (pitchTypeFilter === null) return new Set(availablePitchTypes);
    return pitchTypeFilter;
  }, [pitchTypeFilter, availablePitchTypes]);

  const effectiveResultFilter = useMemo(() => {
    if (resultFilter === null) return new Set(RESULT_FILTER_OPTIONS);
    return resultFilter;
  }, [resultFilter]);

  // Filtered pitches for plots
  const filteredPitches = useMemo(() => {
    if (!data?.pitches) return [];
    let fp = data.pitches;
    // Game filter
    if (gameFilter !== "all") {
      fp = fp.filter(p => String(p.game_pk) === String(gameFilter));
    }
    // Batter hand filter
    if (batterFilter === "L") fp = fp.filter(p => p.stand === "L");
    else if (batterFilter === "R") fp = fp.filter(p => p.stand === "R");
    // Pitch type filter
    if (pitchTypeFilter !== null) {
      fp = fp.filter(p => effectivePitchTypeFilter.has(p.pitch_name));
    }
    // Result filter
    if (resultFilter !== null) {
      fp = fp.filter(p => {
        const cat = classifyPitchResult(p);
        // "Run(s)" is an overlay category — check separately
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
        return effectiveResultFilter.has(cat) || cat === "Other";
      });
    }
    // Contact filter (Weak BIP / Hard BIP)
    if (contactFilter !== "all") {
      fp = fp.filter(p => {
        if (!isBallInPlay(p)) return false;
        const quality = classifyBIPQuality(p.launch_speed, p.launch_angle);
        if (contactFilter === "weak") return quality === "Weak";
        if (contactFilter === "hard") return quality === "Hard";
        return true;
      });
    }
    return fp;
  }, [data, gameFilter, batterFilter, pitchTypeFilter, effectivePitchTypeFilter, resultFilter, effectiveResultFilter, contactFilter]);

  // Play-by-Play availability: enabled when single game or specific game selected
  const multiGame = sortedLog.length > 1;
  const pbpDisabled = multiGame && gameFilter === "all";

  // Resolve the game_pk for PBP navigation
  const pbpGamePk = useMemo(() => {
    if (gameFilter !== "all") return gameFilter;
    if (sortedLog.length === 1) return sortedLog[0].game_pk;
    return null;
  }, [gameFilter, sortedLog]);

  const pbpGameDate = useMemo(() => {
    if (!pbpGamePk) return null;
    const g = sortedLog.find(g => String(g.game_pk) === String(pbpGamePk));
    return g?.date || null;
  }, [pbpGamePk, sortedLog]);

  const handlePbpClick = () => {
    if (pbpDisabled || !pbpGamePk || !pbpGameDate) return;
    onGameClick(pbpGameDate, pitcherId, pbpGamePk);
  };

  if (loading) {
    return (
      <div className="pp-outer-centered">
        <a className="back-btn" href={window.location.pathname} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onBack(); } }} style={{ textDecoration: "none" }}>← Back</a>
        <div className="loading-msg"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div>{loadMsg}</div>
      </div>
    );
  }

  if (!data?.info?.name) {
    return (
      <div className="pp-outer-centered">
        <a className="back-btn" href={window.location.pathname} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onBack(); } }} style={{ textDecoration: "none" }}>← Back</a>
        <div className="loading-msg">Player not found</div>
      </div>
    );
  }

  const info = data.info;
  // Pick the level-appropriate season totals when v9 dual fields are present.
  // For MLB view: prefer season_totals_mlb. For Minors view: prefer
  // season_totals_milb (which spans Statcast AAA+FSL ⊕ MLB Stats API AA-below
  // PBP). Fall back to legacy results_summary for older cached payloads.
  const rs = (
    (level === "aaa" && data.season_totals_milb) ||
    (level === "mlb" && data.season_totals_mlb) ||
    data.results_summary || {}
  );
  // Asterisk on the 3 pitch-level columns when MiLB row is incomplete (some
  // AA games' PBP failed to load, so those stats are AAA-only).
  const partialFields = new Set(rs.partial_fields || []);
  const ast = (col) => partialFields.has(col)
    ? <span className="partial-marker" title="Only Triple-A data available">*</span>
    : null;
  const hasData = data.game_log && data.game_log.length > 0;

  return (
    <div className="pp-outer-centered">
      <div className="pp-back-row">
        <a className="back-btn" href={window.location.pathname} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onBack(); } }} style={{ textDecoration: "none" }}>← Back</a>
        <ErrorPill
          errors={data?.errors}
          context={{
            view: "player_page",
            level,
            pitcher_id: pitcherId,
            name: data?.info?.name,
          }}
        />
      </div>
      <div className="card">
        {/* ===== Header ===== */}
        <div className="card-top">
          <div className="card-info">
            {(() => {
              // MLB | Minors pill toggle — only when pitcher has games at both
              // levels. When both pills render, they share the top row with
                // the player name and are right-aligned via flexbox so their
              // top edge lines up with the "Regular Season" table header.
              const hasMlb = !!(data?.season_totals_mlb && data.season_totals_mlb.games);
              const hasMilb = !!(data?.season_totals_milb && data.season_totals_milb.games);
              const showPills = hasMlb && hasMilb && !!onChangeLevel;
              const nameNode = (
                <div className="card-name">{(() => {
                  if (level !== "aaa" || !info.teams || info.teams.length === 0) return info.name;
                  const parents = info.teams.map(t => parentOrg(t)).filter(Boolean);
                  if (parents.length === 0) return info.name;
                  const org = parents[parents.length - 1];
                  return `${info.name} (${org})`;
                })()}</div>
              );
              if (!showPills) return nameNode;
              return (
                <div className="player-name-row" style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
                  {nameNode}
                  <div className="player-level-pills">
                    <button
                      type="button"
                      className={`level-tab${level === "mlb" ? " active" : ""}`}
                      onClick={() => onChangeLevel("mlb")}
                    >MLB</button>
                    <button
                      type="button"
                      className={`level-tab${level === "aaa" ? " active" : ""}`}
                      onClick={() => onChangeLevel("aaa")}
                    >Minors</button>
                  </div>
                </div>
              );
            })()}
            <div className="card-meta">
              {info.teams?.map(t => displayAbbrev(t)).join("/") || ""} · {info.hand === "R" ? "RHP" : "LHP"}
            </div>
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
          {hasData && (
            <div className="card-gameline-box">
              <div className="card-gameline-header">
                <span>{level === "aaa"
                  ? `Across ${sortedLog.length} Triple-A Game${sortedLog.length === 1 ? "" : "s"}`
                  : "Regular Season"}</span>
                {liveGame && <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400, marginLeft: "auto" }}>* = Decision if the game ended now</span>}
              </div>
              <table className="card-gameline-table">
                <thead>
                  <tr>
                    <th>Date</th><th>Opp</th><th>Dec</th><th>IP</th><th>R</th><th>ER</th><th>Hits</th><th>BB</th>
                    <th className="gameline-divider-right">K</th>
                    <th>Whiffs</th><th>SwStr%</th><th>CSW%</th><th>2Str%</th><th>PAR%</th><th>#</th><th>HR</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLog.map((row, i) => {
                    const isLive = liveGame && liveGame.game_pk === row.game_pk;
                    // For a live row with no logged decision yet, project from
                    // the current score and tag with "*". A real decision
                    // already set on the boxscore (rare mid-game) wins.
                    const baseDec = row.decision || (isLive ? liveGame.projectedDecision : "ND");
                    const dec = isLive && !row.decision ? `${baseDec}*` : baseDec;
                    const decColor = baseDec === "W" ? "#6DE95D" : baseDec === "L" ? "#FF839B" : "#8a8eb0";
                    const dateParts = row.date ? row.date.replace(/^\d{4}-/, "").split("-") : [];
                    const dateShort = dateParts.length === 2 ? `${parseInt(dateParts[0], 10)}-${dateParts[1]}` : row.date;
                    return (
                      <tr key={row.game_pk + "-" + i}
                        className="pp-log-row"
                        onClick={(e) => onGameClick(row.date, pitcherId, row.game_pk, e)}
                        onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onGameClick(row.date, pitcherId, row.game_pk, e); } }}
                      >
                        <td><a href={`#card/${row.date}/${pitcherId}/${row.game_pk}`} rel="nofollow" onClick={(e) => e.preventDefault()} onMouseDown={(e) => { if (e.button === 1) e.stopPropagation(); }} style={{ color: "inherit", textDecoration: "none" }}>{dateShort}</a></td>
                        <td>{row.team && row.home_team && row.team !== row.home_team ? "@ " : ""}{displayAbbrev(row.opponent)}</td>
                        <td style={{ color: decColor, fontWeight: baseDec !== "ND" ? 700 : 500 }}>{dec}</td>
                        <td>{row.ip}</td>
                        <td>{row.runs != null ? row.runs : "—"}</td>
                        <td>{row.er}</td>
                        <td>{row.hits}</td>
                        <td>{row.bbs}</td>
                        <td className="gameline-divider-right">{row.ks}</td>
                        <td>{row.whiffs}</td>
                        <td>{row.swstr_pct != null ? Math.round(row.swstr_pct) + "%" : "—"}</td>
                        <td>{row.csw_pct != null ? row.csw_pct.toFixed(1) : "—"}</td>
                        <td>{row.two_str_pct != null ? Math.round(row.two_str_pct) + "%" : "—"}</td>
                        <td>{row.par_pct != null ? Math.round(row.par_pct) + "%" : "—"}</td>
                        <td>{row.pitches}</td>
                        <td>{row.hrs}</td>
                      </tr>
                    );
                  })}
                  {/* Total row — matches Box Score format with rate labels */}
                  {(() => {
                    const g = rs.games || 0;
                    const gs = rs.games_started || 0;
                    const ipThirds = rs.ip_thirds || 0;
                    const ip = ipThirds / 3;
                    const bf = rs.batters_faced || 0;
                    const wins = rs.wins || 0;
                    const losses = rs.losses || 0;
                    const ipg = ip > 0 && g > 0 ? (ip / g).toFixed(1) : "—";
                    const era = ip > 0 ? ((rs.er / ip) * 9).toFixed(2) : "—";
                    const whip = ip > 0 ? (((rs.hits || 0) + (rs.bbs || 0)) / ip).toFixed(2) : "—";
                    const h9 = ip > 0 ? (((rs.hits || 0) / ip) * 9).toFixed(1) : "—";
                    const bbPct = bf > 0 ? ((rs.bbs || 0) / bf * 100).toFixed(1) + "%" : "—";
                    const kPct = bf > 0 ? ((rs.ks || 0) / bf * 100).toFixed(1) + "%" : "—";
                    const whfg = g > 0 ? ((rs.whiffs || 0) / g).toFixed(1) : "—";
                    const ppg = g > 0 ? Math.round((rs.pitches || 0) / g) : "—";
                    const hr9 = ip > 0 ? (((rs.hrs || 0) / ip) * 9).toFixed(2) : "—";
                    const gamesLabel = gs > 0 && gs !== g ? `${g} Games (${gs} GS)` : `${g} Games`;
                    return (
                      <tr className="pp-total-row">
                        <td colSpan={2} className="pp-total-label"><span className="rate-label">Season Total</span>{gamesLabel}</td>
                        <td><span className="rate-label">W-L</span>{wins}-{losses}</td>
                        <td><span className="rate-label">IP/G</span>{ipg}</td>
                        <td><span className="rate-label">ERA</span>{era}</td>
                        <td><span className="rate-label">WHIP</span>{whip}</td>
                        <td><span className="rate-label">H/9</span>{h9}</td>
                        <td><span className="rate-label">BB%</span>{bbPct}</td>
                        <td className="gameline-divider-right"><span className="rate-label">K%</span>{kPct}</td>
                        <td><span className="rate-label">Whf/G</span>{whfg}</td>
                        <td><span className="rate-label">SwStr%</span>{rs.swstr_pct != null ? Math.round(rs.swstr_pct) + "%" : "—"}</td>
                        <td><span className="rate-label">CSW%</span>{rs.csw_pct != null ? rs.csw_pct.toFixed(1) + "%" : "—"}{ast("csw_pct")}</td>
                        <td><span className="rate-label">2Str%</span>{rs.two_str_pct != null ? Math.round(rs.two_str_pct) + "%" : "—"}{ast("two_str_pct")}</td>
                        <td><span className="rate-label">PAR%</span>{rs.par_pct != null ? Math.round(rs.par_pct) + "%" : "—"}{ast("par_pct")}</td>
                        <td><span className="rate-label">PPG</span>{ppg}</td>
                        <td><span className="rate-label">HR/9</span>{hr9}</td>
                      </tr>
                    );
                  })()}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {hasData && (
          <>
            {/* ===== PITCH TYPE METRICS ===== */}
            <div className="card-section">
              <div className="metrics-header">
                {isMobile ? (
                  <select className="metrics-subnav-mobile" value={metricsView} onChange={e => setMetricsView(e.target.value)}>
                    <option value="pitch-data">Pitch Overview</option>
                    <option value="results">Results</option>
                    <option value="usage">Usage</option>
                    <option value="velocity-trend">Velocity Trend</option>
                    <option value="play-by-play" disabled={pbpDisabled}>Play-by-Play</option>
                  </select>
                ) : (
                  <div className="metrics-subnav">
                    <button className={`metrics-subnav-btn${metricsView === "pitch-data" ? " active" : ""}`} onClick={() => setMetricsView("pitch-data")}>Pitch Overview</button>
                    <button className={`metrics-subnav-btn${metricsView === "results" ? " active" : ""}`} onClick={() => setMetricsView("results")}>Results</button>
                    <button className={`metrics-subnav-btn${metricsView === "usage" ? " active" : ""}`} onClick={() => setMetricsView("usage")}>Usage</button>
                    <button className={`metrics-subnav-btn${metricsView === "velocity-trend" ? " active" : ""}`} onClick={() => setMetricsView("velocity-trend")}>Velocity Trend</button>
                    {!pbpDisabled && pbpGamePk && pbpGameDate ? (
                      <a
                        className="metrics-subnav-btn"
                        href={`#card/${pbpGameDate}/${pitcherId}/${pbpGamePk}`}
                        rel="nofollow"
                        onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); handlePbpClick(); } }}
                        style={{ textDecoration: "none" }}
                      >
                        Play-by-Play
                      </a>
                    ) : (
                      <button
                        className="metrics-subnav-btn metrics-subnav-disabled"
                        disabled
                      >
                        Play-by-Play
                      </button>
                    )}
                  </div>
                )}
                <div className="metrics-controls">
                  <div className="filter-pill-group">
                    <span className="filter-pill-label">Game</span>
                    <select className="game-filter-select" value={gameFilter} onChange={e => {
                      setGameFilter(e.target.value);
                      setPitchTypeFilter(null);
                    }}>
                      <option value="all">All Games</option>
                      {gameOptions.map(g => (
                        <option key={g.game_pk} value={g.game_pk}>{g.label}</option>
                      ))}
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
                  <PitchDataTable
                    data={activePitchData}
                    columns={CARD_PITCH_DATA_COLUMNS}
                    splitByTeam={false}
                    spOnly={false}
                    pitcherHand={info.hand}
                    sortable={false}
                    showChange={true}
                    seasonAvgs={seasonAvgs}
                    batterFilter={batterFilter}
                    isMobile={isMobile}
                  />
                  {loadingAvgs && <div className="loading-avgs"><div className="loading-bars loading-bars-sm"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div></div>}
                </div>
              )}
              {metricsView === "results" && (
                <div className="metrics-card">
                  <ResultsTable pitches={data?.pitches} batterFilter={batterFilter} gameFilter={gameFilter} isMobile={isMobile} />
                </div>
              )}
              {metricsView === "usage" && (
                <div className="metrics-card">
                  <UsageTable pitches={data?.pitches} batterFilter={batterFilter} gameFilter={gameFilter} isMobile={isMobile} />
                </div>
              )}
              {metricsView === "velocity-trend" && (
                <div className="metrics-card">
                  <VelocityTrend pitches={filteredPitches} isMobile={isMobile} />
                </div>
              )}
            </div>

            {/* ===== VISUALS: Strike zones + Movement ===== */}
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
                  <span className="filter-pill-label">Game</span>
                  <select className="game-filter-select" value={gameFilter} onChange={e => {
                    setGameFilter(e.target.value);
                    setPitchTypeFilter(null);
                  }}>
                    <option value="all">All Games</option>
                    {gameOptions.map(g => (
                      <option key={g.game_pk} value={g.game_pk}>{g.label}</option>
                    ))}
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
                  <select className="sz-mode-select" value={contactFilter} onChange={e => setContactFilter(e.target.value)}>
                    <option value="all">All Pitches</option>
                    <option value="weak">Weak BIP</option>
                    <option value="hard">Hard BIP</option>
                  </select>
                </div>
              </div>
              <div className="card-visuals">
                <div className="card-sz-pair">
                  {(batterFilter === "all" || batterFilter === "L") && (
                    <div className="viz-card">
                      <div className="viz-card-label">vs LHB</div>
                      <StrikeZonePlot pitches={filteredPitches} szTop={data.sz_top} szBot={data.sz_bot} stand="L" colorMode={szColorMode} isMobile={isMobile} highlightPitch={crossHoverPitch} onPitchHover={setCrossHoverPitch} />
                    </div>
                  )}
                  {(batterFilter === "all" || batterFilter === "R") && (
                    <div className="viz-card">
                      <div className="viz-card-label">vs RHB</div>
                      <StrikeZonePlot pitches={filteredPitches} szTop={data.sz_top} szBot={data.sz_bot} stand="R" colorMode={szColorMode} isMobile={isMobile} highlightPitch={crossHoverPitch} onPitchHover={setCrossHoverPitch} />
                    </div>
                  )}
                </div>
                <div className="viz-card">
                  <div className="viz-card-label">Pitch Movement</div>
                  <MovementPlot pitches={filteredPitches} hand={info.hand} isMobile={isMobile} highlightPitch={crossHoverPitch} onPitchHover={setCrossHoverPitch} />
                </div>
              </div>
            </div>
          </>
        )}

        {!hasData && <div className="pp-empty">No Game Results</div>}
      </div>
    </div>
  );
}

function formatCompactDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length < 3) return dateStr;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  return `${m}-${parts[2]}`;
}
