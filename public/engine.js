/* ============================================================
   ENGINE — playback, scheduling, countdown, branching.
   Schedule-ahead model: the chosen next section is queued to
   start at the exact sample the current one ends. Seamless.
   You shouldn't need to edit this. Set things up in config.js.
   ============================================================ */

const CIRC = 628;          // 2*pi*r, r=100
const COMMIT_LEAD = 0.25;  // seconds before the boundary we must lock the next clip
const CROSSFADE = 0.012;   // seconds of overlap at each join to kill the pop

let ctx = null;

// runtime state
let currentSong = null;
let sectionIndex = 0;       // index of the section currently PLAYING
let chosenPath = [];
let sectionStartTime = 0;   // ctx time the current section started
let sectionEndTime = 0;     // ctx time the current section ends (= next section start)
let sectionDuration = SECTION_SECONDS;
let pendingChoice = null;   // {idx,label} the listener locked, not yet scheduled
let scheduled = false;      // has the NEXT section been scheduled already?
let rafId = null;
let currentNode = null;     // {src,gain} of the section now playing
let nextNode = null;        // {src,gain} of the scheduled next section

const bufferCache = {};

/* ---------- audio context ---------- */
function getCtx(){
  if(!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

/* ---------- placeholder tone generator (no fades, so the join is audible) ---------- */
function makeToneBuffer(freq){
  const c = getCtx(), sr = c.sampleRate, len = Math.floor(SECTION_SECONDS*sr);
  const buf = c.createBuffer(1, len, sr), data = buf.getChannelData(0);
  // tiny 5ms de-click ramp only — NOT a musical fade. Keeps the seam honest
  // while avoiding a hard speaker pop at the raw edges.
  const ramp = Math.floor(0.005*sr);
  for(let i=0;i<len;i++){
    const t=i/sr;
    let a = 0.2*(Math.sin(2*Math.PI*freq*t)+0.4*Math.sin(2*Math.PI*freq*1.5*t)+0.25*Math.sin(2*Math.PI*freq*2*t));
    if(i<ramp) a *= i/ramp;
    else if(i>len-ramp) a *= (len-i)/ramp;
    data[i]=a;
  }
  return buf;
}
function freqForChoice(base,sIdx,cIdx){ return base*Math.pow(2,(sIdx+cIdx*0.12)/12); }

/* ---------- real WAV loader (fetch + decode, cached) ---------- */
async function loadBuffer(url){
  if(bufferCache[url]) return bufferCache[url];
  const res = await fetch(url);
  if(!res.ok) throw new Error('Could not load '+url+' ('+res.status+')');
  const arr = await res.arrayBuffer();
  const buf = await getCtx().decodeAudioData(arr);
  bufferCache[url] = buf;
  return buf;
}

async function getSectionBuffer(songId, base, sIdx, cIdx){
  if(!USE_REAL_AUDIO){
    return (sIdx===0) ? makeToneBuffer(base) : makeToneBuffer(freqForChoice(base,sIdx,cIdx));
  }
  const url = (sIdx===0) ? `audio/${songId}/s0.wav` : `audio/${songId}/s${sIdx}_${cIdx}.wav`;
  return loadBuffer(url);
}

function preloadSection(songId, sIdx){
  if(!USE_REAL_AUDIO || sIdx>=SECTIONS.length) return;
  const sec = SECTIONS[sIdx];
  if(!sec) return;
  sec.options.forEach((_,cIdx)=>{ loadBuffer(`audio/${songId}/s${sIdx}_${cIdx}.wav`).catch(()=>{}); });
}

/* ---------- playback ---------- */
function playBuffer(buffer, when, crossfadeIn){
  const c = getCtx();
  const src = c.createBufferSource();
  const gain = c.createGain();
  src.buffer = buffer;
  src.connect(gain).connect(c.destination);
  if(crossfadeIn){
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + CROSSFADE);
  }
  src.start(when);
  return { src, gain };
}

async function startSong(song){
  const c = getCtx();
  await c.resume();

  currentSong = song;
  sectionIndex = 0;
  chosenPath = [song.title];
  pendingChoice = null;
  scheduled = false;

  document.getElementById('screen-start').classList.add('hidden');
  document.getElementById('screen-play').classList.remove('hidden');
  document.getElementById('restart').classList.add('hidden');
  document.getElementById('path-trace').textContent = chosenPath.join('  →  ');
  document.getElementById('now-playing').textContent = 'loading…';

  let introBuf;
  try { introBuf = await getSectionBuffer(song.id, song.base, 0, 0); }
  catch(e){ document.getElementById('now-playing').textContent = '⚠ '+e.message; return; }

  sectionDuration = introBuf.duration;
  sectionStartTime = c.currentTime + 0.1;
  sectionEndTime = sectionStartTime + sectionDuration;
  currentNode = playBuffer(introBuf, sectionStartTime, false);
  document.getElementById('now-playing').textContent = '♪ '+song.title+' — intro';

  preloadSection(song.id, 1);
  offerChoice();
  runSection();
}

function offerChoice(){
  const next = sectionIndex + 1;
  const box = document.getElementById('next-choices');
  if(next >= SECTIONS.length){
    box.innerHTML='';
    document.getElementById('prompt').textContent='Final section playing…';
    return;
  }
  const sec = SECTIONS[next];
  document.getElementById('prompt').textContent = sec.prompt;
  box.innerHTML='';
  sec.options.forEach((label,idx)=>{
    const b=document.createElement('button');
    b.className='choice'; b.textContent=label;
    b.onclick=()=>lockChoice(idx,label,box);
    box.appendChild(b);
  });
}

function lockChoice(idx,label,box){
  if(scheduled) return; // too late, next section already queued
  pendingChoice={idx,label};
  [...box.children].forEach((b,i)=>{ b.disabled=true; b.classList.add(i===idx?'picked':'locked'); });
}

/* Drives the ring AND schedules the next section ahead of the boundary. */
function runSection(){
  scheduled = false;
  document.getElementById('ring-cap').textContent =
    (sectionIndex+1 < SECTIONS.length) ? 'choose while it plays' : 'listen';

  function frame(){
    const now = getCtx().currentTime;
    const remain = Math.max(0, sectionEndTime - now);
    document.getElementById('ring').setAttribute('stroke-dashoffset', CIRC*(1-remain/sectionDuration));
    document.getElementById('ring-num').textContent = Math.ceil(remain);

    // Once we're within COMMIT_LEAD of the end, lock in & schedule the next clip.
    if(!scheduled && remain <= COMMIT_LEAD && sectionIndex+1 < SECTIONS.length){
      scheduleNext(); // fire-and-forget; sets `scheduled` immediately
    }

    if(remain <= 0.001){
      if(sectionIndex+1 >= SECTIONS.length){ finish(); return; }
      // boundary reached: the next clip is already scheduled to start exactly now.
      advanceState();
      runSection();
      return;
    }
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
}

// Schedule the chosen (or auto-picked) next section to start AT sectionEndTime.
let nextScheduledMeta = null;
async function scheduleNext(){
  scheduled = true; // set synchronously so we never double-schedule
  const next = sectionIndex + 1;
  const sec = SECTIONS[next];

  let choice = pendingChoice;
  if(!choice){
    const r = Math.floor(Math.random()*sec.options.length);
    choice = { idx:r, label:sec.options[r]+' (auto)' };
  }

  let buf;
  try { buf = await getSectionBuffer(currentSong.id, currentSong.base, next, choice.idx); }
  catch(e){ document.getElementById('now-playing').textContent='⚠ '+e.message; return; }

  // Start CROSSFADE early so the incoming clip overlaps the tail of the current one.
  const startAt = Math.max(sectionEndTime - CROSSFADE, getCtx().currentTime);
  const node = playBuffer(buf, startAt, true);

  // Fade the currently-playing section down across the overlap.
  if(currentNode && currentNode.gain){
    currentNode.gain.gain.setValueAtTime(1, startAt);
    currentNode.gain.gain.linearRampToValueAtTime(0, startAt + CROSSFADE);
  }
  nextNode = node;
  nextScheduledMeta = { choice, duration: buf.duration, startAt: sectionEndTime };
}

// Move runtime state forward to the section that just started playing.
function advanceState(){
  const m = nextScheduledMeta;
  sectionIndex += 1;
  pendingChoice = null;

  sectionStartTime = m.startAt;
  sectionDuration = m.duration;
  sectionEndTime = m.startAt + m.duration;

  chosenPath.push(m.choice.label);
  document.getElementById('path-trace').textContent = chosenPath.join('  →  ');
  document.getElementById('now-playing').textContent = '♪ now playing: '+m.choice.label.replace(' (auto)','');

  currentNode = nextNode;
  nextNode = null;
  nextScheduledMeta = null;
  preloadSection(currentSong.id, sectionIndex+1);
  offerChoice();
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

/* ---------- wire up start screen ---------- */
const list = document.getElementById('song-list');
SONGS.forEach(song=>{
  const b=document.createElement('button');
  b.className='choice'; b.textContent=song.title;
  b.onclick=()=>startSong(song);
  list.appendChild(b);
});
document.getElementById('restart').onclick=()=>location.reload();
