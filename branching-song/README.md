# Pick Your Path — branching song app

A web app where listeners choose how a song unfolds, section by section,
against a circular countdown. Built to deploy on Vercel as a static site.

## Files
- `public/index.html` — the page
- `public/config.js` — **the only file you edit**: songs, sections, prompts, audio switch
- `public/engine.js` — playback engine (tones + real WAV loading, preloading, countdown)

## Deploy to Vercel (one-time)
1. Put this folder in a GitHub repo (or reuse your existing flow).
2. In Vercel: New Project → import the repo.
3. Framework preset: **Other**. Root/output directory: `public`.
   (No build step — it's static.)
4. Deploy. You get a live URL. Open it in a real browser — audio works.

To redeploy after edits: `git add -A && git commit -m "update" && git push`

## Test now (placeholder tones)
`USE_REAL_AUDIO` in `config.js` is `false`, so you'll hear synth tones.
This confirms the flow, countdown, and seamless stitching before you make audio.

## Going live with real audio
1. Render your stems as WAV files.
2. Drop them in `public/audio/<songId>/` using this naming:
   - Intro (fixed):        `s0.wav`
   - Section 1, option 0:  `s1_0.wav`
   - Section 1, option 1:  `s1_1.wav`
   - …
   - Section N, option M:  `sN_M.wav`

   Example for song id `home` with 5 options per section:
   ```
   public/audio/home/s0.wav
   public/audio/home/s1_0.wav  s1_1.wav  s1_2.wav  s1_3.wav  s1_4.wav
   public/audio/home/s2_0.wav  …
   public/audio/home/s3_0.wav  …
   public/audio/home/s4_0.wav  …
   ```
   That's 1 + (4 sections × 5 options) = **21 files per song**.

3. Set `USE_REAL_AUDIO = true` in `config.js`.
4. Section length auto-detects from each WAV — no need to set durations.
5. Push. Done.

## Production notes for seamless joins
- Every variant of a given section must be the **same length** as its siblings
  (so the countdown and hand-off line up) — render them to the same bar count.
- Keep tempo and key consistent so any path sounds intentional.
- Bounce with a clean start/end on the bar; a tiny tail is fine, the engine
  hands off exactly at the file's end.
- WAVs can be large — consider ~16-bit/44.1k. If file size becomes a problem,
  swap to `.m4a`/AAC later (change the extension in engine.js `getSectionBuffer`).
