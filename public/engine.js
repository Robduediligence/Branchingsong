/* ============================================================
   ENGINE v2 — DAW-style gapless playback.
   - AudioContext locked to 44100 so WAVs are never resampled
     (buffer.length stays sample-exact).
   - Each section's start is chained off the PREVIOUS section's
     start + its exact sample length. No per-clip rounding drift.
   - "Arm-ahead": when a section starts, the DEFAULT next clip is
     immediately scheduled to fire at the exact boundary. If the
     listener picks before the commit cutoff, we cancel the armed
     source and arm their choice instead. Something is always armed,
     so there is never a decode-on-demand gap.
   ============================================================ */

const CIRC = 628;          // 2*pi*r, r=100
const COMMIT_LEAD = 0.12;  // must (re)arm at least this many seconds before the boundary

let ctx = null;

/* ---------- runtime state ---------- */
let currentSong   = null;
let sectionIndex  = 0;      // section currently PLAYING
let chosenPath    = [];
let sectionStart  = 0;      // ctx-time the current section started
let sectionEnd    = 0;      // ctx-time it ends (= next section's exact start)
let sectionDur    = 1;      // current section duration (seconds), from samples
let rafId         = null;

let armed         = null;   // { src, gain, choiceIdx, label, duration } scheduled for the boundary
let committed     = false;  // true once we're inside COMMIT_LEAD (armed clip is locked in)

const bufferCache = {};

/* ---------- audio context (locked sample rate) ---------- */
function getCtx(){
  if(!ctx){
    try { ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 }); }
    catch(e){ ctx = new (window.AudioContext || window.webkitAudioContext)(); }
  }
  return ctx;
}

/* ---------- placeholder tone (only used when USE_REAL_AUDIO is false) ---------- */
function makeToneBuffer(freq){
  const c = getCtx(), sr = c.sampleRate, len = Math.floor(SECTION_SECONDS*sr);
  const buf = c.createBuffer(1, len, sr), data = buf.getChannelData(0);
  const ramp = Math.floor(0.005*sr);
  for(let i=0;i<len;i++){
    const t=i/sr;
    let a = 0.2*(Math.sin(2*Math.PI*freq*t)+0.4*Math.sin(2*Math.PI*freq*1.5*t)+0.25*Math.sin(2*Math.PI*freq*2*t));
    if(i<ramp) a*=i/ramp; else if(i>len-ramp) a*=(len-i)/ramp;
    data[i]=a;
  }
  return buf;
}
function freqForChoice(base,sIdx,cIdx){ return base*Math.pow(2,(sIdx+cIdx*0.12)/12); }

/* ---------- loading ---------- */
async function loadBuffer(url){
  if(bufferCache[url]) return bufferCache[url];
  const res = await fetch(url);
  if(!res.ok) throw new Error('Could not load '+url+' ('+res.status+')');
  const arr = await res.arrayBuffer();
  const buf = await getCtx().decodeAudioData(arr);
  bufferCache[url] = buf;
  return buf;
}
function urlFor(songId, sIdx, cIdx){
  return (sIdx===0) ? `audio/${songId}/s0.wav` : `audio/${songId}/s${sIdx}_${cIdx}.wav`;
}
async function getBuffer(songId, base, sIdx, cIdx){
  if(!USE_REAL_AUDIO){
    return (sIdx===0) ? makeToneBuffer(base) : makeToneBuffer(freqForChoice(base,sIdx,cIdx));
  }
  return loadBuffer(urlFor(songId, sIdx, cIdx));
}
// Decode ALL options for a section and wait — so arming is instant later.
async function preloadAwait(songId, sIdx){
  if(!USE_REAL_AUDIO || sIdx<=0 || sIdx>=SECTIONS.length) return;
  const sec = SECTIONS[sIdx]; if(!sec) return;
  await Promise.all(sec.options.map((_,c)=> loadBuffer(urlFor(songId,sIdx,c)).catch(()=>{}) ));
}

/* ---------- scheduling primitive ---------- */
// Schedule a buffer to begin exactly at ctx-time `when`. Returns the node.
function schedule(buffer, when){
  const c = getCtx();
  const src = c.createBufferSource();
  const gain = c.createGain();
  src.buffer = buffer;
  src.connect(gain).connect(c.destination);
  src.start(when);              // sample-accurate against the audio clock
  return { src, gain };
}

/* ---------- arming the next section ---------- */
// Arm `choiceIdx` to fire at the boundary. Cancels any previously-armed clip.
async function armNext(choiceIdx, label){
  const next = sectionIndex + 1;
  if(next >= SECTIONS.length) return;

  let buf;
  try { buf = await getBuffer(currentSong.id, currentSong.base, next, choiceIdx); }
  catch(e){ document.getElementById('now-playing').textContent='⚠ '+e.message; return; }

  // Cancel a previously armed source (listener changed their mind in time).
  if(armed && armed.src){ try { armed.src.stop(); } catch(_){} }

  // Pin start to the EXACT boundary. Boundary is derived in samples elsewhere.
  const node = schedule(buf, sectionEnd);
  armed = { ...node, choiceIdx, label, duration: buf.length / getCtx().sampleRate };
}

/* ---------- the per-section loop ---------- */
async function playSection(buffer, choiceLabel){
  const c = getCtx();
  // start time: chained off previous boundary (sample-exact) or now for the intro
  sectionStart = (sectionEnd > c.currentTime) ? sectionEnd : c.currentTime + 0.08;
  sectionDur   = buffer.length / c.sampleRate;       // EXACT, from samples
  sectionEnd   = sectionStart + sectionDur;

  schedule(buffer, sectionStart);

  if(choiceLabel){
    chosenPath.push(choiceLabel);
    document.getElementById('path-trace').textContent = chosenPath.join('  →  ');
    document.getElementById('now-playing').textContent = '♪ '+choiceLabel.replace(' (auto)','');
  }

  committed = false;
  armed = null;

  // Decode the next section's options, then arm the DEFAULT immediately.
  await preloadAwait(currentSong.id, sectionIndex+1);
  if(sectionIndex+1 < SECTIONS.length){
    await armNext(0, SECTIONS[sectionIndex+1].options[0] + ' (auto)');
  }

  offerChoice();
  runCountdown();
}

function offerChoice(){
  const next = sectionIndex + 1;
  const box = document.getElementById('next-choices');
  if(next >= SECTIONS.length){
    box.innerHTML=''; document.getElementById('prompt').textContent='Final section playing…'; return;
  }
  const sec = SECTIONS[next];
  document.getElementById('prompt').textContent = sec.prompt;
  box.innerHTML='';
  sec.options.forEach((label,idx)=>{
    const b=document.createElement('button');
    b.className='choice'; b.textContent=label;
    b.onclick=()=>pick(idx,label,box);
    box.appendChild(b);
  });
}

// Listener picks: re-arm with their choice if we haven't committed yet.
function pick(idx,label,box){
  if(committed) return;            // too close to the boundary; armed default will play
  [...box.children].forEach((b,i)=>{ b.disabled=true; b.classList.add(i===idx?'picked':'locked'); });
  armNext(idx, label);
}

function runCountdown(){
  document.getElementById('ring-cap').textContent =
    (sectionIndex+1 < SECTIONS.length) ? 'choose while it plays' : 'listen';
  function frame(){
    const now = getCtx().currentTime;
    const remain = Math.max(0, sectionEnd - now);
    document.getElementById('ring').setAttribute('stroke-dashoffset', CIRC*(1-remain/sectionDur));
    document.getElementById('ring-num').textContent = Math.ceil(remain);

    if(!committed && remain <= COMMIT_LEAD) committed = true; // lock the armed clip

    if(remain <= 0.001){
      if(sectionIndex+1 >= SECTIONS.length){ finish(); return; }
      // boundary: the armed source is already sounding. Adopt it as current.
      const a = armed;
      sectionIndex += 1;
      // its start was sectionEnd; recompute our timeline anchors from it
      sectionStart = sectionEnd;
      sectionDur   = a.duration;
      sectionEnd   = sectionStart + sectionDur;
      armed = null;

      chosenPath.push(a.label);
      document.getElementById('path-trace').textContent = chosenPath.join('  →  ');
      document.getElementById('now-playing').textContent = '♪ '+a.label.replace(' (auto)','');

      // prep the section AFTER this one
      continueAfterBoundary();
      return;
    }
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
}

// After a boundary is crossed: decode next options and arm the new default.
async function continueAfterBoundary(){
  committed = false;
  armed = null;
  await preloadAwait(currentSong.id, sectionIndex+1);
  if(sectionIndex+1 < SECTIONS.length){
    await armNext(0, SECTIONS[sectionIndex+1].options[0] + ' (auto)');
  }
  offerChoice();
  runCountdown();
}

async function startSong(song){
  const c = getCtx();
  await c.resume();

  currentSong = song;
  sectionIndex = 0;
  chosenPath = [song.title];
  armed = null; committed = false;
  sectionEnd = 0;

  document.getElementById('screen-start').classList.add('hidden');
  document.getElementById('screen-play').classList.remove('hidden');
  document.getElementById('restart').classList.add('hidden');
  document.getElementById('path-trace').textContent = chosenPath.join('  →  ');
  document.getElementById('now-playing').textContent = 'loading…';

  let intro;
  try {
    intro = await getBuffer(song.id, song.base, 0, 0);
    await preloadAwait(song.id, 1);   // section 1 ready before we start
  } catch(e){ document.getElementById('now-playing').textContent = '⚠ '+e.message; return; }

  document.getElementById('now-playing').textContent = '♪ '+song.title+' — intro';
  await playSection(intro, null);
}

function finish(){
  cancelAnimationFrame(rafId);
  document.getElementById('prompt').textContent='Your version is complete.';
  document.getElementById('next-choices').innerHTML='';
  document.getElementById('now-playing').textContent='';
  document.getElementById('ring-cap').textContent='done';
  document.getElementById('ring-num').textContent='✓';
  document.getElementById('ring').setAttribute('stroke-dashoffset',0);
  document.getElementById('restart').classList.remove('hidden');
}

/* ---------- start screen ---------- */
const list = document.getElementById('song-list');
SONGS.forEach(song=>{
  const b=document.createElement('button');
  b.className='choice'; b.textContent=song.title;
  b.onclick=()=>startSong(song);
  list.appendChild(b);
});
document.getElementById('restart').onclick=()=>location.reload();
