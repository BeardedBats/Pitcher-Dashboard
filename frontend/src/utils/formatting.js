import { THRESHOLDS, RESULT_COLORS, VELO_THRESHOLDS, IHB_THRESHOLDS } from "../constants";

export function getCellHighlight(key, value, pitchName) {
  if (value == null) return null;
  const thresholds = THRESHOLDS[key];
  if (!thresholds) return null;
  const t = thresholds[pitchName] || thresholds._all;
  if (!t) return null;
  const [eliteMin, poorMax] = t;
  if (value >= eliteMin) return "elite";
  if (value <= poorMax) return "poor";
  return null;
}

export function fmt(v, decimals = 1) {
  if (v == null || v === "" || isNaN(v)) return "--";
  return Number(v).toFixed(decimals);
}

export function fmtPct(v) {
  if (v == null || v === "" || isNaN(v)) return "--";
  const n = Math.round(Number(v));
  if (n === 0) return "-";
  return n + "%";
}

export function fmtInt(v) {
  if (v == null || v === "" || isNaN(v)) return "--";
  return Math.round(Number(v)).toString();
}

export function getResultColor(result) {
  if (!result) return "rgba(255,255,255,0.45)";
  const key = result.toLowerCase().replace(/ /g, "_");
  return RESULT_COLORS[key] || "rgba(255,255,255,0.45)";
}

export function getZoneLabel(zone) {
  if (zone >= 1 && zone <= 9) return `Zone ${zone}`;
  if (zone >= 11 && zone <= 14) return "Shadow";
  return "Outside";
}

export function getSprayDirection(hc_x, hc_y) {
  if (hc_x == null || hc_y == null) return "";
  // Baseball Savant coordinates: home plate ~125, center field ~125
  // x < 100 = left field side, x > 150 = right field side
  const cx = 125;
  const angle = Math.atan2(cx - hc_y, hc_x - cx) * (180 / Math.PI);
  if (angle < -30) return "to right field";
  if (angle < -10) return "to right-center";
  if (angle < 10) return "to center field";
  if (angle < 30) return "to left-center";
  return "to left field";
}

export function getVeloEmphasis(pitchName, velo) {
  if (!velo || !pitchName) return null;
  const t = VELO_THRESHOLDS[pitchName];
  if (!t) return null;
  if (velo >= t.red) return "elite";
  if (velo <= t.blue) return "poor";
  return null;
}

// Savant batted ball classification based on launch speed/angle
export function classifyBattedBall(launchSpeed, launchAngle) {
  if (launchSpeed == null || launchAngle == null) return null;
  const ev = launchSpeed, la = launchAngle;
  if (ev >= 98) {
    const laMin = Math.max(8, 26 - (ev - 98) * 1.5);
    const laMax = Math.min(50, 30 + (ev - 98) * 1.3);
    if (la >= laMin && la <= laMax) return "Barrel";
  }
  if (ev >= 95 && la >= 10 && la <= 50) return "Solid";
  if (la < 10) return "Poorly/Topped";
  if (ev >= 80 && la >= 10 && la <= 25) return "Flare/Burner";
  if (la > 50) return "Poorly/Under";
  if (la > 25 && ev < 80) return "Poorly/Under";
  if (ev < 80) return "Poorly/Weak";
  if (ev >= 95) return "Solid";
  return "Flare/Burner";
}

// Hard BIP vs Weak BIP from Savant tag + launch angle
export function getBIPQuality(tag, launchAngle) {
  if (!tag) return null;
  if (tag === "Barrel" || tag === "Solid") return "Hard BIP";
  if (tag === "Flare/Burner") return launchAngle < 11 ? "Hard BIP" : "Weak BIP";
  return "Weak BIP"; // Poorly/*
}

export function getIHBEmphasis(pitchName, ihb, hand) {
  // ihb is the DISPLAY value (already negated from pfx_x)
  if (ihb == null || !pitchName || !hand) return null;
  const t = IHB_THRESHOLDS[pitchName];
  if (!t) return null;
  const h = t[hand];
  if (!h) return null;

  if (pitchName === "Four-Seamer") {
    if (hand === "R") {
      // RHP FF: Red if >12" OR <4"
      return (ihb > h.red_above || ihb < h.red_below) ? "elite" : null;
    }
    if (hand === "L") {
      // LHP FF: Red if |iHB| >= 16, Blue if |iHB| <= 14
      if (ihb <= h.red) return "elite";   // more negative = more movement
      if (ihb >= h.blue) return "poor";   // less negative = less movement
    }
  }
  if (pitchName === "Sinker") {
    if (hand === "R") {
      if (ihb > h.red) return "elite";
      if (ihb < h.blue) return "poor";
    }
    if (hand === "L") {
      // LHP SI: Red if |iHB| >= 16, Blue if |iHB| <= 14
      if (ihb <= h.red) return "elite";   // more negative = more movement
      if (ihb >= h.blue) return "poor";   // less negative = less movement
    }
  }
  return null;
}
