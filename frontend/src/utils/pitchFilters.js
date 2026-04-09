/**
 * Classify a pitch into a result category for filtering.
 * Each pitch gets ONE category based on description + events.
 *
 * Categories:
 *  HR, Single, Double, Triple, Strikeout, Walk,
 *  Whiff, Foul, Called Strike, Ball, HBP, Out
 *
 * Overlay categories (checked separately):
 *  Run(s) — any PA-ending pitch where runs scored
 */
export function classifyPitchResult(pitch) {
  const desc = (pitch.description || "").toLowerCase();
  const ev = (pitch.events || "").toLowerCase();

  // Whiff: swinging_strike, swinging_strike_blocked, foul_tip, missed_bunt
  if (desc === "swinging_strike" || desc === "swinging_strike_blocked" || desc === "foul_tip" || desc === "missed_bunt") {
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

  // PA-ending events
  if (ev === "strikeout" || ev === "strikeout_double_play") return "Strikeout";
  if (ev === "walk" || ev === "intent_walk") return "Walk";
  if (ev === "home_run") return "HR";
  if (ev === "single") return "Single";
  if (ev === "double") return "Double";
  if (ev === "triple") return "Triple";

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
 * Check if a pitch is the last pitch of a PA where runs scored.
 * Uses the `des` field (play description) which contains "scores" when runs cross the plate,
 * plus home_run events (always score at least 1 run).
 */
export function isRunScored(pitch) {
  const ev = (pitch.events || "").toLowerCase();
  if (ev === "home_run") return true;
  const des = (pitch.des || "").toLowerCase();
  if (des && des.includes("scores")) return true;
  return false;
}

/**
 * Check if a pitch is the last pitch of a strikeout PA.
 */
export function isStrikeoutPitch(pitch) {
  const ev = (pitch.events || "").toLowerCase();
  return ev === "strikeout" || ev === "strikeout_double_play";
}

/**
 * Classify batted ball into Weak BIP or Hard BIP category.
 * Full classification using launch speed + launch angle.
 * Hard = Barrel, Solid, Burner (EV >= 93, LA < 10).
 * Weak = Flare, Topped, Under, Poor.
 */
export function classifyBIPQuality(launchSpeed, launchAngle) {
  if (launchSpeed == null || launchAngle == null) return null;
  const tag = classifyBattedBallFull(launchSpeed, launchAngle);
  if (tag === "Barrel" || tag === "Solid" || tag === "Burner") return "Hard";
  return "Weak";
}

/**
 * Full batted ball classification for display.
 * Burner: EV >= 93, LA < 10°. Flare: EV >= 80, LA 10-25°.
 */
export function classifyBattedBallFull(launchSpeed, launchAngle) {
  if (launchSpeed == null || launchAngle == null) return null;
  const ev = launchSpeed, la = launchAngle;
  if (ev >= 98) {
    const laMin = Math.max(8, 26 - (ev - 98) * 1.5);
    const laMax = Math.min(50, 30 + (ev - 98) * 1.3);
    if (la >= laMin && la <= laMax) return "Barrel";
  }
  if (ev >= 90 && la >= 10 && la <= 50) return "Solid";
  if (ev >= 93 && la < 10) return "Burner";
  if (ev >= 80 && la >= 10 && la <= 25) return "Flare";
  if (la < 10) return "Topped";
  if (la > 50) return "Under";
  if (la > 25 && ev < 80) return "Under";
  if (ev < 80) return "Poor";
  if (ev >= 90) return "Solid";
  return "Flare";
}

/**
 * Check if a pitch is a ball in play (for Contact filter).
 */
export function isBallInPlay(pitch) {
  const desc = (pitch.description || "").toLowerCase();
  const ev = (pitch.events || "").toLowerCase();
  return desc === "hit_into_play" && ev && ev !== "hit_by_pitch";
}

export const RESULT_FILTER_OPTIONS = [
  "HR", "Single", "Double", "Triple", "Strikeout", "Walk",
  "Whiff", "Foul", "Called Strike", "Ball", "HBP", "Out", "Run(s)",
];

const ALL_HITS = new Set(["HR", "Single", "Double", "Triple"]);
const CSW_ONLY = new Set(["Called Strike", "Whiff"]);
const ALL_BIP = new Set(["HR", "Single", "Double", "Triple", "Out"]);
const STRIKES_ONLY = new Set(["HR", "Single", "Double", "Triple", "Strikeout", "Whiff", "Foul", "Called Strike", "Out"]);

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
 * Get tooltip result label + color for any pitch.
 * PA-ending pitches show the event result; mid-AB pitches show the pitch description.
 * Returns { label, color, isK, isCalledStrikeThree, subLabel }.
 *
 * Works with both Statcast pitches (description/events fields)
 * and PBP pitches (desc field + optional paResult).
 *
 * For PBP pitches, pass { desc, paResult, isLastPitch } in opts.
 */
export function getTooltipResult(pitch, opts) {
  // Normalize: support both Statcast and PBP pitch formats
  let desc, ev;
  if (opts?.desc != null) {
    // PBP format: desc is human-readable like "Called Strike"
    desc = (opts.desc || "").toLowerCase().replace(/\s+/g, "_");
    ev = opts.isLastPitch ? (opts.paResult || "").toLowerCase().replace(/\s+/g, "_") : "";
  } else {
    desc = (pitch.description || "").toLowerCase();
    ev = (pitch.events || "").toLowerCase();
  }

  // PA-ending events take priority
  if (ev) {
    if (ev === "strikeout" || ev === "strikeout_double_play") {
      const isCalledStrikeThree = desc === "called_strike";
      const subLabel = isCalledStrikeThree ? "Called Strike" : "Swinging Strike";
      return { label: "Strikeout", color: "#65FF9C", isK: true, isCalledStrikeThree, subLabel };
    }
    if (ev === "walk" || ev === "intent_walk") return { label: "Walk", color: "#FFAB6E" };
    if (ev === "hit_by_pitch") return { label: "HBP", color: "#FFAB6E" };
    if (ev === "home_run") return { label: "Home Run", color: "#FF5EDC" };
    if (ev === "single") return { label: "Single", color: "#feffa3" };
    if (ev === "double") return { label: "Double", color: "#feffa3" };
    if (ev === "triple") return { label: "Triple", color: "#feffa3" };
    if (ev === "sac_fly" || ev === "sac_fly_double_play") return { label: "Sac Fly", color: "#AAB9FF" };
    if (ev === "sac_bunt") return { label: "Sac Bunt", color: "#AAB9FF" };
    if (ev === "field_error") {
      // Trajectory-based out label in blue, "(Error)" suffix in single yellow
      const la = pitch.launch_angle != null ? pitch.launch_angle : (opts?.launchAngle ?? null);
      let outType = null;
      if (la != null) {
        if (la < 10) outType = "Groundout";
        else if (la <= 25) outType = "Lineout";
        else if (la <= 50) outType = "Flyout";
        else outType = "Popout";
      }
      const label = outType ? `${outType} (Error)` : "Error";
      return { label, color: "#65BAFF", isError: true, errorOutType: outType };
    }
    if (ev === "catcher_interf") return { label: "Catcher Int.", color: "#FFAB6E" };
    // Outs with trajectory-based labels (includes fielder's choice, force outs, double plays)
    if (ev.includes("out") || ev.includes("play") || ev.includes("force") || ev === "fielders_choice") {
      const la = pitch.launch_angle != null ? pitch.launch_angle : (opts?.launchAngle ?? null);
      let label = "Out";
      if (la != null) {
        if (la < 10) label = "Groundout";
        else if (la <= 25) label = "Lineout";
        else if (la <= 50) label = "Flyout";
        else label = "Popout";
      }
      const isDp = ev.includes("double_play") || ev === "grounded_into_double_play";
      if (isDp) label += " Into Double Play";
      return { label, color: "#65BAFF" };
    }

    return { label: ev.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()), color: "#ccc" };
  }

  // Non-PA pitches — show pitch description
  if (desc === "called_strike") return { label: "Called Strike", color: "#65FF9C" };
  if (desc === "swinging_strike" || desc === "swinging_strike_blocked" || desc === "foul_tip" || desc === "missed_bunt")
    return { label: "Whiff", color: "#65FF9C" };
  if (desc.includes("ball") && !desc.includes("in_play")) return { label: "Ball", color: "#FFAB6E" };
  if (desc === "pitchout") return { label: "Ball", color: "#FFAB6E" };
  if (desc.includes("foul")) return { label: "Foul", color: "#AAB9FF" };
  if (desc === "hit_by_pitch") return { label: "HBP", color: "#FFAB6E" };

  return { label: desc.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()), color: "#ccc" };
}
