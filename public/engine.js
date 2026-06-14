/* ============================================================
   ENGINE — playback, scheduling, countdown, branching.
   You shouldn't need to edit this. Set things up in config.js.
   ============================================================ */

const CIRC = 628; // 2*pi*r, r=100
let ctx = null;

// runtime state
let currentSong = null;
let sectionIndex = 0;
let chosenPath = [];
let sectionEndTime = 0;
let sectionDuration = SECTION_SECONDS;
let pendingChoice = null;
let rafId = null;

// cache of decoded AudioBuffers, keyed by url
const bufferCache = {};

/* ---------- audio context ---------- */
function getCtx(){
  if(!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

/* ---------- placeholder tone generator ---------- */
function makeToneBuffer(freq){
  const c = getCtx(), sr = c.sampleRate, len = Math.floor(SECTION_SECONDS*sr);
  const buf = c.createBuffer(1, len, sr), data = buf.getChannelData(0);
  for(let i=0;i<len;i++){
    const t=i/sr;
    const env=Math.min(t*4,1)*Math.min((SECTION_SECONDS-t)*4,1);
    data[i]=env*0.2*(Math.sin(2*Math.PI*freq*t)+0.4*Math.sin(2*Math.PI*freq*1.5*t)+0.25*Math.sin(2*Math.PI*freq*2*t));
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

// Resolve the AudioBuffer for a given section/choice, tone OR wav.
async function getSectionBuffer(songId, base, sIdx, cIdx){
  if(!USE_REAL_AUDIO){
    return (sIdx===0) ? makeToneBuffer(base) : makeToneBuffer(freqForChoice(base,sIdx,cIdx));
  }
  const url = (sIdx===0)
    ? `audio/${songId}/s0.wav`
    : `audio/${songId}/s${sIdx}_${cIdx}.wav`;
  return loadBuffer(url);
}

// Preload all option WAVs for an upcoming section (so the swap is instant).
function preloadSection(songId, sIdx){
  if(!USE_REAL_AUDIO || sIdx>=SECTIONS.length) return;
  const sec = SECTIONS[sIdx];
  if(!sec) return;
  sec.options.forEach((_,cIdx)=>{
    loadBuffer(`audio/${songId}/s${sIdx}_${cIdx}.wav`).catch(()=>{});
  });
}

/* ---------- playback ---------- */
function playBuffer(buffer, when){
  const c = getCtx();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(c.destination);
  src.start(when);
  return src;
}

async function startSong(song){
  const c = getCtx();
  await c.resume();

  currentSong = song;
  sectionIndex = 0;
  chosenPath = [song.title];
  pendingChoice = null;

  document.getElementById('screen-start').classList.add('hidden');
  document.getElementById('screen-play').classList.remove('hidden');
  document.getElementById('restart').classList.add('hidden');
  document.getElementById('path-trace').textContent = chosenPath.join('  →  ');
  document.getElementById('now-playing').textContent = 'loading…';

  // load + play the intro
  let introBuf;
  try { introBuf = await getSectionBuffer(song.id, song.base, 0, 0); }
  catch(e){ document.getElementById('now-playing').textContent = '⚠ '+e.message; return; }

  sectionDuration = introBuf.duration;
  const start = c.currentTime + 0.1;
  playBuffer(introBuf, start);
  sectionEndTime = start + sectionDuration;
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
  pendingChoice={idx,label};
  [...box.children].forEach((b,i)=>{ b.disabled=true; b.classList.add(i===idx?'picked':'locked'); });
}

function runSection(){
  document.getElementById('ring-cap').textContent =
    (sectionIndex+1 < SECTIONS.length) ? 'choose while it plays' : 'listen';
  function frame(){
    const remain = Math.max(0, sectionEndTime - getCtx().currentTime);
    document.getElementById('ring').setAttribute('stroke-dashoffset', CIRC*(1-remain/sectionDuration));
    document.getElementById('ring-num').textContent = Math.ceil(remain);
    if(remain <= 0.001){ commitSection(); return; }
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
}

async function commitSection(){
  const next = sectionIndex + 1;
  if(next >= SECTIONS.length){ finish(); return; }

  const sec = SECTIONS[next];
  let choice = pendingChoice;
  if(!choice){
    const r = Math.floor(Math.random()*sec.options.length);
    choice = { idx:r, label:sec.options[r]+' (auto)' };
  }
  sectionIndex = next;
  pendingChoice = null;

  let buf;
  try { buf = await getSectionBuffer(currentSong.id, currentSong.base, sectionIndex, choice.idx); }
  catch(e){ document.getElementById('now-playing').textContent='⚠ '+e.message; return; }

  sectionDuration = buf.duration;
  const start = getCtx().currentTime;
  playBuffer(buf, start);
  sectionEndTime = start + sectionDuration;

  chosenPath.push(choice.label);
  document.getElementById('path-trace').textContent = chosenPath.join('  →  ');
  document.getElementById('now-playing').textContent = '♪ now playing: '+choice.label.replace(' (auto)','');

  preloadSection(currentSong.id, sectionIndex+1);
  offerChoice();
  runSection();
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
