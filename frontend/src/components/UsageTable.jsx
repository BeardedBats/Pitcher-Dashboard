import React, { useMemo } from "react";
import { PITCH_COLORS, CARD_USAGE_COLUMNS } from "../constants";

/**
 * Usage tab: per-pitch-type usage rates across count buckets, split by batter hand,
 * plus combined pitch-type PAR%.
 *
 * Count buckets (bucketed by balls-strikes BEFORE the pitch was thrown):
 *   0-0:         (0,0)
 *   Early:       (0,1), (1,0), (1,1)
 *   Behind:      (2,0), (2,1), (3,0), (3,1)
 *   Two-Strikes: (0,2), (1,2), (2,2), (3,2)
 *
 * Bucket columns = % of pitches in that bucket vs the same hand that were this pitch type
 * (each LHB/RHB column block sums to ~100%).
 * PAR% (combined across hands) = Ks on this pitch type / pitches of this type thrown in a 2-strike count.
 *
 * The batter-hand filter is intentionally ignored on this tab — both LHB and RHB
 * are always rendered side-by-side.
 */

function bucketFor(balls, strikes) {
  if (balls == null || strikes == null) return null;
  if (balls === 0 && strikes === 0) return "firstpitch";
  if (strikes === 2) return "two_str";
  if (balls >= 2 && strikes < 2) return "behind";
  if (strikes < 2 && balls < 2) return "early";
  return null;
}

function emptyBucketTotals() {
  return { firstpitch: 0, early: 0, behind: 0, two_str: 0 };
}

function emptyTypeRec() {
  return {
    count: 0,
    l: { count: 0, firstpitch: 0, early: 0, behind: 0, two_str: 0 },
    r: { count: 0, firstpitch: 0, early: 0, behind: 0, two_str: 0 },
    two_str_all: 0,
    two_str_ks_all: 0,
  };
}

export default function UsageTable({ pitches, gameFilter, isMobile, selectedPitchType, onPitchTypeClick }) {
  const { rows, totals } = useMemo(() => {
    if (!pitches || pitches.length === 0) return { rows: [], totals: null };

    let fp = pitches;
    if (gameFilter && gameFilter !== "all") {
      fp = fp.filter(p => String(p.game_pk) === String(gameFilter));
    }

    const bucketTotalsL = emptyBucketTotals();
    const bucketTotalsR = emptyBucketTotals();
    const byType = new Map();

    for (const p of fp) {
      const name = p.pitch_name;
      if (!name) continue;
      const b = bucketFor(p.balls, p.strikes);
      const stand = p.stand === "L" ? "l" : p.stand === "R" ? "r" : null;
      let rec = byType.get(name);
      if (!rec) { rec = emptyTypeRec(); byType.set(name, rec); }
      rec.count++;
      if (stand) {
        rec[stand].count++;
        if (b) {
          rec[stand][b]++;
          if (stand === "l") bucketTotalsL[b]++;
          else bucketTotalsR[b]++;
        }
      }
      // Combined PAR% — count pitches of this type thrown in 2-strike counts
      // (regardless of batter hand) and Ks among those pitches.
      if (b === "two_str") {
        rec.two_str_all++;
        const ev = (p.events || "").toLowerCase();
        if (ev === "strikeout" || ev === "strikeout_double_play") rec.two_str_ks_all++;
      }
    }

    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
    const rows = [];
    for (const [name, r] of byType.entries()) {
      rows.push({
        pitch_name: name,
        // LHB
        count_l: r.l.count,
        firstpitch_pct_l: pct(r.l.firstpitch, bucketTotalsL.firstpitch),
        early_pct_l: pct(r.l.early, bucketTotalsL.early),
        behind_pct_l: pct(r.l.behind, bucketTotalsL.behind),
        two_str_use_pct_l: pct(r.l.two_str, bucketTotalsL.two_str),
        // RHB
        count_r: r.r.count,
        firstpitch_pct_r: pct(r.r.firstpitch, bucketTotalsR.firstpitch),
        early_pct_r: pct(r.r.early, bucketTotalsR.early),
        behind_pct_r: pct(r.r.behind, bucketTotalsR.behind),
        two_str_use_pct_r: pct(r.r.two_str, bucketTotalsR.two_str),
        // Combined
        par_pct: r.two_str_all > 0 ? Math.round((r.two_str_ks_all / r.two_str_all) * 100) : null,
        _count: r.count,
      });
    }
    rows.sort((a, b) => b._count - a._count);

    const totalTwoStrAll = rows.reduce((s, r) => {
      const rec = byType.get(r.pitch_name);
      return s + (rec ? rec.two_str_all : 0);
    }, 0);
    const totalKsTwoStrAll = rows.reduce((s, r) => {
      const rec = byType.get(r.pitch_name);
      return s + (rec ? rec.two_str_ks_all : 0);
    }, 0);

    const totals = {
      pitch_name: "Total",
      // Totals row shows raw bucket counts (since per-type % sums to 100% by construction)
      count_l: rows.reduce((s, r) => s + r.count_l, 0),
      firstpitch_pct_l: bucketTotalsL.firstpitch,
      early_pct_l: bucketTotalsL.early,
      behind_pct_l: bucketTotalsL.behind,
      two_str_use_pct_l: bucketTotalsL.two_str,
      count_r: rows.reduce((s, r) => s + r.count_r, 0),
      firstpitch_pct_r: bucketTotalsR.firstpitch,
      early_pct_r: bucketTotalsR.early,
      behind_pct_r: bucketTotalsR.behind,
      two_str_use_pct_r: bucketTotalsR.two_str,
      par_pct: totalTwoStrAll > 0 ? Math.round((totalKsTwoStrAll / totalTwoStrAll) * 100) : null,
    };

    return { rows, totals };
  }, [pitches, gameFilter]);

  if (rows.length === 0) return <div className="no-data">No usage data available.</div>;

  const cols = CARD_USAGE_COLUMNS;
  const pctKeys = new Set([
    "firstpitch_pct_l", "early_pct_l", "behind_pct_l", "two_str_use_pct_l",
    "firstpitch_pct_r", "early_pct_r", "behind_pct_r", "two_str_use_pct_r",
    "par_pct",
  ]);
  // Totals row displays raw counts (not %) for the bucket usage columns.
  const totalsRawKeys = new Set([
    "firstpitch_pct_l", "early_pct_l", "behind_pct_l", "two_str_use_pct_l",
    "firstpitch_pct_r", "early_pct_r", "behind_pct_r", "two_str_use_pct_r",
  ]);

  // Build group header row: collapse adjacent cols with the same `group` into a colspan.
  const groupHeaderCells = [];
  let i = 0;
  while (i < cols.length) {
    const g = cols[i].group;
    if (!g) {
      groupHeaderCells.push({ label: "", span: 1, key: cols[i].key, dividerRight: cols[i].dividerRight });
      i++;
    } else {
      let span = 1;
      let lastDivider = cols[i].dividerRight;
      while (i + span < cols.length && cols[i + span].group === g) {
        lastDivider = cols[i + span].dividerRight;
        span++;
      }
      groupHeaderCells.push({
        label: g === "lhb" ? "vs. LHB" : g === "rhb" ? "vs. RHB" : "",
        span,
        key: g,
        dividerRight: lastDivider,
        isGroup: true,
      });
      i += span;
    }
  }

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
        {/* Group header row — "vs. LHB" / "vs. RHB" labels above their column blocks */}
        <tr>
          {groupHeaderCells.map((h, idx) => (
            <th key={idx}
                colSpan={h.span}
                className={h.dividerRight ? "col-divider-right" : ""}
                style={{
                  textAlign: "center",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: h.isGroup ? "var(--text-dim, #8a8eb0)" : "transparent",
                  paddingBottom: 2,
                  borderBottom: "none",
                }}>
              {h.label || "\u00a0"}
            </th>
          ))}
        </tr>
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
