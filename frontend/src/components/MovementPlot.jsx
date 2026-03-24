import React, { useRef, useEffect, useState, useCallback } from "react";
import { PITCH_COLORS, PITCH_DESC_COLORS } from "../constants";
import { getSprayDirection, getResultColor, classifyBattedBall, getBIPQuality } from "../utils/formatting";

const DEFAULT_W = 345, DEFAULT_H = 345;
const PAD = { top: 16, right: 16, bottom: 16, left: 16 };
const RANGE = 25;
const HIT_RADIUS = 10;

function toCanvas(ihb, ivb, W, H) {
  const PLOT_W = W - PAD.left - PAD.right;
  const PLOT_H = H - PAD.top - PAD.bottom;
  const x = PAD.left + ((ihb + RANGE) / (2 * RANGE)) * PLOT_W;
  const y = PAD.top + ((RANGE - ivb) / (2 * RANGE)) * PLOT_H;
  return [x, y];
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function basesString(on1b, on2b, on3b) {
  const bases = [];
  if (on1b) bases.push("1st");
  if (on2b) bases.push("2nd");
  if (on3b) bases.push("3rd");
  if (bases.length === 0) return "Bases Empty";
  return bases.join(" & ");
}

export default function MovementPlot({ pitches, hand, onReclassify, isMobile = false }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const [hover, setHover] = useState(null);

  // Build pitch positions for hit detection
  const pitchPositions = useRef([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    // Determine responsive sizing
    let W = DEFAULT_W, H = DEFAULT_H;
    if (isMobile && containerRef.current) {
      const containerWidth = containerRef.current.offsetWidth;
      if (containerWidth > 0) {
        W = Math.min(containerWidth - 24, 345);
        H = W; // Square plot
      } else {
        W = 290;
        H = 290;
      }
    }

    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#2E3150";
    ctx.fillRect(0, 0, W, H);

    const PLOT_W = W - PAD.left - PAD.right;
    const PLOT_H = H - PAD.top - PAD.bottom;
    const [cx, cy] = toCanvas(0, 0, W, H);
    const pxPerInch = PLOT_W / (2 * RANGE);

    const radii = [6, 12, 18, 24];
    radii.forEach(r => {
      const rPx = r * pxPerInch;
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(110, 114, 155, 0.45)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = "rgba(180, 184, 210, 0.7)";
      ctx.font = "500 11px DM Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(r + '"', cx, cy - rPx - 3);
    });

    ctx.strokeStyle = "rgba(100, 104, 140, 0.35)";
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(cx, PAD.top); ctx.lineTo(cx, PAD.top + PLOT_H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD.left, cy); ctx.lineTo(PAD.left + PLOT_W, cy); ctx.stroke();

    const positions = [];
    if (pitches && pitches.length) {
      pitches.forEach((p, idx) => {
        if (p.pfx_x == null || p.pfx_z == null) return;
        const ihb = -p.pfx_x;
        const ivb = p.pfx_z;
        const [x, y] = toCanvas(ihb, ivb, W, H);
        if (x < PAD.left - 8 || x > PAD.left + PLOT_W + 8 || y < PAD.top - 8 || y > PAD.top + PLOT_H + 8) return;
        positions.push({ x, y, idx, pitch: p });
        const color = PITCH_COLORS[p.pitch_name] || "#D9D9D9";
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 0.8;
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }
    pitchPositions.current = positions;
  }, [pitches, hand, isMobile]);

  const findNearest = useCallback((mx, my) => {
    let closest = null;
    let minDist = HIT_RADIUS;
    for (const pos of pitchPositions.current) {
      const d = Math.sqrt((mx - pos.x) ** 2 + (my - pos.y) ** 2);
      if (d < minDist) { minDist = d; closest = pos; }
    }
    return closest;
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (isMobile) return; // Skip mouse move on mobile
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    const mx = (e.clientX - rect.left) * (canvas.width / (W * (window.devicePixelRatio || 1)));
    const my = (e.clientY - rect.top) * (canvas.height / (H * (window.devicePixelRatio || 1)));
    const nearest = findNearest(mx, my);
    if (nearest) {
      setHover({
        pitch: nearest.pitch,
        x: e.clientX,
        y: e.clientY,
      });
    } else {
      setHover(null);
    }
  }, [findNearest, isMobile]);

  const handleMouseLeave = useCallback(() => setHover(null), []);

  const handleClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    const mx = (e.clientX - rect.left) * (canvas.width / (W * (window.devicePixelRatio || 1)));
    const my = (e.clientY - rect.top) * (canvas.height / (H * (window.devicePixelRatio || 1)));
    const nearest = findNearest(mx, my);
    if (nearest) {
      if (isMobile) {
        // On mobile, tap shows tooltip
        setHover({
          pitch: nearest.pitch,
          x: e.clientX,
          y: e.clientY,
        });
      } else if (onReclassify) {
        // On desktop, click can trigger reclassify
        onReclassify(nearest.pitch);
      }
    } else if (isMobile) {
      // On mobile, tap on empty area closes tooltip
      setHover(null);
    }
  }, [findNearest, isMobile, onReclassify]);

  const p = hover?.pitch;
  const isPA = p?.events;

  // Helper to format pitch result
  const getPitchResult = () => {
    if (isPA) {
      // PA-ending pitch: show event
      const eventLabel = p.events.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const resultColor = getResultColor(p.events);
      // Strikeout: prefix with Called Strike or Swinging Strike
      const rLower = p.events.toLowerCase();
      if (rLower === "strikeout" || rLower === "strikeout_double_play") {
        const desc = (p.description || "").toLowerCase();
        const prefix = desc.includes("called") ? "Called Strike" : "Swinging Strike";
        return { label: `${prefix} - ${eventLabel}`, color: resultColor };
      }
      return { label: eventLabel, color: resultColor };
    } else {
      // Non-PA pitch: show description
      // Normalize foul_tip and swinging_strike_blocked → "Swinging Strike"
      let rawDesc = p.description || "";
      if (rawDesc === "foul_tip" || rawDesc === "swinging_strike_blocked") rawDesc = "swinging_strike";
      const descLabel = rawDesc ? rawDesc.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "";
      const resultColor = PITCH_DESC_COLORS[p.description] || "#ccc";
      return { label: descLabel, color: resultColor };
    }
  };

  const pitchResult = p ? getPitchResult() : null;

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block", width: "100%" }}>
      <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
        <canvas
          ref={canvasRef}
          style={{ borderRadius: 6, cursor: onReclassify ? "pointer" : "default" }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
        />
      {hover && p && pitchResult && (
        <div className={isMobile ? "pitch-tooltip mobile-tooltip" : "pitch-tooltip"} style={isMobile ? {
          position: "fixed",
          bottom: 16,
          left: 16,
          right: 16,
          transform: "none",
          minWidth: "auto",
          zIndex: 1000,
          pointerEvents: "auto",
        } : {
          left: hover.x - (wrapRef.current?.getBoundingClientRect().left || 0),
          top: hover.y - (wrapRef.current?.getBoundingClientRect().top || 0) - 10,
          minWidth: 280,
        }}>
          {isMobile && (
            <button
              className="mobile-tooltip-close"
              onClick={() => setHover(null)}
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                background: "none",
                border: "none",
                color: "#e0e2ec",
                fontSize: "24px",
                cursor: "pointer",
                padding: 0,
                width: 32,
                height: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ×
            </button>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            {/* LEFT COLUMN: Text Info */}
            <div style={{ flex: 1 }}>
              {/* Line 1: Pitch type + velocity */}
              <div className="pt-row" style={{ marginBottom: 4 }}>
                <span style={{ color: PITCH_COLORS[p.pitch_name] || "#ccc", fontWeight: 600 }}>
                  {p.pitch_name}
                </span>
                <span style={{ marginLeft: 6 }}>
                  {p.release_speed ? p.release_speed.toFixed(1) + " mph" : ""}
                </span>
              </div>

              {/* Line 2: vs Batter + handedness */}
              {p.batter_name && (
                <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                  vs {p.batter_name}
                </div>
              )}

              {/* Line 3: Game state top - inning + men on base */}
              {p.inning != null && p.inning_topbot && (
                <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                  {p.inning_topbot === "Top" ? "Top" : "Bot"} {ordinal(p.inning)} | {basesString(p.on_1b, p.on_2b, p.on_3b)}
                </div>
              )}

              {/* Line 4: Game state bottom - outs + count */}
              {p.outs_when_up != null && p.balls != null && p.strikes != null && (
                <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                  {p.outs_when_up} Outs | {p.balls}-{p.strikes}
                </div>
              )}

              {/* Line 5: iVB + iHB + Extension */}
              {p.pfx_z != null && p.pfx_x != null && (
                <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                  iVB {p.pfx_z.toFixed(1)}" · iHB {(-p.pfx_x).toFixed(1)}"
                  {p.release_extension != null && ` · Ext ${p.release_extension.toFixed(1)}ft`}
                </div>
              )}

              {/* Line 6: Pitch result - colored, with EV/LA/spray for PA balls in play */}
              {pitchResult.label && (
                <div className="pt-row" style={{ color: pitchResult.color, fontWeight: 500, fontSize: "0.85em" }}>
                  <span>{pitchResult.label}</span>
                  {isPA && p.launch_speed != null && <span> · {p.launch_speed.toFixed(1)} EV</span>}
                  {isPA && p.launch_angle != null && <span> · {p.launch_angle.toFixed(0)}° LA</span>}
                  {isPA && p.hc_x != null && <span> {getSprayDirection(p.hc_x, p.hc_y)}</span>}
                </div>
              )}

              {/* Line 7: BIP quality + Savant batted ball tag */}
              {isPA && p.launch_speed != null && p.launch_angle != null && (() => {
                const tag = classifyBattedBall(p.launch_speed, p.launch_angle);
                if (!tag) return null;
                const quality = getBIPQuality(tag, p.launch_angle);
                return (
                  <div className="pt-row" style={{ fontSize: "0.85em", color: "rgba(180,184,210,0.7)" }}>
                    {quality} — {tag}
                  </div>
                );
              })()}
            </div>

            {/* RIGHT COLUMN: Mini Strikezone SVG */}
            {p.plate_x != null && p.plate_z != null && (
              <svg width="65" height="103" viewBox="0 0 65 103" style={{ flexShrink: 0 }}>
                {/* Strike zone box */}
                <rect x="12" y="17" width="41" height="50" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />

                {/* 3x3 grid - vertical lines */}
                {[1, 2].map(i => (
                  <line
                    key={`v${i}`}
                    x1={12 + (i * 41) / 3}
                    y1="17"
                    x2={12 + (i * 41) / 3}
                    y2="67"
                    stroke="rgba(255,255,255,0.1)"
                    strokeWidth="0.5"
                  />
                ))}

                {/* 3x3 grid - horizontal lines */}
                {[1, 2].map(i => (
                  <line
                    key={`h${i}`}
                    x1="12"
                    y1={17 + (i * 50) / 3}
                    x2="53"
                    y2={17 + (i * 50) / 3}
                    stroke="rgba(255,255,255,0.1)"
                    strokeWidth="0.5"
                  />
                ))}

                {/* Home plate - pentagon with point at TOP (pitcher's perspective) */}
                <polygon
                  points="32.5,87 42,92 42,99 23,99 23,92"
                  fill="rgba(140,145,175,0.22)"
                  stroke="rgba(160,164,190,0.35)"
                  strokeWidth="0.8"
                />

                {/* Batter side label (LHB/RHB) */}
                {(() => {
                  const isLeft = p.stand === "L";
                  const lx = isLeft ? 6 : 59;
                  const letters = isLeft ? ["L", "H", "B"] : ["R", "H", "B"];
                  return letters.map((ch, i) => (
                    <text key={i} x={lx} y={33 + i * 10} fill="rgba(150,155,185,0.28)" fontSize="7" fontWeight="bold" textAnchor="middle" dominantBaseline="middle" fontFamily="'DM Sans', sans-serif">{ch}</text>
                  ));
                })()}

                {/* Pitch location dot */}
                {(() => {
                  const dotX = 12 + ((-p.plate_x + 0.83) / 1.66) * 41;
                  const dotY = 17 + ((3.5 - p.plate_z) / 2.0) * 50;
                  const pitchColor = PITCH_COLORS[p.pitch_name] || "#D9D9D9";
                  return (
                    <circle
                      cx={dotX}
                      cy={dotY}
                      r="4"
                      fill={pitchColor}
                      stroke="rgba(0,0,0,0.4)"
                      strokeWidth="0.8"
                    />
                  );
                })()}
              </svg>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
