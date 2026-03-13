import React, { useState, useEffect, useMemo } from "react";
import { PITCH_COLORS, CARD_PITCH_DATA_COLUMNS, displayAbbrev } from "../constants";
import { fetchSeasonAverages } from "../utils/api";
import PitchDataTable from "./PitchDataTable";
import StrikeZonePlot from "./StrikeZonePlot";
import MovementPlot from "./MovementPlot";
import PitchFilterDropdown from "./PitchFilterDropdown";
import ResultsTable from "./ResultsTable";
import { classifyPitchResult, isWeakBIP, RESULT_FILTER_OPTIONS, RESULT_QUICK_ACTIONS } from "../utils/pitchFilters";

const API = window.__BACKEND_PORT__
  ? `http://localhost:${window.__BACKEND_PORT__}`
  : process.env.NODE_ENV === "development" ? "http://localhost:8000" : "";

export default function PlayerPage({ pitcherId, onBack, onGameClick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadMsg, setLoadMsg] = useState("Loading player data...");
  const [seasonAvgs, setSeasonAvgs] = useState(null);
  const [loadingAvgs, setLoadingAvgs] = useState(false);
  const [batterFilter, setBatterFilter] = useState("all");
  const [szColorMode, setSzColorMode] = useState("pitch-type");
  const [metricsView, setMetricsView] = useState("pitch-data"); // "pitch-data" | "results"

  // Pitch-type and result filters for plots
  const [pitchTypeFilter, setPitchTypeFilter] = useState(null);
  const [resultFilter, setResultFilter] = useState(null);

  // Game filter for plots AND pitch metrics
  const [gameFilter, setGameFilter] = useState("all");

  const prevSeason = 2025;

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
      start_date: "2026-02-20",
    });
    fetch(`${API}/api/player-page?${params}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; clearTimeout(pollTimer); };
  }, [pitcherId]);

  // Always fetch season averages for change display
  useEffect(() => {
    if (!seasonAvgs && pitcherId) {
      setLoadingAvgs(true);
      fetchSeasonAverages(pitcherId, prevSeason)
        .then(avgs => { setSeasonAvgs(avgs); setLoadingAvgs(false); })
        .catch(() => { setSeasonAvgs({}); setLoadingAvgs(false); });
    }
  }, [seasonAvgs, pitcherId, prevSeason]);

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

  // Sorted game log (by date ascending for numbering, descending for display)
  const sortedLog = useMemo(() => {
    if (!data?.game_log) return [];
    return [...data.game_log].sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  // Game options for dropdown: numbered by date order
  const gameOptions = useMemo(() => {
    return sortedLog.map((g, i) => ({
      idx: i + 1,
      date: g.date,
      game_pk: g.game_pk,
      opponent: g.opponent,
      label: `${i + 1}. ${formatShortDate(g.date)} vs ${displayAbbrev(g.opponent)}`,
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
        // "Weak BIP" is a virtual category — check separately
        if (effectiveResultFilter.has("Weak BIP") && isWeakBIP(p)) return true;
        return effectiveResultFilter.has(cat) || cat === "Other";
      });
    }
    return fp;
  }, [data, gameFilter, batterFilter, pitchTypeFilter, effectivePitchTypeFilter, resultFilter, effectiveResultFilter]);

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
        <button className="back-btn" onClick={onBack}>← Back</button>
        <div className="loading-msg">{loadMsg}</div>
      </div>
    );
  }

  if (!data?.info?.name) {
    return (
      <div className="pp-outer-centered">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <div className="loading-msg">Player not found</div>
      </div>
    );
  }

  const info = data.info;
  const rs = data.results_summary || {};
  const hasData = data.game_log && data.game_log.length > 0;

  return (
    <div className="pp-outer-centered">
      <button className="back-btn" onClick={onBack}>← Back</button>
      <div className="card">
        {/* ===== Header ===== */}
        <div className="card-top">
          <div className="card-info">
            <div className="card-name">{info.name}</div>
            <div className="card-meta">
              {info.teams?.map(t => displayAbbrev(t)).join("/") || ""} · {info.hand === "R" ? "RHP" : "LHP"}
            </div>
          </div>
          {hasData && (
            <div className="card-gameline-box">
              <div className="card-gameline-header">Spring Training Results</div>
              <table className="card-gameline-table">
                <thead>
                  <tr>
                    <th>Date</th><th>Opp</th><th>IP</th><th>ER</th><th>Hits</th><th>BB</th>
                    <th className="gameline-divider-right">K</th>
                    <th>Whiffs</th><th>CSW%</th><th>#</th><th>HR</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLog.map((row, i) => (
                    <tr key={row.game_pk + "-" + i}
                      className="pp-log-row"
                      onClick={(e) => onGameClick(row.date, pitcherId, row.game_pk, e)}
                    >
                      <td>{row.date}</td>
                      <td>{displayAbbrev(row.opponent)}</td>
                      <td>{row.ip}</td>
                      <td>{row.er}</td>
                      <td>{row.hits}</td>
                      <td>{row.bbs}</td>
                      <td className="gameline-divider-right">{row.ks}</td>
                      <td>{row.whiffs}</td>
                      <td>{row.csw_pct != null ? row.csw_pct.toFixed(1) : "—"}</td>
                      <td>{row.pitches}</td>
                      <td>{row.hrs}</td>
                    </tr>
                  ))}
                  {/* Total row */}
                  <tr className="pp-total-row">
                    <td className="pp-total-label">Total</td>
                    <td>{rs.games ? `${rs.games} G` : "—"}</td>
                    <td>{rs.ip ?? "—"}</td>
                    <td>{rs.er ?? "—"}</td>
                    <td>{rs.hits ?? "—"}</td>
                    <td>{rs.bbs ?? "—"}</td>
                    <td className="gameline-divider-right">{rs.ks ?? "—"}</td>
                    <td>{rs.whiffs ?? "—"}</td>
                    <td>{rs.csw_pct != null ? rs.csw_pct.toFixed(1) + "%" : "—"}</td>
                    <td>{rs.pitches ?? "—"}</td>
                    <td>{rs.hrs ?? "—"}</td>
                  </tr>
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
                <div className="metrics-subnav">
                  <button className={`metrics-subnav-btn${metricsView === "pitch-data" ? " active" : ""}`} onClick={() => setMetricsView("pitch-data")}>Pitch Type Metrics</button>
                  <button className={`metrics-subnav-btn${metricsView === "results" ? " active" : ""}`} onClick={() => setMetricsView("results")}>Results</button>
                  <button
                    className={`metrics-subnav-btn${pbpDisabled ? " metrics-subnav-disabled" : ""}`}
                    onClick={handlePbpClick}
                    disabled={pbpDisabled}
                  >
                    Play-by-Play
                  </button>
                </div>
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
                  />
                  {loadingAvgs && <div className="loading-avgs">Loading season averages...</div>}
                </div>
              )}
              {metricsView === "results" && (
                <div className="metrics-card">
                  <ResultsTable pitches={data?.pitches} batterFilter={batterFilter} gameFilter={gameFilter} />
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
                  <span className="filter-pill-label">Pitch Filter</span>
                  <PitchFilterDropdown
                    label="Pitch Types"
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
              </div>
              <div className="card-visuals">
                <div className="card-sz-pair">
                  {(batterFilter === "all" || batterFilter === "L") && (
                    <div className="viz-card">
                      <div className="viz-card-label">vs LHB</div>
                      <StrikeZonePlot pitches={filteredPitches} szTop={data.sz_top} szBot={data.sz_bot} stand="L" colorMode={szColorMode} />
                    </div>
                  )}
                  {(batterFilter === "all" || batterFilter === "R") && (
                    <div className="viz-card">
                      <div className="viz-card-label">vs RHB</div>
                      <StrikeZonePlot pitches={filteredPitches} szTop={data.sz_top} szBot={data.sz_bot} stand="R" colorMode={szColorMode} />
                    </div>
                  )}
                </div>
                <div className="viz-card">
                  <div className="viz-card-label">Pitch Movement</div>
                  <MovementPlot pitches={filteredPitches} hand={info.hand} />
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

function formatShortDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length < 3) return dateStr;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  const y = parts[0].slice(2);
  return `${m}/${d}/${y}`;
}
