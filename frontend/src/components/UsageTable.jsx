import React, { useMemo } from "react";
import { PITCH_COLORS, CARD_USAGE_COLUMNS } from "../constants";

/**
 * Usage tab: per-pitch-type usage rates across count buckets, plus pitch-type PAR%.
 *
 * Count buckets (bucketed by balls-strikes BEFORE the pitch was thrown):
 *   0-0:         (0,0)
 *   Early:       (0,1), (1,0), (1,1)
 *   Behind:      (2,0), (2,1), (3,0), (3,1)
 *   Two-Strikes: (0,2), (1,2), (2,2), (3,2)
 *
 * Bucket columns = % of pitches in that bucket that were this pitch type (columns sum to ~100%).
 * PAR% (per pitch type) = Ks on this pitch type / pitches of this type thrown in a 2-strike count.
 */

function bucketFor(balls, strikes) {
  if (balls == null || strikes == null) return null;
  if (balls === 0 && strikes === 0) return "firstpitch";
  if (strikes === 2) return "two_str";
  // Behind in the count: 2-0, 2-1, 3-0, 3-1
  if (balls >= 2 && strikes < 2) return "behind";
  // Early: 0-1, 1-0, 1-1 (everything else with strikes < 2 and balls < 2)
  if (strikes < 2 && balls < 2) return "early";
  return null;
}

export default function UsageTable({ pitches, batterFilter, gameFilter, isMobile, selectedPitchType, onPitchTypeClick }) {
  const { rows, totals } = useMemo(() => {
    if (!pitches || pitches.length === 0) return { rows: [], totals: null };

    let fp = pitches;
    if (gameFilter && gameFilter !== "all") {
      fp = fp.filter(p => String(p.game_pk) === String(gameFilter));
    }
    if (batterFilter === "L") fp = fp.filter(p => p.stand === "L");
    else if (batterFilter === "R") fp = fp.filter(p => p.stand === "R");

    // Bucket totals (denominators for the usage columns)
    const bucketTotals = { firstpitch: 0, early: 0, behind: 0, two_str: 0 };
    // Per-pitch-type counters
    const byType = new Map();

    for (const p of fp) {
      const name = p.pitch_name;
      if (!name) continue;
      const b = bucketFor(p.balls, p.strikes);
      let rec = byType.get(name);
      if (!rec) {
        rec = { count: 0, firstpitch: 0, early: 0, behind: 0, two_str: 0, two_str_ks: 0 };
        byType.set(name, rec);
      }
      rec.count++;
      if (b) {
        rec[b]++;
        bucketTotals[b]++;
      }
      // PAR% numerator: any K event on this pitch type whose count at pitch
      // release was a two-strike count.
      if (b === "two_str") {
        const ev = (p.events || "").toLowerCase();
        if (ev === "strikeout" || ev === "strikeout_double_play") rec.two_str_ks++;
      }
    }

    const rows = [];
    for (const [name, r] of byType.entries()) {
      rows.push({
        pitch_name: name,
        count: r.count,
        firstpitch_pct: bucketTotals.firstpitch > 0 ? Math.round((r.firstpitch / bucketTotals.firstpitch) * 100) : 0,
        early_pct: bucketTotals.early > 0 ? Math.round((r.early / bucketTotals.early) * 100) : 0,
        behind_pct: bucketTotals.behind > 0 ? Math.round((r.behind / bucketTotals.behind) * 100) : 0,
        two_str_use_pct: bucketTotals.two_str > 0 ? Math.round((r.two_str / bucketTotals.two_str) * 100) : 0,
        par_pct: r.two_str > 0 ? Math.round((r.two_str_ks / r.two_str) * 100) : null,
        _two_str_raw: r.two_str,
        _two_str_ks_raw: r.two_str_ks,
      });
    }
    rows.sort((a, b) => b.count - a.count);

    const totalKsTwoStr = rows.reduce((s, r) => s + r._two_str_ks_raw, 0);
    const totalTwoStr = rows.reduce((s, r) => s + r._two_str_raw, 0);
    const totals = {
      pitch_name: "Total",
      count: rows.reduce((s, r) => s + r.count, 0),
      // Raw counts in the totals row so the user can see how many pitches
      // fell in each bucket — per-type percentages sum to 100% by construction.
      firstpitch_pct: bucketTotals.firstpitch,
      early_pct: bucketTotals.early,
      behind_pct: bucketTotals.behind,
      two_str_use_pct: bucketTotals.two_str,
      par_pct: totalTwoStr > 0 ? Math.round((totalKsTwoStr / totalTwoStr) * 100) : null,
    };

    return { rows, totals };
  }, [pitches, batterFilter, gameFilter]);

  if (rows.length === 0) return <div className="no-data">No usage data available.</div>;

  const cols = CARD_USAGE_COLUMNS;
  const pctKeys = new Set(["firstpitch_pct", "early_pct", "behind_pct", "two_str_use_pct", "par_pct"]);
  // Totals row displays raw counts (not %) for the usage buckets.
  const totalsRawKeys = new Set(["firstpitch_pct", "early_pct", "behind_pct", "two_str_use_pct"]);

  const renderCell = (row, col, isTotal) => {
    const v = row[col.key];
    if (col.key === "pitch_name") {
      if (isTotal) return <span className="pp-total-label">{v}</span>;
      const c = PITCH_COLORS[v] || "#D9D9D9";
      return <span style={{ color: c, fontWeight: 600 }}>{v}</span>;
    }
    if (v == null || v === "") return <span style={{ color: "rgb(180, 185, 219)" }}>—</span>;
    if (isTotal && totalsRawKeys.has(col.key)) return v;
    if (pctKeys.has(col.key)) return `${v}%`;
    return v;
  };

  return (
    <table style={{ width: "100%", fontVariantNumeric: "tabular-nums" }}>
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={c.key}
                className={`${c.dividerRight ? "col-divider-right" : ""}${isMobile && i === 0 ? " mobile-sticky-col" : ""}`}
                style={{
                  textAlign: c.align || "right",
                  ...(isMobile && i === 0 ? {
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    background: "var(--surface2)",
                    minWidth: 80
                  } : {})
                }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const isDimmedRow = selectedPitchType && r.pitch_name !== selectedPitchType;
          return (
            <tr key={i}
                className={onPitchTypeClick ? "clickable-row" : ""}
                style={isDimmedRow ? { opacity: 0.4 } : undefined}
                onClick={() => onPitchTypeClick && r.pitch_name && onPitchTypeClick(r.pitch_name)}>
              {cols.map((c, colIdx) => (
                <td key={c.key}
                    className={`${c.dividerRight ? "col-divider-right" : ""}${isMobile && colIdx === 0 ? " mobile-sticky-col" : ""}`}
                    style={{
                      textAlign: c.align || "right",
                      ...(isMobile && colIdx === 0 ? {
                        position: "sticky",
                        left: 0,
                        zIndex: 3,
                        background: "var(--surface2)",
                        minWidth: 80
                      } : {})
                    }}>
                  {renderCell(r, c, false)}
                </td>
              ))}
            </tr>
          );
        })}
        {totals && (
          <tr className="pp-total-row" style={{ ...(isMobile ? { position: "sticky", bottom: 0, zIndex: 2 } : {}), cursor: selectedPitchType && onPitchTypeClick ? "pointer" : undefined }} onClick={() => selectedPitchType && onPitchTypeClick && onPitchTypeClick(selectedPitchType)}>
            {cols.map((c, colIdx) => (
              <td key={c.key}
                  className={`${c.dividerRight ? "col-divider-right" : ""}${isMobile && colIdx === 0 ? " mobile-sticky-col" : ""}`}
                  style={{
                    textAlign: c.align || "right",
                    ...(isMobile && colIdx === 0 ? {
                      position: "sticky",
                      left: 0,
                      zIndex: 4,
                      background: "#363957",
                      minWidth: 80
                    } : {})
                  }}>
                {renderCell(totals, c, true)}
              </td>
            ))}
          </tr>
        )}
      </tbody>
    </table>
  );
}
