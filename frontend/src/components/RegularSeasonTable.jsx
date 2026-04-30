import React, { useEffect, useMemo, useState } from "react";
import { isAAATeam } from "../constants";
import { fetchGameLinescore } from "../utils/api";

function ipToThirds(ipVal) {
  const parts = String(ipVal || "0.0").split(".");
  const full = parseInt(parts[0], 10) || 0;
  const thirds = parseInt(parts[1], 10) || 0;
  return full * 3 + thirds;
}

function aggregateGameLogTotals(log) {
  if (!log || log.length === 0) return null;
  const totalPitches = log.reduce((sum, g) => sum + (g.pitches || 0), 0);
  const ipThirds = log.reduce((sum, g) => sum + ipToThirds(g.ip), 0);
  const totalPa = log.reduce((sum, g) => sum + (g.pa_count || 0), 0);
  const twoStrikePas = log.reduce((sum, g) => sum + (g.two_strike_pas || 0), 0);
  const twoStrikePitches = log.reduce((sum, g) => sum + (g.two_strike_pitches || 0), 0);
  const strikeoutsForPar = log.reduce((sum, g) => sum + (g.strikeouts_for_par || 0), 0);
  const whiffs = log.reduce((sum, g) => sum + (g.whiffs || 0), 0);
  const strikes = log.reduce((sum, g) => sum + (g.strikes || 0), 0);
  return {
    games: log.length,
    games_started: log.reduce((sum, g) => sum + (g.games_started || 0), 0),
    ip_thirds: ipThirds,
    hits: log.reduce((sum, g) => sum + (g.hits || 0), 0),
    bbs: log.reduce((sum, g) => sum + (g.bbs || 0), 0),
    ks: log.reduce((sum, g) => sum + (g.ks || 0), 0),
    hrs: log.reduce((sum, g) => sum + (g.hrs || 0), 0),
    er: log.reduce((sum, g) => sum + (g.er || 0), 0),
    runs: log.reduce((sum, g) => sum + (g.runs || 0), 0),
    batters_faced: log.reduce((sum, g) => sum + (g.batters_faced || 0), 0),
    whiffs,
    swstr_pct: totalPitches > 0 ? (whiffs / totalPitches) * 100 : 0,
    csw_pct: totalPitches > 0
      ? log.reduce((sum, g) => sum + ((g.csw_pct || 0) * (g.pitches || 0)), 0) / totalPitches
      : 0,
    strike_pct: totalPitches > 0 ? (strikes / totalPitches) * 100 : 0,
    two_str_pct: totalPa > 0 ? (twoStrikePas / totalPa) * 100 : 0,
    par_pct: twoStrikePitches > 0 ? (strikeoutsForPar / twoStrikePitches) * 100 : 0,
    pitches: totalPitches,
    wins: log.filter(g => g.decision === "W").length,
    losses: log.filter(g => g.decision === "L").length,
  };
}

// Poll the latest game's linescore so the table can flag an in-progress
// outing with a projected W/L/ND decision (rendered with a trailing "*").
function useLiveLatestGame(sortedLog) {
  const [liveGame, setLiveGame] = useState(null);
  useEffect(() => {
    if (!sortedLog || sortedLog.length === 0) { setLiveGame(null); return; }
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
      setLiveGame(prev => { if (prev) doFetch(); return prev; });
    }, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sortedLog]);
  return liveGame;
}

export default function RegularSeasonTable({
  data,
  level = "mlb",
  pitcherId,
  displayAbbrev,
  buildCardHref,
  onGameClick,
}) {
  const sortedLog = useMemo(() => {
    if (!data?.game_log) return [];
    let log = [...data.game_log].sort((a, b) => a.date.localeCompare(b.date));
    if (level === "aaa") log = log.filter(g => isAAATeam(g.team));
    return log;
  }, [data, level]);

  const liveGame = useLiveLatestGame(sortedLog);

  if (!sortedLog || sortedLog.length === 0) return null;

  const cachedTotals = (
    (level === "aaa" && data.season_totals_milb) ||
    (level === "mlb" && data.season_totals_mlb) ||
    data.results_summary || {}
  );
  const rs = aggregateGameLogTotals(sortedLog) || cachedTotals;
  const partialFields = new Set(rs.partial_fields || []);
  const ast = (col) => partialFields.has(col)
    ? <span className="partial-marker" title="Only Triple-A data available">*</span>
    : null;

  const headerLabel = level === "aaa"
    ? `Across ${sortedLog.length} Triple-A Game${sortedLog.length === 1 ? "" : "s"}`
    : "Regular Season";

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
    <div className="card-gameline-box">
      <div className="card-gameline-header">
        <span>{headerLabel}</span>
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
            const baseDec = row.decision || (isLive ? liveGame.projectedDecision : "ND");
            const dec = isLive && !row.decision ? `${baseDec}*` : baseDec;
            const decColor = baseDec === "W" ? "#6DE95D" : baseDec === "L" ? "#FF839B" : "#8a8eb0";
            const dateParts = row.date ? row.date.replace(/^\d{4}-/, "").split("-") : [];
            const dateShort = dateParts.length === 2 ? `${parseInt(dateParts[0], 10)}-${dateParts[1]}` : row.date;
            return (
              <tr key={row.game_pk + "-" + i}
                className="pp-log-row"
                onClick={(e) => onGameClick && onGameClick(row.date, pitcherId, row.game_pk, e)}
                onMouseDown={(e) => { if (e.button === 1 && onGameClick) { e.preventDefault(); onGameClick(row.date, pitcherId, row.game_pk, e); } }}
              >
                <td><a href={buildCardHref ? buildCardHref(row.date, row.game_pk) : "#"} rel="nofollow" onClick={(e) => e.preventDefault()} onMouseDown={(e) => { if (e.button === 1) e.stopPropagation(); }} style={{ color: "inherit", textDecoration: "none" }}>{dateShort}</a></td>
                <td>{row.team && row.home_team && row.team !== row.home_team ? "@ " : ""}{displayAbbrev ? displayAbbrev(row.opponent) : row.opponent}</td>
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
        </tbody>
      </table>
    </div>
  );
}
