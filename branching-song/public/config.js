/* ============================================================
   CONFIG — this is the ONLY file you edit to set up your EP.
   ============================================================ */

// FLIP THIS to true once you've added real WAV files to /audio/.
// Leave false to hear placeholder tones (good for testing layout/flow).
const USE_REAL_AUDIO = false;

// How long each section lasts, in seconds. With real audio this is
// auto-detected from each WAV's duration, so it only matters for tones.
const SECTION_SECONDS = 8;

/* ------------------------------------------------------------
   SONGS
   - id:    folder name under /audio/  (e.g. /audio/home/)
   - title: shown on the pick-a-song screen
   - base:  placeholder tone pitch only (ignored when USE_REAL_AUDIO)
   ------------------------------------------------------------ */
const SONGS = [
  { id:'home',    title:'Home',        base:220 },
  { id:'leaving', title:'The Leaving', base:247 },
  { id:'water',   title:'Still Water', base:262 },
  { id:'fire',    title:'Slow Fire',   base:294 },
  { id:'light',   title:'First Light', base:330 },
];

/* ------------------------------------------------------------
   SECTIONS
   Index 0 = the fixed intro (no choice, just plays).
   Each later entry = a choice point with its prompt + options.

   IMPORTANT — file naming when USE_REAL_AUDIO is true:
   For song id "home", section index 1, option index 0 ("Regret"),
   the engine loads:   /audio/home/s1_0.wav
   Pattern:            /audio/<songId>/s<sectionIndex>_<optionIndex>.wav
   The fixed intro is: /audio/<songId>/s0.wav
   ------------------------------------------------------------ */
const SECTIONS = [
  null, // section 0 = intro, plays automatically
  { prompt:'What pulls at the verse?',     options:['Regret','Hope','Anger','Tenderness','Distance'] },
  { prompt:'How does the chorus open up?', options:['Soaring','Whispered','Defiant','Aching','Calm'] },
  { prompt:'Where does the bridge turn?',  options:['Release','Collapse','Return','Surrender','Resolve'] },
  { prompt:'How does it end?',             options:['Fade','Swell','Silence','Repeat','Break'] },
];
