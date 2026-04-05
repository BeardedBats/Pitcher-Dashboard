import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { PITCH_COLORS, BATTED_BALL_COLORS } from "../constants";
import { isRunScored, getTooltipResult } from "../utils/pitchFilters";
import { classifyBattedBall } from "../utils/formatting";

const DOT_R = 4.5;
const DOT_PAD = 3;
const GLOW_R = 12;

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function hex2rgba(hex, a) {
  if (!hex || hex.startsWith("rgba")) return hex;
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
}

function basesString(on1b, on2b, on3b) {
  const bases = [];
  if (on1b) bases.push("1st");
  if (on2b) bases.push("2nd");
  if (on3b) bases.push("3rd");
  if (bases.length === 0) return "Bases Empty";
  return bases.join(" & ");
}

export default function VelocityTrendV2({ pitches, onReclassify, isMobile }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const dotsRef = useRef([]);
  const [hover, setHover] = useState(null);
  const [dims, setDims] = useState({ w: 0 });
  const [highlightType, setHighlightType] = useState(null);
  const [lockedType, setLockedType] = useState(null);
  const [mobileTooltipVis, setMobileTooltipVis] = useState(null);

  const { ordered, inningBounds, typeStats, pitchTypes, globalMin, globalMax } = useMemo(() => {
    if (!pitches || pitches.length === 0)
      return { ordered: [], inningBounds: [], typeStats: {}, pitchTypes: [], globalMin: 0, globalMax: 0 };

    const sorted = [...pitches].sort((a, b) => {
      if (a.at_bat_number != null && b.at_bat_number != null) {
        if (a.at_bat_number !== b.at_bat_number) return a.at_bat_number - b.at_bat_number;
        return (a.pitch_number || 0) - (b.pitch_number || 0);
      }
      return 0;
    });

    const bounds = [];
    let lastInning = null;
    const ord = sorted.map((p, i) => {
      const inn = p.inning;
      if (inn != null && inn !== lastInning) {
        bounds.push({ pitchIdx: i + 1, inning: inn });
        lastInning = inn;
      }
      return { ...p, _seqNum: i + 1 };
    });

    const stats = {};
    let gMin = Infinity, gMax = -Infinity;
    for (const p of ord) {
      const name = p.pitch_name;
      if (!name || p.release_speed == null) continue;
      if (!stats[name]) stats[name] = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
      const s = stats[name];
      s.min = Math.min(s.min, p.release_speed);
      s.max = Math.max(s.max, p.release_speed);
      s.sum += p.release_speed;
      s.count++;
      gMin = Math.min(gMin, p.release_speed);
      gMax = Math.max(gMax, p.release_speed);
    }
    for (const k of Object.keys(stats)) stats[k].avg = stats[k].sum / stats[k].count;

    // Sort pitch types by avg velo descending
    const types = Object.keys(stats).sort((a, b) => stats[b].avg - stats[a].avg);

    return { ordered: ord, inningBounds: bounds, typeStats: stats, pitchTypes: types, globalMin: gMin, globalMax: gMax };
  }, [pitches]);

  // Measure container width
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setDims((d) => ({ ...d, w }));
      }
    });
    ro.observe(el);
    setDims((d) => ({ ...d, w: el.offsetWidth }));
    return () => ro.disconnect();
  }, []);

  const LEGEND_H = 32;
  const H = isMobile ? 280 : 340;

  // Locked type takes priority over hover
  const activeHighlight = lockedType || highlightType;

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dims.w === 0 || ordered.length === 0 || pitchTypes.length === 0) return;

    const W = dims.w;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const PAD = { top: 16, bottom: 40, left: 20, right: 70 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const laneInnerPad = 6;
    const innerTop = PAD.top + laneInnerPad;
    const innerH = plotH - laneInnerPad * 2;

    ctx.fillStyle = "#252840";
    ctx.fillRect(0, 0, W, H);

    const totalPitches = ordered.length;
    const toX = (pn) => PAD.left + ((pn - 1) / Math.max(totalPitches - 1, 1)) * plotW;

    // Add 0.5mph padding to velocity range
    const veloPad = 0.5;
    const veloMin = globalMin - veloPad;
    const veloMax = globalMax + veloPad;
    const veloRange = veloMax - veloMin || 1;
    const toY = (velo) => innerTop + ((veloMax - velo) / veloRange) * innerH;

    // Vertical barriers for dot x-clamping
    const barriers = [PAD.left, PAD.left + plotW];
    for (const bd of inningBounds) {
      if (bd.pitchIdx > 1) barriers.push(toX(bd.pitchIdx) - 2);
    }
    barriers.sort((a, b) => a - b);

    function adjustDotX(rawX) {
      let cx = rawX + DOT_R;
      for (const bx of barriers) {
        if (cx - DOT_R < bx + DOT_PAD && cx + DOT_R > bx - DOT_PAD) {
          cx = bx + DOT_PAD + DOT_R;
        }
      }
      if (cx + DOT_R + DOT_PAD > PAD.left + plotW) {
        cx = PAD.left + plotW - DOT_PAD - DOT_R;
      }
      return cx;
    }

    // Full lane background
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.fillRect(PAD.left, innerTop, plotW, innerH);

    // Alternating inning panels
    const containerTop = innerTop;
    const containerBot = innerTop + innerH;
    for (let i = 0; i < inningBounds.length; i++) {
      const bd = inningBounds[i];
      const sx = bd.pitchIdx <= 1 ? PAD.left : toX(bd.pitchIdx) - 2;
      const ex = i + 1 < inningBounds.length ? toX(inningBounds[i + 1].pitchIdx) - 2 : PAD.left + plotW;
      if (i % 2 === 1) {
        ctx.fillStyle = "rgba(255,255,255,0.02)";
        ctx.fillRect(sx, containerTop, ex - sx, containerBot - containerTop);
      }
    }

    // Draw dots
    const dots = [];
    for (const p of ordered) {
      if (!p.pitch_name || p.release_speed == null) continue;
      const color = PITCH_COLORS[p.pitch_name] || "#888";
      const rawX = toX(p._seqNum);
      const cx = adjustDotX(rawX);
      const rawY = toY(p.release_speed);
      const cy = Math.max(innerTop + DOT_R + DOT_PAD, Math.min(innerTop + innerH - DOT_R - DOT_PAD, rawY));

      const isDimmed = activeHighlight && p.pitch_name !== activeHighlight;

      // Glow for run-scored pitches
      if (isRunScored(p) && !isDimmed) {
        const hex = PITCH_COLORS[p.pitch_name] || "#888888";
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        ctx.save();
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, GLOW_R);
        grad.addColorStop(0, `rgba(${r},${g},${b},0.6)`);
        grad.addColorStop(0.45, `rgba(${r},${g},${b},0.2)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, GLOW_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.fillStyle = color;
      ctx.globalAlpha = isDimmed ? 0.2 : 0.85;
      ctx.beginPath();
      ctx.arc(cx, cy, DOT_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      dots.push({ x: cx, y: cy, pitch: p });
    }

    // Inning dividers
    for (const bd of inningBounds) {
      if (bd.pitchIdx <= 1) continue;
      const x = toX(bd.pitchIdx) - 2;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, containerTop);
      ctx.lineTo(x, containerBot);
      ctx.stroke();
      ctx.restore();
    }

    // Right side label area
    const rx = PAD.left + plotW + 8;

    // Swim lane overlay when a pitch type is locked
    if (lockedType && typeStats[lockedType]) {
      const ls = typeStats[lockedType];
      const laneColor = PITCH_COLORS[lockedType] || "#888";
      const laneTopY = toY(ls.max);
      const laneBotY = toY(ls.min);
      const laneAvgY = toY(ls.avg);

      // Top and bottom boundary lines
      ctx.save();
      ctx.strokeStyle = laneColor;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, laneTopY);
      ctx.lineTo(PAD.left + plotW, laneTopY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(PAD.left, laneBotY);
      ctx.lineTo(PAD.left + plotW, laneBotY);
      ctx.stroke();

      // Semi-transparent lane fill
      ctx.fillStyle = laneColor;
      ctx.globalAlpha = 0.06;
      ctx.fillRect(PAD.left, laneTopY, plotW, laneBotY - laneTopY);

      // Dotted average line
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = laneColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, laneAvgY);
      ctx.lineTo(PAD.left + plotW, laneAvgY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Right-side labels for locked type: max, avg, min — with anti-overlap
      ctx.font = "bold 10px 'DM Sans', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const LANE_LABEL_H = 12;
      const laneLabels = [
        { y: laneTopY, text: ls.max.toFixed(1), alpha: 0.8 },
        { y: laneAvgY, text: ls.avg.toFixed(1), alpha: 1 },
        { y: laneBotY, text: ls.min.toFixed(1), alpha: 0.8 },
      ].sort((a, b) => a.y - b.y);
      // Push apart any overlapping labels
      for (let i = 1; i < laneLabels.length; i++) {
        if (laneLabels[i].y - laneLabels[i - 1].y < LANE_LABEL_H) {
          const mid = (laneLabels[i - 1].y + laneLabels[i].y) / 2;
          laneLabels[i - 1].y = mid - LANE_LABEL_H / 2;
          laneLabels[i].y = mid + LANE_LABEL_H / 2;
        }
      }
      // Second pass for 3-way overlap
      for (let i = 1; i < laneLabels.length; i++) {
        if (laneLabels[i].y - laneLabels[i - 1].y < LANE_LABEL_H) {
          laneLabels[i].y = laneLabels[i - 1].y + LANE_LABEL_H;
        }
      }
      for (const lbl of laneLabels) {
        ctx.fillStyle = laneColor;
        ctx.globalAlpha = lbl.alpha;
        ctx.fillText(lbl.text, rx, lbl.y);
      }
      ctx.globalAlpha = 1;
    } else {
      // Default: hardest at top, softest at bottom (global range labels)
      ctx.font = "bold 10px 'DM Sans', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(180,184,210,0.5)";
      ctx.fillText(globalMax.toFixed(1), rx, innerTop + 6);
      ctx.fillText(globalMin.toFixed(1), rx, innerTop + innerH - 4);

      // Right side: per-type average velocity labels with anti-overlap
      const avgLabels = pitchTypes.map(type => {
        const s = typeStats[type];
        const y = toY(s.avg);
        const color = PITCH_COLORS[type] || "#888";
        return { type, y, label: s.avg.toFixed(1), color };
      });

      // Anti-overlap: stack labels that are within 12px of each other
      const LABEL_H = 12;
      const resolvedLabels = [...avgLabels].sort((a, b) => a.y - b.y);
      for (let i = 1; i < resolvedLabels.length; i++) {
        const prev = resolvedLabels[i - 1];
        const cur = resolvedLabels[i];
        if (cur.y - prev.y < LABEL_H) {
          const mid = (prev.y + cur.y) / 2;
          prev.y = mid - LABEL_H / 2;
          cur.y = mid + LABEL_H / 2;
        }
      }

      for (const lbl of resolvedLabels) {
        const isDimmed = activeHighlight && lbl.type !== activeHighlight;
        ctx.fillStyle = lbl.color;
        ctx.globalAlpha = isDimmed ? 0.3 : 0.9;
        ctx.font = "bold 10px 'DM Sans', sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(lbl.label, rx, lbl.y);
        ctx.globalAlpha = 1;
      }
    }

    // X-axis: pitch numbers at intervals of 15
    ctx.fillStyle = "#FFFFF0";
    ctx.font = "12px 'DM Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 15; i <= totalPitches; i += 15) {
      ctx.fillText(i, toX(i), containerBot + 8);
    }

    dotsRef.current = dots;
  }, [ordered, pitchTypes, typeStats, inningBounds, dims, globalMin, globalMax, activeHighlight, lockedType]);

  // Hover handling
  const handleMouseMove = useCallback(
    (e) => {
      if (isMobile) return; // mobile uses tap instead
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (dims.w / rect.width);
      const my = (e.clientY - rect.top) * (H / rect.height);
      const dots = dotsRef.current;
      let near = null;
      let md = 18;
      for (const d of dots) {
        const dist = Math.sqrt((mx - d.x) ** 2 + (my - d.y) ** 2);
        if (dist < md) {
          md = dist;
          near = d;
        }
      }
      if (near) {
        setHover({ pitch: near.pitch, x: e.clientX, y: e.clientY });
      } else {
        setHover(null);
      }
      canvas.style.cursor = near ? "pointer" : "default";
    },
    [dims, isMobile, H]
  );

  const handleMouseLeave = useCallback(() => {
    if (!isMobile) setHover(null);
  }, [isMobile]);

  const handleClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);
    const dots = dotsRef.current;
    let near = null, md = 14;
    for (const d of dots) {
      const dist = Math.hypot(mx - d.x, my - d.y);
      if (dist < md) { md = dist; near = d; }
    }

    if (isMobile) {
      // Mobile: show/hide tooltip on tap
      if (near) {
        if (mobileTooltipVis && mobileTooltipVis.pitch === near.pitch) {
          setMobileTooltipVis(null);
        } else {
          setMobileTooltipVis({ pitch: near.pitch, x: e.clientX, y: e.clientY });
        }
      } else {
        setMobileTooltipVis(null);
      }
    } else {
      // Desktop: reclassify on click
      if (near && onReclassify) onReclassify(near.pitch);
    }
  }, [isMobile, mobileTooltipVis, onReclassify]);

  const handleLegendClick = (type) => {
    setLockedType(prev => prev === type ? null : type);
  };

  if (!pitches || pitches.length === 0 || pitchTypes.length === 0) {
    return (
      <div className="velocity-trend-empty" style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>
        No pitch data available for velocity trend.
      </div>
    );
  }

  const hp = hover?.pitch;
  const mobileShowTooltip = isMobile && mobileTooltipVis;

  const handleTapElsewhere = useCallback((e) => {
    if (isMobile && mobileTooltipVis && !e.target.closest(".pitch-tooltip")) {
      setMobileTooltipVis(null);
    }
  }, [isMobile, mobileTooltipVis]);

  return (
    <div ref={wrapRef} className="velocity-trend-wrap" style={{ position: "relative", width: "100%" }} onClick={handleTapElsewhere}>
      {/* Pitch type legend — horizontal, text only (no dots), centered */}
      <div
        style={{ display: "flex", gap: 0, padding: "6px 20px 10px", flexWrap: "wrap", justifyContent: "center", width: "fit-content", margin: "0 auto" }}
        onMouseLeave={() => { if (!lockedType) setHighlightType(null); }}
      >
        {pitchTypes.map(type => {
          const color = PITCH_COLORS[type] || "#888";
          const isDimmed = activeHighlight && activeHighlight !== type;
          return (
            <span
              key={type}
              onClick={() => handleLegendClick(type)}
              onMouseEnter={() => { if (!lockedType) setHighlightType(type); }}
              style={{
                color,
                opacity: isDimmed ? 0.4 : 1,
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
                transition: "opacity 0.15s",
                fontFamily: "'DM Sans', sans-serif",
                padding: "2px 10px",
              }}
            >
              {type}
            </span>
          );
        })}
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: H + "px", borderRadius: 8, display: "block", cursor: onReclassify ? "pointer" : "default" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      />
      {hp && !isMobile && <VelocityTooltipV2 pitch={hp} x={hover.x} y={hover.y} />}
      {mobileShowTooltip && <VelocityTooltipV2Mobile pitch={mobileTooltipVis.pitch} x={mobileTooltipVis.x} y={mobileTooltipVis.y} onClose={() => setMobileTooltipVis(null)} />}
    </div>
  );
}

function VelocityTooltipV2Mobile({ pitch: p, x, y, onClose }) {
  const dc = PITCH_COLORS[p.pitch_name] || "#888";
  const result = getTooltipResult(p);

  const isBIP = !!p.events && p.launch_speed != null && p.launch_angle != null &&
    (p.description || "").toLowerCase() === "hit_into_play";
  const bbTag = isBIP ? classifyBattedBall(p.launch_speed, p.launch_angle) : null;
  const bbColor = bbTag ? (BATTED_BALL_COLORS[bbTag] || "rgba(180,184,210,0.7)") : null;

  const tx = x + 16;
  const ty = y - 16;
  const style = {
    position: "fixed",
    left: tx + 300 > window.innerWidth ? x - 310 : tx,
    top: ty + 260 > window.innerHeight ? y - 260 : ty,
    zIndex: 1000,
    pointerEvents: "auto",
  };

  return (
    <div className="pitch-tooltip mobile-tooltip" style={style}>
      <button onClick={onClose} style={{
        position: "absolute",
        top: 8,
        right: 8,
        background: "none",
        border: "none",
        color: "#e0e2ec",
        fontSize: 20,
        cursor: "pointer",
        padding: 0,
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}>×</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: isBIP ? 0 : 4 }}>
        <div style={{ whiteSpace: "nowrap" }}>
          <span style={{ color: dc, fontWeight: 600 }}>{p.pitch_name}</span>
          <span style={{ marginLeft: 6, color: "#e0e2ec" }}>
            {p.release_speed ? p.release_speed.toFixed(1) + " mph" : ""}
          </span>
          <span style={{ marginLeft: 6, color: "rgba(180,184,210,0.5)", fontSize: "0.85em" }}>#{p._seqNum}</span>
        </div>
        <div style={{ whiteSpace: "nowrap", color: result.color, fontWeight: 600, marginLeft: 12 }}>
          {result.isError && result.errorOutType
            ? <>{result.errorOutType} <span style={{ color: "#feffa3" }}>(Error)</span></>
            : result.label}
          {result.isK && (
            result.isCalledStrikeThree
              ? <span style={{ marginLeft: 3 }}>(<span style={{ display: "inline-block", transform: "scaleX(-1)" }}>K</span>)</span>
              : <span style={{ marginLeft: 3 }}>(K)</span>
          )}
        </div>
      </div>
      {isBIP && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          {p.launch_speed != null && (
            <div style={{ fontSize: "0.85em", color: "rgba(180,184,210,0.7)" }}>
              {p.launch_speed.toFixed(1)} EV · {p.launch_angle != null ? p.launch_angle.toFixed(0) + "° LA" : ""}
            </div>
          )}
          {bbTag && (
            <div style={{ color: bbColor, fontWeight: 600, fontSize: "0.85em", marginLeft: 12 }}>
              {bbTag}
            </div>
          )}
        </div>
      )}
      {(p.batter_name || p.batter) && (
        <div className="pt-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, fontSize: "0.85em" }}>
          <span>vs {p.batter_name || p.batter}</span>
          {result.isK && result.subLabel && (
            <span style={{ color: "rgba(180,184,210,0.7)" }}>{result.subLabel}</span>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          {p.inning != null && p.inning_topbot && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              {p.inning_topbot === "Top" ? "Top" : "Bot"} {ordinal(p.inning)} | {basesString(p.on_1b, p.on_2b, p.on_3b)}
            </div>
          )}
          {p.outs_when_up != null && p.balls != null && p.strikes != null && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              {p.outs_when_up} Outs | {p.balls}-{p.strikes}
            </div>
          )}
          {p.pfx_z != null && p.pfx_x != null && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              iVB {p.pfx_z.toFixed(1)}" · iHB {(-p.pfx_x).toFixed(1)}"
              {p.release_extension != null && ` · Ext ${p.release_extension.toFixed(1)}ft`}
            </div>
          )}
        </div>
        {p.plate_x != null && p.plate_z != null && (
          <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-end" }}>
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
                const isLeft = p.stand === "L";
                const lx = isLeft ? 6 : 59;
                const letters = isLeft ? ["L", "H", "B"] : ["R", "H", "B"];
                return letters.map((ch, i) => (
                  <text key={i} x={lx} y={33 + i * 10} fill="rgba(150,155,185,0.28)" fontSize="7" fontWeight="bold" textAnchor="middle" dominantBaseline="middle" fontFamily="'DM Sans', sans-serif">{ch}</text>
                ));
              })()}
              {(() => {
                const dotX = 12 + ((-p.plate_x + 0.83) / 1.66) * 41;
                const dotY = 17 + ((3.5 - p.plate_z) / 2.0) * 50;
                return <circle cx={dotX} cy={dotY} r="4" fill={dc} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8" />;
              })()}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

function VelocityTooltipV2({ pitch: p, x, y }) {
  const dc = PITCH_COLORS[p.pitch_name] || "#888";
  const result = getTooltipResult(p);

  const isBIP = !!p.events && p.launch_speed != null && p.launch_angle != null &&
    (p.description || "").toLowerCase() === "hit_into_play";
  const bbTag = isBIP ? classifyBattedBall(p.launch_speed, p.launch_angle) : null;
  const bbColor = bbTag ? (BATTED_BALL_COLORS[bbTag] || "rgba(180,184,210,0.7)") : null;

  const tx = x + 16;
  const ty = y - 16;
  const style = {
    position: "fixed",
    left: tx + 300 > window.innerWidth ? x - 310 : tx,
    top: ty + 260 > window.innerHeight ? y - 260 : ty,
    zIndex: 1000,
    pointerEvents: "none",
  };

  return (
    <div className="pitch-tooltip" style={style}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: isBIP ? 0 : 4 }}>
        <div style={{ whiteSpace: "nowrap" }}>
          <span style={{ color: dc, fontWeight: 600 }}>{p.pitch_name}</span>
          <span style={{ marginLeft: 6, color: "#e0e2ec" }}>
            {p.release_speed ? p.release_speed.toFixed(1) + " mph" : ""}
          </span>
          <span style={{ marginLeft: 6, color: "rgba(180,184,210,0.5)", fontSize: "0.85em" }}>#{p._seqNum}</span>
        </div>
        <div style={{ whiteSpace: "nowrap", color: result.color, fontWeight: 600, marginLeft: 12 }}>
          {result.isError && result.errorOutType
            ? <>{result.errorOutType} <span style={{ color: "#feffa3" }}>(Error)</span></>
            : result.label}
          {result.isK && (
            result.isCalledStrikeThree
              ? <span style={{ marginLeft: 3 }}>(<span style={{ display: "inline-block", transform: "scaleX(-1)" }}>K</span>)</span>
              : <span style={{ marginLeft: 3 }}>(K)</span>
          )}
        </div>
      </div>
      {isBIP && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          {p.launch_speed != null && (
            <div style={{ fontSize: "0.85em", color: "rgba(180,184,210,0.7)" }}>
              {p.launch_speed.toFixed(1)} EV · {p.launch_angle != null ? p.launch_angle.toFixed(0) + "° LA" : ""}
            </div>
          )}
          {bbTag && (
            <div style={{ color: bbColor, fontWeight: 600, fontSize: "0.85em", marginLeft: 12 }}>
              {bbTag}
            </div>
          )}
        </div>
      )}
      {(p.batter_name || p.batter) && (
        <div className="pt-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, fontSize: "0.85em" }}>
          <span>vs {p.batter_name || p.batter}</span>
          {result.isK && result.subLabel && (
            <span style={{ color: "rgba(180,184,210,0.7)" }}>{result.subLabel}</span>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          {p.inning != null && p.inning_topbot && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              {p.inning_topbot === "Top" ? "Top" : "Bot"} {ordinal(p.inning)} | {basesString(p.on_1b, p.on_2b, p.on_3b)}
            </div>
          )}
          {p.outs_when_up != null && p.balls != null && p.strikes != null && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              {p.outs_when_up} Outs | {p.balls}-{p.strikes}
            </div>
          )}
          {p.pfx_z != null && p.pfx_x != null && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              iVB {p.pfx_z.toFixed(1)}" · iHB {(-p.pfx_x).toFixed(1)}"
              {p.release_extension != null && ` · Ext ${p.release_extension.toFixed(1)}ft`}
            </div>
          )}
        </div>
        {p.plate_x != null && p.plate_z != null && (
          <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-end" }}>
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
                const isLeft = p.stand === "L";
                const lx = isLeft ? 6 : 59;
                const letters = isLeft ? ["L", "H", "B"] : ["R", "H", "B"];
                return letters.map((ch, i) => (
                  <text key={i} x={lx} y={33 + i * 10} fill="rgba(150,155,185,0.28)" fontSize="7" fontWeight="bold" textAnchor="middle" dominantBaseline="middle" fontFamily="'DM Sans', sans-serif">{ch}</text>
                ));
              })()}
              {(() => {
                const dotX = 12 + ((-p.plate_x + 0.83) / 1.66) * 41;
                const dotY = 17 + ((3.5 - p.plate_z) / 2.0) * 50;
                return <circle cx={dotX} cy={dotY} r="4" fill={dc} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8" />;
              })()}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
