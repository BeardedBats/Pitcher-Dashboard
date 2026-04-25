export const PITCH_COLORS = {
  "Four-Seamer": "#FF839B",
  "Sinker": "#ffc277",
  "Cutter": "#C59C9C",
  "Slider": "#CE66FF",
  "Sweeper": "#FFAAF7",
  "Curveball": "#2A98FF",
  "Changeup": "#6DE95D",
  "Splitter": "#83D6FF",
  "Knuckleball": "#A0A0A0",
  "Eephus": "#A0A0A0",
  "Screwball": "#90C890",
  "Forkball": "#78E0AE",
};

export const PITCH_TYPE_FILTERS = [
  "Four-Seamer", "Sinker", "Cutter", "Slider", "Sweeper",
  "Curveball", "Changeup", "Splitter", "Knuckleball", "Unclassified",
];

export const THRESHOLDS = {
  ivb: { "Four-Seamer": [16, 12] },
  ext: { _all: [6.9, 5.8] },
};

export const GRADIENTS = {
  elite: "linear-gradient(180deg, #FF3838, #FF6C6C)",
  poor: "linear-gradient(180deg, rgba(77, 185, 251, 0.5), rgba(185, 228, 255, 0.5))",
};

export const PITCH_DATA_COLUMNS = [
  { key: "pitcher", label: "Pitcher", align: "left" },
  { key: "team", label: "Team", align: "left" },
  { key: "hand", label: "Hand", align: "left" },
  { key: "opponent", label: "Opp", align: "left" },
  { key: "pitch_name", label: "Type", align: "left" },
  { key: "count", label: "#", align: "right" },
  { key: "velo", label: "Velo", align: "right" },
  { key: "usage", label: "Usage", align: "right" },
  { key: "usage_vs_r", label: "Vs R", align: "right" },
  { key: "usage_vs_l", label: "Vs L", align: "right" },
  { key: "ext", label: "Ext", align: "right" },
  { key: "ivb", label: "IVB", align: "right" },
  { key: "ihb", label: "IHB", align: "right" },
  { key: "havaa", label: "HAVAA", align: "right" },
  { key: "strike_pct", label: "Strike%", align: "right" },
  { key: "cs_pct", label: "CS%", align: "right" },
  { key: "swstr_pct", label: "SwStr%", align: "right" },
  { key: "csw_pct", label: "CSW%", align: "right" },
];

export const CARD_PITCH_DATA_COLUMNS = [
  { key: "pitch_name", label: "Type", align: "left", dividerRight: true },
  { key: "count", label: "#", align: "right" },
  { key: "velo", label: "Velo", align: "right", dividerRight: true },
  { key: "usage", label: "Usage", align: "right" },
  { key: "usage_vs_r", label: "Vs R", align: "right" },
  { key: "usage_vs_l", label: "Vs L", align: "right", dividerRight: true },
  { key: "ext", label: "Ext", align: "right" },
  { key: "ivb", label: "IVB", align: "right" },
  { key: "ihb", label: "IHB", align: "right" },
  { key: "havaa", label: "HAVAA", align: "right", dividerRight: true },
  { key: "cs_pct", label: "CS%", align: "right" },
  { key: "swstr_pct", label: "SwStr%", align: "right" },
  { key: "csw_pct", label: "CSW%", align: "right" },
  { key: "strike_pct", label: "Strike%", align: "right" },
];

// Results tab columns: Type | # ||| Whiffs | CS | Fouls | CSW% | Strike% | Foul% ||| Zone% | O-Swing% ||| BBs | Ks ||| BIP | Hits | Outs | HRs ||| Weak% | Hard%
export const CARD_RESULTS_COLUMNS = [
  { key: "pitch_name", label: "Type", align: "left", dividerRight: true },
  { key: "count", label: "#", align: "right", dividerRight: true },
  { key: "whiffs", label: "Whiffs", align: "right" },
  { key: "cs", label: "CS", align: "right" },
  { key: "fouls", label: "Fouls", align: "right" },
  { key: "csw_pct", label: "CSW%", align: "right" },
  { key: "strike_pct", label: "Strike%", align: "right" },
  { key: "foul_pct", label: "Foul%", align: "right", dividerRight: true },
  { key: "zone_pct", label: "Zone%", align: "right" },
  { key: "o_swing_pct", label: "O-Swing%", align: "right", dividerRight: true },
  { key: "bbs", label: "BB", align: "right" },
  { key: "ks", label: "K", align: "right", dividerRight: true },
  { key: "hits", label: "Hits", align: "right" },
  { key: "hrs", label: "HRs", align: "right" },
  { key: "outs_bip", label: "Outs", align: "right" },
  { key: "bip", label: "BIP", align: "right", dividerRight: true },
  { key: "gb_pct", label: "GB%", align: "right" },
  { key: "fb_pct", label: "FB%", align: "right" },
  { key: "weak_pct", label: "Weak%", align: "right" },
  { key: "hard_pct", label: "Hard%", align: "right" },
];

// Usage tab columns: Type | # | PAR% | (vs LHB: 0-0% Early% Behind% 2-Str% PAR%) | (vs RHB: 0-0% Early% Behind% 2-Str% PAR%)
// "Early%" = 0-1, 1-0, 1-1; "Behind%" = 2-0, 2-1, 3-0, 3-1; "2-Str%" = 0-2, 1-2, 2-2, 3-2.
// Bucket columns show usage (% of pitches in that count that were this type, per batter hand).
// PAR% (combined) = Ks on this pitch / pitches of this type thrown in 2-strike counts.
// PAR% per hand = same formula restricted to that batter hand.
export const CARD_USAGE_COLUMNS = [
  { key: "pitch_name", label: "Type", align: "left" },
  { key: "count", label: "#", align: "right" },
  { key: "par_pct", label: "PAR%", align: "right", dividerRight: true },
  // vs LHB
  { key: "firstpitch_pct_l", label: "0-0%", align: "right", group: "lhb" },
  { key: "early_pct_l", label: "Early%", align: "right", group: "lhb" },
  { key: "behind_pct_l", label: "Behind%", align: "right", group: "lhb" },
  { key: "two_str_use_pct_l", label: "2-Str%", align: "right", group: "lhb" },
  { key: "par_pct_vs_l", label: "PAR%", align: "right", group: "lhb", dividerRight: true },
  // vs RHB
  { key: "firstpitch_pct_r", label: "0-0%", align: "right", group: "rhb" },
  { key: "early_pct_r", label: "Early%", align: "right", group: "rhb" },
  { key: "behind_pct_r", label: "Behind%", align: "right", group: "rhb" },
  { key: "two_str_use_pct_r", label: "2-Str%", align: "right", group: "rhb" },
  { key: "par_pct_vs_r", label: "PAR%", align: "right", group: "rhb" },
];

export const PITCHER_RESULTS_COLUMNS = [
  { key: "pitcher", label: "Pitcher", align: "left" },
  { key: "team", label: "Team", align: "left" },
  { key: "hand", label: "Hand", align: "left" },
  { key: "opponent", label: "Game", align: "left", dividerRight: true },
  { key: "ip", label: "IP", align: "right" },
  { key: "runs", label: "R", align: "right" },
  { key: "er", label: "ER", align: "right" },
  { key: "hits", label: "H", align: "right" },
  { key: "bbs", label: "BB", align: "right" },
  { key: "ks", label: "K", align: "right", dividerRight: true },
  { key: "whiffs", label: "Whfs", align: "right" },
  { key: "csw_pct", label: "CSW%", align: "right" },
  { key: "strike_pct", label: "STR%", align: "right" },
  { key: "par_pct", label: "PAR%", align: "right", tooltip: "Strikeouts / Two-Strike Pitches" },
  { key: "pitches", label: "#", align: "right" },
  { key: "hrs", label: "HR", align: "right", dividerRight: true },
  { key: "velo", label: "FB MPH", align: "right", headerAlign: "center", tooltip: "Avg velocity of most-thrown fastball (Four-Seamer or Sinker) with delta vs. season-to-date" },
  { key: "velo_ext", label: "Ext", align: "right", headerAlign: "center", tooltip: "Avg release extension (ft) on the FB MPH fastball, with delta vs. season-to-date" },
];

export const TEAM_FULL_NAMES = {
  // MLB Teams
  ARI: "Arizona Diamondbacks", AZ: "Arizona Diamondbacks",
  ATL: "Atlanta Braves", BAL: "Baltimore Orioles",
  BOS: "Boston Red Sox", CHC: "Chicago Cubs", CWS: "Chicago White Sox",
  CIN: "Cincinnati Reds", CLE: "Cleveland Guardians", COL: "Colorado Rockies",
  DET: "Detroit Tigers", HOU: "Houston Astros", KC: "Kansas City Royals",
  LAA: "Los Angeles Angels", LAD: "Los Angeles Dodgers", MIA: "Miami Marlins",
  MIL: "Milwaukee Brewers", MIN: "Minnesota Twins", NYM: "New York Mets",
  NYY: "New York Yankees", OAK: "Oakland Athletics", ATH: "Athletics",
  PHI: "Philadelphia Phillies",
  PIT: "Pittsburgh Pirates", SD: "San Diego Padres", SF: "San Francisco Giants",
  SEA: "Seattle Mariners", STL: "St. Louis Cardinals", TB: "Tampa Bay Rays",
  TEX: "Texas Rangers", TOR: "Toronto Blue Jays", WSH: "Washington Nationals",
  // WBC / International Teams
  USA: "United States", JPN: "Japan", DOM: "Dominican Republic",
  PUR: "Puerto Rico", KOR: "Korea", CUB: "Cuba", MEX: "Mexico",
  VEN: "Venezuela", NED: "Netherlands", TPE: "Chinese Taipei",
  ITA: "Italy", ISR: "Israel", GBR: "Great Britain", AUS: "Australia",
  PAN: "Panama", CZE: "Czech Republic", NCA: "Nicaragua", COL_WBC: "Colombia",
  CAN: "Canada", BRA: "Brazil", CHN: "China", NZL: "New Zealand",
  RSA: "South Africa", ARG: "Argentina", PAK: "Pakistan", IND: "India",
};

export const TEAMS_LIST = Object.entries(TEAM_FULL_NAMES)
  .map(([abbrev, name]) => ({ abbrev, name }))
  .filter((item, idx, arr) => arr.findIndex(t => t.name === item.name) === idx)
  .sort((a, b) => a.name.localeCompare(b.name));

// Display abbreviations — maps raw API abbreviations to preferred display form
export const TEAM_ABBREV_DISPLAY = {
  KC: "KCR", TB: "TBR", SD: "SDP", SF: "SFG", AZ: "ARI",
  CWS: "CHW",
};

export function displayAbbrev(abbr) {
  return TEAM_ABBREV_DISPLAY[abbr] || abbr;
}

// Statcast-tracked minor league team abbrev → MLB parent club abbrev (2026).
// Statcast covers Triple-A (IL + PCL) and the Single-A Florida State League
// (used as Statcast's testing ground). Keys MUST match what Savant returns
// in `home_team` / `away_team`. Verified against Savant's CSV on 2026-04-23.
// One deviation from common usage: `SL` for Salt Lake Bees (not `SLC`).
//
// `displayTeamAbbrev(abbr, "aaa")` always renders the parent abbrev for any
// minor-league row — even when both teams in a matchup map to the same parent.
// Backward-compat: AAA_AFFILIATION (the original AAA-only map) is exported as
// an alias of MILB_AFFILIATION since callers were already passing FSL abbrevs
// through after the all-MiLB scope change.
export const MILB_AFFILIATION = {
  // International League (IL — AAA)
  BUF: "TOR",  // Buffalo Bisons
  CLT: "CWS",  // Charlotte Knights → display CHW
  COL: "CLE",  // Columbus Clippers (collides with Colorado MLB code; safe because lookup is level-gated)
  DUR: "TB",   // Durham Bulls → display TBR
  GWN: "ATL",  // Gwinnett Stripers
  IND: "PIT",  // Indianapolis Indians
  IOW: "CHC",  // Iowa Cubs
  JAX: "MIA",  // Jacksonville Jumbo Shrimp
  LHV: "PHI",  // Lehigh Valley IronPigs
  LOU: "CIN",  // Louisville Bats
  MEM: "STL",  // Memphis Redbirds
  NAS: "MIL",  // Nashville Sounds
  NOR: "BAL",  // Norfolk Tides
  OMA: "KC",   // Omaha Storm Chasers → display KCR
  ROC: "WSH",  // Rochester Red Wings
  SWB: "NYY",  // Scranton/Wilkes-Barre RailRiders
  STP: "MIN",  // St. Paul Saints
  SYR: "NYM",  // Syracuse Mets
  TOL: "DET",  // Toledo Mud Hens
  WOR: "BOS",  // Worcester Red Sox

  // Pacific Coast League (PCL — AAA)
  ABQ: "COL",  // Albuquerque Isotopes
  ELP: "SD",   // El Paso Chihuahuas → display SDP
  LV:  "ATH",  // Las Vegas Aviators
  OKC: "LAD",  // Oklahoma City Comets
  RNO: "ARI",  // Reno Aces
  RR:  "TEX",  // Round Rock Express
  SAC: "SF",   // Sacramento River Cats → display SFG
  SL:  "LAA",  // Salt Lake Bees (Savant uses "SL", not "SLC")
  SUG: "HOU",  // Sugar Land Space Cowboys
  TAC: "SEA",  // Tacoma Rainiers

  // Florida State League (FSL — Single-A; Statcast testing ground)
  BRD: "PIT",  // Bradenton Marauders
  CLR: "PHI",  // Clearwater Threshers
  DAY: "CIN",  // Daytona Tortugas
  DUN: "TOR",  // Dunedin Blue Jays
  FTM: "MIN",  // Fort Myers Mighty Mussels
  JUP: "MIA",  // Jupiter Hammerheads
  LAK: "DET",  // Lakeland Flying Tigers
  PMB: "STL",  // Palm Beach Cardinals
  SLU: "NYM",  // St. Lucie Mets
  TPA: "NYY",  // Tampa Tarpons
};

// Backward-compat alias.
export const AAA_AFFILIATION = MILB_AFFILIATION;

// Resolves a team abbrev for display.
// - At level="aaa": map MiLB → parent MLB abbrev, then apply MLB display overrides.
//   Always returns the parent abbrev (even on intra-org matchups), per spec.
// - At level="mlb" (default): just apply MLB display overrides.
export function displayTeamAbbrev(abbr, level = "mlb") {
  if (!abbr) return abbr;
  if (level === "aaa") {
    const parent = MILB_AFFILIATION[abbr];
    if (parent) return displayAbbrev(parent);
    // Unmapped minor-league team — fall through to raw abbrev (better than
    // dropping the label).
  }
  return displayAbbrev(abbr);
}

export const RESULT_COLORS = {
  // Strikeouts — warm orange
  strikeout: "#ffc680", strikeout_double_play: "#ffc680",
  // Home run — soft red
  home_run: "#ffa3a3",
  // Walk / HBP — soft red (matches HR)
  walk: "#ffa3a3", hit_by_pitch: "#ffa3a3", intent_walk: "#ffa3a3",
  // Hits — soft red (matches HR)
  single: "#ffa3a3", double: "#ffa3a3", triple: "#ffa3a3",
  // Outs — bright mint green (Statcast snake_case keys)
  field_out: "#55e8ff", force_out: "#55e8ff",
  grounded_into_double_play: "#55e8ff", double_play: "#55e8ff",
  fielders_choice: "#55e8ff", fielders_choice_out: "#55e8ff",
  sac_fly: "#55e8ff", sac_bunt: "#55e8ff",
  field_error: "#55e8ff", triple_play: "#55e8ff",
  sac_fly_double_play: "#55e8ff",
  runner_out: "#55e8ff",
  catcher_interf: "#ffa3a3",
  // MLB Live API display-name keys (PBP uses these)
  catcher_interference: "#ffa3a3",
  groundout: "#55e8ff", flyout: "#55e8ff", lineout: "#55e8ff",
  pop_out: "#55e8ff",
  "fielder's_choice": "#55e8ff",
  grounded_into_dp: "#55e8ff",
};

// Colors for individual pitch descriptions (called strike, ball, foul, etc.)
export const PITCH_DESC_COLORS = {
  called_strike: "#ffc277",       // Amber
  swinging_strike: "#EF4444",     // Red
  swinging_strike_blocked: "#EF4444",
  ball: "#4ADE80",                // Green
  foul: "#ffc277",                // Yellow
  foul_tip: "#ffc277",
  foul_bunt: "#ffc277",
  missed_bunt: "#EF4444",
  hit_into_play: "#60A5FA",       // Blue
  hit_by_pitch: "#A78BFA",        // Purple
  pitchout: "#4ADE80",
};

// Strikezone result-mode color mapping
export function getSZResultColor(pitch) {
  const desc = (pitch.description || "").toLowerCase();
  const event = (pitch.events || "").toLowerCase();

  // Swinging strike (includes blocked and foul tip)
  if (desc.includes("swinging_strike") || desc === "foul_tip" || desc === "missed_bunt") return "#EF4444";
  // Called strike
  if (desc === "called_strike") return "#ffc277";
  // Foul (but not foul tip, already handled)
  if (desc.includes("foul") && desc !== "foul_tip") return "#ffc277";
  // Ball
  if (desc.includes("ball") && !desc.includes("in_play")) return "#4ADE80";
  // In-play events
  if (event) {
    if (event === "home_run") return "#ffc277";
    if (event === "triple") return "#FF6B6B";
    if (event === "single") return "#60A5FA";
    if (event === "double") return "#A78BFA";
    // In-play outs
    if (event.includes("out") || event.includes("play") || event.includes("force")
        || event.includes("sac") || event === "fielders_choice" || event === "fielders_choice_out") return "rgba(255,255,255,0.5)";
  }
  // HBP
  if (desc === "hit_by_pitch") return "#A78BFA";
  return "#888";
}

// Batted ball type colors for tooltips
export const BATTED_BALL_COLORS = {
  "Barrel": "#ffa3a3",
  "Solid": "#ffc277",
  "Burner": "#ffc277",
  "Flare": "#65ff9c",
  "Topped": "#65ff9c",
  "Under": "#65ff9c",
  "Poor": "#65ff9c",
};

// BIP quality colors
export const BIP_QUALITY_COLORS = {
  "Hard BIP": "#ffc277",
  "Weak BIP": "#65ff9c",
};

export const VELO_THRESHOLDS = {
  "Four-Seamer": { red: 96, blue: 92 },
  "Sinker": { red: 96, blue: 92 },
  "Slider": { red: 88, blue: 84 },
  "Curveball": { red: 82, blue: 77 },
  "Changeup": { red: 90, blue: 82 },
  "Cutter": { red: 90, blue: 87 },
};

export const IHB_THRESHOLDS = {
  "Four-Seamer": {
    R: { red_above: 12, red_below: 4 },
    L: { red: -16, blue: -14 },
  },
  "Sinker": {
    R: { red: 16.5, blue: 14 },
    L: { red: -16, blue: -14 },
  },
};

export const PITCH_RESULT_SHAPES = {
  called_strike: "circle-fill",
  ball: "circle-border",
  swinging_strike: "square",
  swinging_strike_blocked: "square",
  foul: "triangle",
  foul_tip: "triangle",
  foul_bunt: "triangle",
  missed_bunt: "square",
  hit_into_play: "star",
  hit_by_pitch: "diamond",
  pitchout: "circle-border",
};

// PLV Projection Offense tiers — determines opponent team color in schedule display.
// @ prefix = away matchup (at their park), no prefix = home matchup (they visit you).
// Updated from Google Sheet: https://docs.google.com/spreadsheets/d/11ZObUMWsSxIMMU7OQsH5K1UKrZB1eyJ0xWMfm_Cvpy0
// Check weekly on Tuesdays for changes.
const _OFFENSE_TIER_COLORS = {
  top: "#ff8282",
  solid: "#ffa04b",
  average: "#d3b3ab",
  weak: "#9ed1f5",
  poor: "#6de95d",
};
// home lookup (opponent comes to you) — key without @
const _OFFENSE_HOME = {
  ATL: "top", DET: "top", HOU: "top", LAD: "top", NYY: "top",
  MIL: "solid", PIT: "solid", SDP: "solid", SEA: "solid", STL: "solid", TEX: "solid", WSN: "solid",
  ARI: "average", BAL: "average", CHW: "average", KCR: "average", MIA: "average", NYM: "average", PHI: "average", TOR: "average",
  ATH: "weak", CHC: "weak", CIN: "weak", CLE: "weak", LAA: "weak", MIN: "weak",
  BOS: "poor", COL: "poor", SFG: "poor", TBR: "poor",
};
// away lookup (you go to them) — maps from opponent abbrev when is_away=true
const _OFFENSE_AWAY = {
  CIN: "top",
  ATH: "solid", BOS: "solid",
  COL: "average",
  SEA: "weak", STL: "weak",
  KCR: "poor", TEX: "poor",
};
/**
 * Get the color for an opponent team based on offense tier.
 * @param {string} teamAbbrev - Opponent team abbreviation
 * @param {boolean} isAway - True if the pitcher's team is away (at opponent's park)
 * @returns {string} CSS color string
 */
export function getOpponentTierColor(teamAbbrev, isAway) {
  const abbr = (teamAbbrev || "").replace(/^@/, "").toUpperCase();
  // Check away-specific override first, then fall back to home lookup
  const tier = isAway && _OFFENSE_AWAY[abbr]
    ? _OFFENSE_AWAY[abbr]
    : _OFFENSE_HOME[abbr] || "average";
  return _OFFENSE_TIER_COLORS[tier];
}
