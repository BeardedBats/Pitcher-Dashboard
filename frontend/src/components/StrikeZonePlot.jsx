import React, { useRef, useEffect, useState, useCallback } from "react";
import { PITCH_COLORS, PITCH_DESC_COLORS, getSZResultColor, BATTED_BALL_COLORS } from "../constants";
import { classifyBattedBall } from "../utils/formatting";
import { getTooltipResult } from "../utils/pitchFilters";

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

export default function StrikeZonePlot({ pitches, szTop, szBot, stand, colorMode = "pitch-type", onReclassify }) {
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

  const handleClick = useCallback((e) => {
    if (!onReclassify) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const my = (e.clientY - rect.top) * (H / rect.height);
    const nearest = findNearest(mx, my);
    if (nearest) {
      onReclassify(nearest.pitch);
    }
  }, [findNearest, onReclassify]);

  const p = hover?.pitch;

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <canvas
        ref={canvasRef}
        style={{ borderRadius: 6, cursor: onReclassify ? "pointer" : "default" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      />
      {hover && p && (() => {
        const result = getTooltipResult(p);
        const isBIP = !!p.events && p.launch_speed != null && p.launch_angle != null &&
          (p.description || "").toLowerCase() === "hit_into_play";
        const bbTag = isBIP ? classifyBattedBall(p.launch_speed, p.launch_angle) : null;
        const bbColor = bbTag ? (BATTED_BALL_COLORS[bbTag] || "rgba(180,184,210,0.7)") : null;

        return (
          <div className="pitch-tooltip" style={(() => {
            const tx = hover.x + 16;
            const ty = hover.y - 16;
            return {
              position: "fixed",
              left: tx + 300 > window.innerWidth ? hover.x - 310 : tx,
              top: ty < 10 ? hover.y + 16 : (ty + 280 > window.innerHeight ? hover.y - 280 : ty),
              transform: "none",
              minWidth: 280,
              zIndex: 1000,
              pointerEvents: "none",
            };
          })()}>
            {/* Header row 1: Pitch type + mph (left) | Result (right) */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: isBIP ? 0 : 4 }}>
              <div style={{ whiteSpace: "nowrap" }}>
                <span style={{ color: PITCH_COLORS[p.pitch_name] || "#ccc", fontWeight: 600 }}>
                  {p.pitch_name}
                </span>
                <span style={{ marginLeft: 6, color: "#e0e2ec" }}>
                  {p.release_speed ? p.release_speed.toFixed(1) + " mph" : ""}
                </span>
              </div>
              <div style={{ whiteSpace: "nowrap", color: result.color, fontWeight: 600, marginLeft: 12 }}>
                {result.label}
                {result.isK && (
                  result.isCalledStrikeThree
                    ? <span style={{ marginLeft: 3 }}>(<span style={{ display: "inline-block", transform: "scaleX(-1)" }}>K</span>)</span>
                    : <span style={{ marginLeft: 3 }}>(K)</span>
                )}
              </div>
            </div>
            {/* Header row 2 (BIP only): EV/LA (left) | Batted ball tag (right) */}
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

            {/* Sub-label row (e.g. "Swinging Strike") — right-aligned under result */}
            {result.isK && result.subLabel && (
              <div style={{ textAlign: "right", fontSize: "0.85em", color: "rgba(180,184,210,0.7)", marginBottom: 4 }}>
                {result.subLabel}
              </div>
            )}

            {/* Body: text left, strikezone right */}
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}>
                {/* vs Batter */}
                {(p.batter_name || p.batter) && (
                  <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                    vs {p.batter_name || p.batter}
                  </div>
                )}

                {/* Inning + bases */}
                {p.inning != null && p.inning_topbot && (
                  <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                    {p.inning_topbot === "Top" ? "Top" : "Bot"} {ordinal(p.inning)} | {basesString(p.on_1b, p.on_2b, p.on_3b)}
                  </div>
                )}

                {/* Outs + count */}
                {p.outs_when_up != null && p.balls != null && p.strikes != null && (
                  <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                    {p.outs_when_up} Outs | {p.balls}-{p.strikes}
                  </div>
                )}

                {/* iVB + iHB + Extension */}
                {p.pfx_z != null && p.pfx_x != null && (
                  <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                    iVB {p.pfx_z.toFixed(1)}" · iHB {(-p.pfx_x).toFixed(1)}"
                    {p.release_extension != null && ` · Ext ${p.release_extension.toFixed(1)}ft`}
                  </div>
                )}
              </div>

              {/* RIGHT: Mini Strikezone SVG, aligned to bottom */}
              {p.plate_x != null && p.plate_z != null && (
                <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-end", paddingTop: 0 }}>
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
                      const pitchColor = PITCH_COLORS[p.pitch_name] || "#D9D9D9";
                      return (
                        <circle cx={dotX} cy={dotY} r="4" fill={pitchColor} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8" />
                      );
                    })()}
                  </svg>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
