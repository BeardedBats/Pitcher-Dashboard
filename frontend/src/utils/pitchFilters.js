/**
 * Classify a pitch into a result category for filtering.
 * Each pitch gets ONE category based on description + events.
 *
 * Categories:
 *  HR, Single, Double, Triple, Hard BIP (ideal contact result),
 *  Whiff, Foul, Called Strike, Ball, HBP, Out, Weak BIP
 */
export function classifyPitchResult(pitch) {
  const desc = (pitch.description || "").toLowerCase();
  const ev = (pitch.events || "").toLowerCase();

  // Whiff: swinging_strike, swinging_strike_blocked, foul_tip
  if (desc === "swinging_strike" || desc === "swinging_strike_blocked" || desc === "foul_tip") {
    return "Whiff";
  }
  // Called Strike
  if (desc === "called_strike") return "Called Strike";
  // Ball
  if ((desc.includes("ball") && !desc.includes("in_play")) || desc === "pitchout") return "Ball";
  // Foul (not foul tip — already caught above)
  if (desc.includes("foul") && desc !== "foul_tip") return "Foul";
  // HBP
  if (desc === "hit_by_pitch" || ev === "hit_by_pitch") return "HBP";

  // In-play events: check ev field
  if (ev === "home_run") return "HR";
  if (ev === "single") return "Single";
  if (ev === "double") return "Double";
  if (ev === "triple") return "Triple";

  // Hard BIP: burner with EV>95, solid, or barrel
  if (ev && desc === "hit_into_play") {
    const ls = pitch.launch_speed;
    const la = pitch.launch_angle;
    if (ls != null && la != null) {
      const bbType = classifyBattedBallSimple(ls, la);
      if (bbType === "Barrel" || bbType === "Solid" || bbType === "Burner") return "Hard BIP";
    }
  }

  // Out (remaining in-play events)
  if (ev && (ev.includes("out") || ev.includes("play") || ev.includes("force")
    || ev.includes("sac") || ev === "fielders_choice" || ev === "fielders_choice_out"
    || ev === "field_error" || ev === "catcher_interf")) {
    return "Out";
  }

  // Fallback for hit_into_play without matching event
  if (desc === "hit_into_play") return "Out";

  return "Other";
}

/**
 * Classify batted ball type.
 * Flare/Burner split: LA >= 11° = Flare, LA < 11° = Burner
 * Flare + Poorly types = "Weak BIP"
 * Burner + Solid + Barrel = "Hard BIP"
 */
export function classifyBattedBallSimple(ev, la) {
  if (ev >= 98) {
    const laMin = Math.max(8, 26 - (ev - 98) * 1.5);
    const laMax = Math.min(50, 30 + (ev - 98) * 1.3);
    if (la >= laMin && la <= laMax) return "Barrel";
  }
  if (ev >= 95 && la >= 10 && la <= 50) return "Solid";
  if (ev >= 80 && la >= 10 && la <= 25) {
    // Split Flare/Burner: LA >= 11 = Flare, LA < 11 = Burner
    return la >= 11 ? "Flare" : "Burner";
  }
  if (ev >= 95) return "Solid";
  return "Other";
}

/**
 * Classify batted ball into Weak BIP or Hard BIP category.
 * Full classification using launch speed + launch angle.
 * Returns "Weak" for Flare + Poorly types, "Hard" for Burner + Solid + Barrel.
 */
export function classifyBIPQuality(launchSpeed, launchAngle) {
  if (launchSpeed == null || launchAngle == null) return null;
  const ev = launchSpeed, la = launchAngle;

  // Check Barrel first
  if (ev >= 98) {
    const laMin = Math.max(8, 26 - (ev - 98) * 1.5);
    const laMax = Math.min(50, 30 + (ev - 98) * 1.3);
    if (la >= laMin && la <= laMax) return "Hard"; // Barrel
  }
  // Solid
  if (ev >= 95 && la >= 10 && la <= 50) return "Hard";
  // Flare/Burner range
  if (ev >= 80 && la >= 10 && la <= 25) {
    return la >= 11 ? "Weak" : "Hard"; // Flare = Weak, Burner = Hard
  }
  // Remaining high EV = Solid
  if (ev >= 95) return "Hard";

  // Poorly types: Topped (la < 10), Under (la > 50 or la > 25 && ev < 80), Weak (ev < 80)
  return "Weak";
}

/**
 * Full batted ball classification for display.
 * Separates Flare (LA >= 11°) from Burner (LA < 11°).
 */
export function classifyBattedBallFull(launchSpeed, launchAngle) {
  if (launchSpeed == null || launchAngle == null) return null;
  const ev = launchSpeed, la = launchAngle;
  if (ev >= 98) {
    const laMin = Math.max(8, 26 - (ev - 98) * 1.5);
    const laMax = Math.min(50, 30 + (ev - 98) * 1.3);
    if (la >= laMin && la <= laMax) return "Barrel";
  }
  if (ev >= 95 && la >= 10 && la <= 50) return "Solid";
  if (la < 10) return "Poorly/Topped";
  if (ev >= 80 && la >= 10 && la <= 25) return la >= 11 ? "Flare" : "Burner";
  if (la > 50) return "Poorly/Under";
  if (la > 25 && ev < 80) return "Poorly/Under";
  if (ev < 80) return "Poorly/Weak";
  if (ev >= 95) return "Solid";
  return "Flare";
}

/**
 * Check if a pitch result is a "Weak BIP" for filter purposes.
 * Weak BIP = balls in play with Flare or Poorly batted ball type.
 */
export function isWeakBIP(pitch) {
  const desc = (pitch.description || "").toLowerCase();
  const ev = (pitch.events || "").toLowerCase();
  if (desc !== "hit_into_play" && !ev) return false;
  // Must be a ball in play
  if (!ev || ev === "hit_by_pitch") return false;
  const ls = pitch.launch_speed;
  const la = pitch.launch_angle;
  if (ls == null || la == null) return false;
  const quality = classifyBIPQuality(ls, la);
  return quality === "Weak";
}

export const RESULT_FILTER_OPTIONS = [
  "HR", "Single", "Double", "Triple", "Hard BIP",
  "Whiff", "Foul", "Called Strike", "Ball", "HBP", "Out", "Weak BIP",
];

const ALL_HITS = new Set(["HR", "Single", "Double", "Triple"]);
const CSW_ONLY = new Set(["Called Strike", "Whiff"]);
const ALL_BIP = new Set(["HR", "Single", "Double", "Triple", "Hard BIP", "Out", "Weak BIP"]);
const STRIKES_ONLY = new Set(["HR", "Single", "Double", "Triple", "Hard BIP", "Whiff", "Foul", "Called Strike", "Out", "Weak BIP"]);
const WEAK_BIP_ONLY = new Set(["Weak BIP"]);

export const RESULT_QUICK_ACTIONS = [
  {
    label: "All Hits",
    fn: (_cur, _all) => new Set(ALL_HITS),
  },
  {
    label: "CSW",
    fn: (_cur, _all) => new Set(CSW_ONLY),
  },
  {
    label: "All BIP",
    fn: (_cur, _all) => new Set(ALL_BIP),
  },
  {
    label: "Strikes",
    fn: (_cur, _all) => new Set(STRIKES_ONLY),
  },
];

/**
 * Normalize pitch description for display.
 * foul_tip → "Swinging Strike", swinging_strike_blocked → "Swinging Strike"
 */
export function normalizePitchDesc(desc) {
  if (!desc) return desc;
  const d = desc.toLowerCase();
  if (d === "foul_tip" || d === "swinging_strike_blocked") return "Swinging Strike";
  if (d === "swinging_strike") return "Swinging Strike";
  return desc;
}
