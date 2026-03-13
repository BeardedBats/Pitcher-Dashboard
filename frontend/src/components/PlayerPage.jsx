import React, { useState, useEffect, useMemo } from "react";
import { CARD_PITCH_DATA_COLUMNS, displayAbbrev } from "../constants";
import { fetchSeasonAverages } from "../utils/api";
import PitchDataTable from "./PitchDataTable";

const API = window.__BACKEND_PORT__
  ? `http://localhost:${window.__BACKEND_PORT__}`
  : process.env.NODE_ENV === "development" ? "http://localhost:8000" : "";

const PERIOD_RANGES = {
  spring: { start: "2026-02-20", end: "", label: "Spring Training" },
  season: { start: "2026-03-27", end: "", label: "2026 Season" },
};

export default function PlayerPage({ pitcherId, onBack, onGameClick }) {
  const [period, setPeriod] = useState("spring");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadMsg, setLoadMsg] = useState("Loading player data...");
  const [logSortCol, setLogSortCol] = useState("date");
  const [logSortDir, setLogSortDir] = useState("desc");
  const [showChange, setShowChange] = useState(true);
  const [seasonAvgs, setSeasonAvgs] = useState(null);
  const [loadingAvgs, setLoadingAvgs] = useState(false);
  const [playerInfo, setPlayerInfo] = useState(null);
  const [batterFilter, setBatterFilter] = useState("all");

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

    const range = PERIOD_RANGES[period];
    const params = new URLSearchParams({
      pitcher_id: pitcherId,
      start_date: range.start,
    });
    if (range.end) params.set("end_date", range.end);
    fetch(`${API}/api/player-page?${params}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setData(d); if (d?.info?.name) setPlayerInfo(d.info); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; clearTimeout(pollTimer); };
  }, [pitcherId, period]);

  useEffect(() => {
    if (showChange && !seasonAvgs && pitcherId) {
      setLoadingAvgs(true);
      fetchSeasonAverages(pitcherId, prevSeason)
        .then(avgs => { setSeasonAvgs(avgs); setLoadingAvgs(false); })
        .catch(() => { setSeasonAvgs({}); setLoadingAvgs(false); });
    }
  }, [showChange, seasonAvgs, pitcherId, prevSeason]);

  const handleLogSort = (col) => {
    if (logSortCol === col) {
      setLogSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setLogSortCol(col);
      setLogSortDir("desc");
    }
  };

  const sortedLog = useMemo(() => {
    if (!data?.game_log) return [];
    const log = [...data.game_log];
    return log.sort((a, b) => {
      let va = a[logSortCol], vb = b[logSortCol];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return logSortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return logSortDir === "asc" ? va - vb : vb - va;
    });
  }, [data, logSortCol, logSortDir]);

  // Select correct pitch table based on batter filter
  const activePitchData = useMemo(() => {
    if (!data) return [];
    let table;
    if (batterFilter === "L" && data.pitch_summary_vs_l) table = data.pitch_summary_vs_l;
    else if (batterFilter === "R" && data.pitch_summary_vs_r) table = data.pitch_summary_vs_r;
    else table = data.pitch_summary;
    if (table) return [...table].sort((a, b) => (b.count || 0) - (a.count || 0));
    return [];
  }, [data, batterFilter]);

  if (loading) {
    return (
      <div className="pp-outer">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <div className="loading-msg">{loadMsg}</div>
      </div>
    );
  }

  if (!data?.info?.name && !playerInfo) {
    return (
      <div className="pp-outer">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <div className="loading-msg">Player not found</div>
      </div>
    );
  }

  const info = data?.info?.name ? data.info : playerInfo;
  const rs = data?.results_summary || {};
  const hasData = data?.game_log && data.game_log.length > 0;

  const logCols = [
    { key: "date", label: "Date" },
    { key: "opponent", label: "Opp" },
    { key: "ip", label: "IP" },
    { key: "hits", label: "H" },
    { key: "bbs", label: "BB" },
    { key: "ks", label: "K" },
    { key: "er", label: "ER" },
    { key: "hrs", label: "HR" },
    { key: "csw_pct", label: "CSW%" },
    { key: "pitches", label: "Pitches" },
  ];

  const periodTitle = period === "spring" ? "Spring Training Totals" : "2026 Totals";

  return (
    <div className="pp-outer">
      <button className="back-btn" onClick={onBack}>← Back</button>
      <div className="pp-card">
        {/* Header */}
        <div className="pp-header">
          <div className="pp-name">{info.name}</div>
          <div className="pp-meta">
            {info.teams?.map(t => displayAbbrev(t)).join("/") || ""} · {info.hand === "R" ? "RHP" : "LHP"}
          </div>
        </div>

        {/* Period Sub-Nav */}
        <div className="pp-subnav-row">
          <div className="metrics-subnav">
            {Object.entries(PERIOD_RANGES).map(([key, val]) => (
              <button key={key} className={`metrics-subnav-btn${period === key ? " active" : ""}`} onClick={() => setPeriod(key)}>
                {val.label}
              </button>
            ))}
          </div>
        </div>

        {!hasData ? (
          <div className="pp-empty">No Game Results</div>
        ) : (
          <>
            {/* Box Score Table */}
            <div className="pp-box-section">
              <div className="pp-box-header">{periodTitle}</div>
              <div className="pp-box-wrap">
                <table className="card-gameline-table">
                  <thead>
                    <tr>
                      <th>G</th><th>IP</th><th>H</th><th>BB</th>
                      <th className="gameline-divider-right">K</th>
                      <th>ER</th><th>HR</th><th>CSW%</th><th>Pitches</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{rs.games ?? "—"}</td>
                      <td>{rs.ip ?? "—"}</td>
                      <td>{rs.hits ?? "—"}</td>
                      <td>{rs.bbs ?? "—"}</td>
                      <td className="gameline-divider-right">{rs.ks ?? "—"}</td>
                      <td>{rs.er ?? "—"}</td>
                      <td>{rs.hrs ?? "—"}</td>
                      <td>{rs.csw_pct != null ? rs.csw_pct.toFixed(1) + "%" : "—"}</td>
                      <td>{rs.pitches ?? "—"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Game Log */}
            <div className="pp-box-section">
              <div className="pp-box-header">Game Log</div>
              <div className="pp-table-wrap">
                <table className="pp-table">
                  <thead>
                    <tr>
                      {logCols.map((c) => (
                        <th key={c.key} onClick={() => handleLogSort(c.key)} style={{ cursor: "pointer" }}>
                          {c.label}
                          {logSortCol === c.key ? (logSortDir === "asc" ? " ▲" : " ▼") : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedLog.map((row, i) => (
                      <tr key={row.game_pk + "-" + i}
                        className="pp-log-row"
                        onClick={(e) => onGameClick(row.date, pitcherId, row.game_pk, e)}
                      >
                        {logCols.map((c) => {
                          let val = row[c.key];
                          if (val == null) val = "—";
                          else if (c.key === "opponent") val = displayAbbrev(val);
                          else if (c.key === "csw_pct" && typeof val === "number") val = val.toFixed(1);
                          return <td key={c.key}>{val}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pitch Type Metrics */}
            <div className="pp-box-section">
              <div className="pp-metrics-title-row">
                <div className="pp-box-header">Pitch Type Metrics</div>
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
              </div>
              <div className="metrics-card">
                <PitchDataTable
                  data={activePitchData}
                  columns={CARD_PITCH_DATA_COLUMNS}
                  splitByTeam={false}
                  spOnly={false}
                  pitcherHand={info.hand}
                  sortable={false}
                  showChange={showChange}
                  seasonAvgs={seasonAvgs}
                  batterFilter={batterFilter}
                />
                {loadingAvgs && <div className="loading-avgs">Loading season averages...</div>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
