import React, { useRef, useEffect, useState, useCallback } from "react";
import { PITCH_COLORS, PITCH_DESC_COLORS, getSZResultColor } from "../constants";
import { getSprayDirection, getResultColor } from "../utils/formatting";

const W = 310, H = 345;
const PAD = { top: 16, right: 16, bottom: 44, left: 16 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const X_RANGE = [-2, 2];
const Y_RANGE = [0.5, 4.5];
const HIT_RADIUS = 10;

function toCanvas(px, pz) {
  const x = PAD.left + ((px - X_RANGE[0]) / (X_RANGE[1] - X_RANGE[0])) * PLOT_W;
  const y = PAD.top + ((Y_RANGE[1] - pz) / (Y_RANGE[1] - Y_RANGE[0])) * PLOT_H;
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

export default function StrikeZonePlot({ pitches, szTop, szBot, stand, colorMode = "pitch-type" }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const pitchPositions = useRef([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#2E3150";
    ctx.fillRect(0, 0, W, H);

    const top = szTop || 3.5;
    const bot = szBot || 1.5;
    const [zl, zt] = toCanvas(-0.83, top);
    const [zr, zb] = toCanvas(0.83, bot);

    ctx.fillStyle = "rgba(100, 108, 150, 0.05)";
    ctx.fillRect(zl, zt, zr - zl, zb - zt);

    ctx.strokeStyle = "rgba(106, 110, 144, 0.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(zl, zt, zr - zl, zb - zt);

    const zoneW = (zr - zl) / 3;
    const zoneH = (zb - zt) / 3;
    ctx.strokeStyle = "rgba(72, 76, 112, 0.35)";
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(zl + zoneW * i, zt); ctx.lineTo(zl + zoneW * i, zb); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(zl, zt + zoneH * i); ctx.lineTo(zr, zt + zoneH * i); ctx.stroke();
    }

    // Home plate
    const plateW = zr - zl;
    const plateCX = (zl + zr) / 2;
    const plateStartY = zb + 60;
    const bevelH = Math.round(plateW * 0.12);
    const sideH = Math.round(plateW * 0.06);
    const totalH = bevelH + sideH;
    ctx.beginPath();
    ctx.moveTo(plateCX, plateStartY);
    ctx.lineTo(plateCX + plateW / 2, plateStartY + bevelH);
    ctx.lineTo(plateCX + plateW / 2, plateStartY + totalH);
    ctx.lineTo(plateCX - plateW / 2, plateStartY + totalH);
    ctx.lineTo(plateCX - plateW / 2, plateStartY + bevelH);
    ctx.closePath();
    ctx.fillStyle = "rgba(140, 145, 175, 0.22)";
    ctx.fill();
    ctx.strokeStyle = "rgba(160, 164, 190, 0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Pitch dots
    const positions = [];
    let filtered = (pitches || []).filter(p =>
      p.plate_x != null && p.plate_z != null && p.stand === stand
    );
    // PA Results mode: only show PA-ending pitches
    if (colorMode === "pa-result") {
      filtered = filtered.filter(p => p.events);
    }
    filtered.forEach((p) => {
      const [x, y] = toCanvas(-p.plate_x, p.plate_z);
      if (x < PAD.left - 8 || x > PAD.left + PLOT_W + 8 || y < PAD.top - 8 || y > PAD.top + PLOT_H + 8) return;
      positions.push({ x, y, pitch: p });
      // Color based on mode
      let color;
      if (colorMode === "pitch-result") {
        color = getSZResultColor(p);
      } else {
        // pitch-type and pa-result both use pitch type colors
        color = PITCH_COLORS[p.pitch_name] || "#D9D9D9";
      }
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 6.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    pitchPositions.current = positions;
  }, [pitches, szTop, szBot, stand, colorMode]);

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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top) * (H / rect.height);
    const nearest = findNearest(mx, my);
    if (nearest) {
      setHover({ pitch: nearest.pitch, x: e.clientX, y: e.clientY });
    } else {
      setHover(null);
    }
  }, [findNearest]);

  const handleMouseLeave = useCallback(() => setHover(null), []);

  const p = hover?.pitch;
  const isPA = p?.events;

  // Helper to format pitch result
  const getPitchResult = () => {
    if (isPA) {
      // PA-ending pitch: show event
      const eventLabel = p.events.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const resultColor = getResultColor(p.events);
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
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <canvas
        ref={canvasRef}
        style={{ borderRadius: 6 }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {hover && p && pitchResult && (
        <div className="pitch-tooltip" style={{
          left: hover.x - (wrapRef.current?.getBoundingClientRect().left || 0),
          top: hover.y - (wrapRef.current?.getBoundingClientRect().top || 0) - 10,
          minWidth: 280,
        }}>
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
  );
}
