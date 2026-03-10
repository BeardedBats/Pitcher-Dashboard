import React, { useState, useEffect, useMemo } from "react";
import { TEAM_FULL_NAMES, PITCH_COLORS, displayAbbrev } from "../constants";

const API = window.__BACKEND_PORT__
  ? `http://localhost:${window.__BACKEND_PORT__}`
  : process.env.NODE_ENV === "development" ? "http://localhost:8000" : "";

export default function TeamPage({ teamAbbrev, onPlayerClick, onBack }) {
  const [view, setView] = useState("results");
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadMsg, setLoadMsg] = useState("");
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("desc");

  const teamName = TEAM_FULL_NAMES[teamAbbrev] || teamAbbrev;

  useEffect(() => {
    setLoading(true);
    setLoadMsg(`Loading ${teamName} pitchers...`);
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

    fetch(`${API}/api/team-pitchers?team=${encodeURIComponent(teamAbbrev)}&view=${view}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; clearTimeout(pollTimer); };
  }, [teamAbbrev, view]);

  const handleSort = (col) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  };

  const sorted = useMemo(() => {
    if (!sortCol) return data;
    return [...data].sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === "asc" ? va - vb : vb - va;
    });
  }, [data, sortCol, sortDir]);

  const resultsCols = [
    { key: "pitcher", label: "Pitcher" },
    { key: "hand", label: "Hand" },
    { key: "games", label: "G" },
    { key: "ip", label: "IP" },
    { key: "hits", label: "H" },
    { key: "bbs", label: "BB" },
    { key: "ks", label: "K" },
    { key: "er", label: "ER" },
    { key: "hrs", label: "HR" },
    { key: "csw_pct", label: "CSW%" },
    { key: "whiffs", label: "Whiffs" },
    { key: "pitches", label: "Pitches" },
  ];

  const pitchCols = [
    { key: "pitcher", label: "Pitcher" },
    { key: "hand", label: "Hand" },
    { key: "pitch_name", label: "Pitch" },
    { key: "count", label: "#" },
    { key: "velo", label: "Velo" },
    { key: "ext", label: "Ext" },
    { key: "ivb", label: "iVB" },
    { key: "ihb", label: "iHB" },
    { key: "usage", label: "Usage%" },
    { key: "strike_pct", label: "Strike%" },
    { key: "cs_pct", label: "CS%" },
    { key: "swstr_pct", label: "SwStr%" },
    { key: "csw_pct", label: "CSW%" },
  ];

  const cols = view === "results" ? resultsCols : pitchCols;

  const fmtCell = (row, col) => {
    const val = row[col.key];
    if (val == null) return "—";
    if (col.key === "pitcher") return val;
    if (col.key === "pitch_name") return val;
    if (col.key === "ihb") return typeof val === "number" ? (-val).toFixed(1) : val;
    if (typeof val === "number" && col.key.includes("pct")) return val.toFixed(1);
    if (typeof val === "number" && ["velo", "ext", "ivb"].includes(col.key)) return val.toFixed(1);
    return val;
  };

  return (
    <div className="team-page">
      <div className="page-header">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <h2 className="page-title">{teamName}</h2>
      </div>
      <div className="controls-row" style={{ marginBottom: 12 }}>
        <button className={`view-btn ${view === "results" ? "active" : ""}`} onClick={() => { setView("results"); setSortCol(null); }}>
          Pitcher Results
        </button>
        <button className={`view-btn ${view === "pitch-data" ? "active" : ""}`} onClick={() => { setView("pitch-data"); setSortCol(null); }}>
          Pitch Data
        </button>
      </div>
      {loading ? (
        <div className="loading-msg">{loadMsg}</div>
      ) : (
        <div className="table-card">
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c.key} onClick={() => handleSort(c.key)} style={{ cursor: "pointer", whiteSpace: "nowrap" }}>
                      {c.label}
                      {sortCol === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => (
                  <tr key={row.pitcher_id + "-" + (row.pitch_name || "") + "-" + i}>
                    {cols.map((c) => (
                      <td key={c.key}
                        className={c.key === "pitcher" ? "pitcher-name-cell" : ""}
                        onClick={c.key === "pitcher" ? () => onPlayerClick(row.pitcher_id, row.pitcher) : undefined}
                        style={c.key === "pitcher" ? { cursor: "pointer", color: "var(--name)" } : c.key === "pitch_name" ? { color: PITCH_COLORS[row.pitch_name] || "var(--text)" } : {}}
                      >
                        {fmtCell(row, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
