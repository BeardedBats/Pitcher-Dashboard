import React, { useMemo } from "react";
import { PITCH_COLORS, CARD_RESULTS_COLUMNS } from "../constants";
import { classifyBIPQuality } from "../utils/pitchFilters";

/**
 * Results tab table: per-pitch-type aggregate results.
 * Computes Zone%, O-Swing%, Whiffs, CS, CSW%, Strike%, Fouls, BBs, Ks, BIP, Hits, Outs, HRs, Weak%, Hard%
 *
 * Props:
 *  - pitches: raw pitch-level data array
 *  - batterFilter: "all" | "L" | "R"
 *  - gameFilter: "all" | game_pk string
 */
export default function ResultsTable({ pitches, batterFilter, gameFilter }) {
  const resultData = useMemo(() => {
    if (!pitches || pitches.length === 0) return [];

    let fp = pitches;
    if (gameFilter && gameFilter !== "all") {
      fp = fp.filter(p => String(p.game_pk) === String(gameFilter));
    }
    if (batterFilter === "L") fp = fp.filter(p => p.stand === "L");
    else if (batterFilter === "R") fp = fp.filter(p => p.stand === "R");

    // Group by pitch_name
    const groups = {};
    for (const p of fp) {
      const name = p.pitch_name;
      if (!name) continue;
      if (!groups[name]) groups[name] = [];
      groups[name].push(p);
    }

    const rows = [];
    for (const [pitchName, pitchArr] of Object.entries(groups)) {
      const total = pitchArr.length;
      let zone = 0, oSwing = 0, oTotal = 0;
      let whiffs = 0, cs = 0, fouls = 0, strikes = 0;
      let balls = 0, bbs = 0, ks = 0;
      let bip = 0, hits = 0, outs = 0, hrs = 0;
      let weakBIP = 0, hardBIP = 0;

      for (const p of pitchArr) {
        const desc = (p.description || "").toLowerCase();
        const ev = (p.events || "").toLowerCase();

        // Zone: plate_x between -0.83 and 0.83, plate_z between sz_bot and sz_top
        const inZone = p.plate_x != null && p.plate_z != null &&
          Math.abs(p.plate_x) <= 0.83 &&
          p.plate_z >= (p.sz_bot || 1.5) && p.plate_z <= (p.sz_top || 3.5);
        if (inZone) zone++;

        // O-Swing: swing outside zone
        const isOutside = p.plate_x != null && p.plate_z != null && !inZone;
        const isSwing = desc === "swinging_strike" || desc === "swinging_strike_blocked" ||
          desc === "foul_tip" || desc === "foul" || desc === "foul_bunt" ||
          desc === "hit_into_play" || desc === "missed_bunt";
        if (isOutside) {
          oTotal++;
          if (isSwing) oSwing++;
        }

        // Whiffs
        if (desc === "swinging_strike" || desc === "swinging_strike_blocked" || desc === "foul_tip") {
          whiffs++;
          strikes++;
        }
        // Called Strike
        else if (desc === "called_strike") {
          cs++;
          strikes++;
        }
        // Foul
        else if (desc.includes("foul") && desc !== "foul_tip") {
          fouls++;
          strikes++;
        }
        // Ball
        else if ((desc.includes("ball") && !desc.includes("in_play")) || desc === "pitchout") {
          balls++;
        }
        // Hit into play
        else if (desc === "hit_into_play") {
          strikes++;
        }

        // Count BBs and Ks from events
        if (ev === "walk" || ev === "intent_walk") bbs++;
        if (ev === "strikeout" || ev === "strikeout_double_play") ks++;

        // BIP stats (including HRs)
        if (ev && desc === "hit_into_play") {
          bip++;
          if (ev === "home_run") { hrs++; hits++; }
          else if (ev === "single" || ev === "double" || ev === "triple") hits++;
          else {
            // All other in-play events are outs
            outs++;
          }

          // Weak/Hard BIP classification
          const quality = classifyBIPQuality(p.launch_speed, p.launch_angle);
          if (quality === "Weak") weakBIP++;
          else if (quality === "Hard") hardBIP++;
        }
      }

      const csw = whiffs + cs;
      rows.push({
        pitch_name: pitchName,
        count: total,
        zone_pct: total > 0 ? Math.round((zone / total) * 100) : 0,
        o_swing_pct: oTotal > 0 ? Math.round((oSwing / oTotal) * 100) : 0,
        whiffs,
        cs,
        csw_pct: total > 0 ? Math.round((csw / total) * 100) : 0,
        strike_pct: total > 0 ? Math.round((strikes / total) * 100) : 0,
        fouls,
        bbs,
        ks,
        bip,
        hits,
        outs_bip: outs,
        hrs,
        weak_pct: bip > 0 ? Math.round((weakBIP / bip) * 100) : 0,
        hard_pct: bip > 0 ? Math.round((hardBIP / bip) * 100) : 0,
      });
    }

    // Sort by count descending
    rows.sort((a, b) => b.count - a.count);
    return rows;
  }, [pitches, batterFilter, gameFilter]);

  // Compute totals row
  const totals = useMemo(() => {
    if (resultData.length === 0) return null;
    let totalCount = 0, totalZone = 0, totalOSwing = 0, totalOTotal = 0;
    let totalWhiffs = 0, totalCS = 0, totalStrikes = 0, totalFouls = 0;
    let totalBBs = 0, totalKs = 0;
    let totalBIP = 0, totalHits = 0, totalOuts = 0, totalHRs = 0;
    let totalWeakBIP = 0, totalHardBIP = 0;

    // Re-aggregate from raw pitches (not from rounded per-pitch-type rows)
    let fp = pitches || [];
    if (gameFilter && gameFilter !== "all") {
      fp = fp.filter(p => String(p.game_pk) === String(gameFilter));
    }
    if (batterFilter === "L") fp = fp.filter(p => p.stand === "L");
    else if (batterFilter === "R") fp = fp.filter(p => p.stand === "R");

    for (const p of fp) {
      if (!p.pitch_name) continue;
      totalCount++;
      const desc = (p.description || "").toLowerCase();
      const ev = (p.events || "").toLowerCase();
      const inZone = p.plate_x != null && p.plate_z != null &&
        Math.abs(p.plate_x) <= 0.83 &&
        p.plate_z >= (p.sz_bot || 1.5) && p.plate_z <= (p.sz_top || 3.5);
      if (inZone) totalZone++;
      const isOutside = p.plate_x != null && p.plate_z != null && !inZone;
      const isSwing = desc === "swinging_strike" || desc === "swinging_strike_blocked" ||
        desc === "foul_tip" || desc === "foul" || desc === "foul_bunt" ||
        desc === "hit_into_play" || desc === "missed_bunt";
      if (isOutside) { totalOTotal++; if (isSwing) totalOSwing++; }
      if (desc === "swinging_strike" || desc === "swinging_strike_blocked" || desc === "foul_tip") { totalWhiffs++; totalStrikes++; }
      else if (desc === "called_strike") { totalCS++; totalStrikes++; }
      else if (desc.includes("foul") && desc !== "foul_tip") { totalFouls++; totalStrikes++; }
      else if (desc === "hit_into_play") { totalStrikes++; }
      if (ev === "walk" || ev === "intent_walk") totalBBs++;
      if (ev === "strikeout" || ev === "strikeout_double_play") totalKs++;
      if (ev && desc === "hit_into_play") {
        totalBIP++;
        if (ev === "home_run") { totalHRs++; totalHits++; }
        else if (ev === "single" || ev === "double" || ev === "triple") totalHits++;
        else totalOuts++;
        const quality = classifyBIPQuality(p.launch_speed, p.launch_angle);
        if (quality === "Weak") totalWeakBIP++;
        else if (quality === "Hard") totalHardBIP++;
      }
    }
    const csw = totalWhiffs + totalCS;
    return {
      pitch_name: "Total",
      count: totalCount,
      zone_pct: totalCount > 0 ? Math.round((totalZone / totalCount) * 100) : 0,
      o_swing_pct: totalOTotal > 0 ? Math.round((totalOSwing / totalOTotal) * 100) : 0,
      whiffs: totalWhiffs,
      cs: totalCS,
      csw_pct: totalCount > 0 ? Math.round((csw / totalCount) * 100) : 0,
      strike_pct: totalCount > 0 ? Math.round((totalStrikes / totalCount) * 100) : 0,
      fouls: totalFouls,
      bbs: totalBBs,
      ks: totalKs,
      bip: totalBIP,
      hits: totalHits,
      outs_bip: totalOuts,
      hrs: totalHRs,
      weak_pct: totalBIP > 0 ? Math.round((totalWeakBIP / totalBIP) * 100) : 0,
      hard_pct: totalBIP > 0 ? Math.round((totalHardBIP / totalBIP) * 100) : 0,
    };
  }, [pitches, batterFilter, gameFilter, resultData]);

  if (resultData.length === 0) return <div className="no-data">No result data available.</div>;

  const cols = CARD_RESULTS_COLUMNS;
  const pctKeys = new Set(["zone_pct", "o_swing_pct", "csw_pct", "strike_pct", "weak_pct", "hard_pct"]);

  const renderCell = (row, col, isTotal) => {
    const v = row[col.key];
    if (col.key === "pitch_name") {
      if (isTotal) return <span className="pp-total-label">{v}</span>;
      const c = PITCH_COLORS[v] || "#D9D9D9";
      return <span style={{ color: c, fontWeight: 600 }}>{v}</span>;
    }
    if (v == null || v === "") return <span style={{ color: "rgb(180, 185, 219)" }}>—</span>;
    if (pctKeys.has(col.key)) return `${v}%`;
    return v;
  };

  return (
    <table style={{ width: "100%", fontVariantNumeric: "tabular-nums" }}>
      <thead>
        <tr>
          {cols.map(c => (
            <th key={c.key}
                className={c.dividerRight ? "col-divider-right" : ""}
                style={{ textAlign: c.align || "right" }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {resultData.map((r, i) => (
          <tr key={i}>
            {cols.map(c => (
              <td key={c.key}
                  className={c.dividerRight ? "col-divider-right" : ""}
                  style={{ textAlign: c.align || "right" }}>
                {renderCell(r, c, false)}
              </td>
            ))}
          </tr>
        ))}
        {totals && (
          <tr className="pp-total-row">
            {cols.map(c => (
              <td key={c.key}
                  className={`${c.dividerRight ? "col-divider-right" : ""}${c.key === "pitch_name" ? "" : ""}`}
                  style={{ textAlign: c.align || "right" }}>
                {renderCell(totals, c, true)}
              </td>
            ))}
          </tr>
        )}
      </tbody>
    </table>
  );
}
