# Making videos (no external generator)

Ares makes video by rendering it: a three.js / canvas scene, the Forge studio, or an HTML page, captured frame by frame.

## Fast path: the Forge studio
`Browser action:"model"` with `record:{seconds, clip, orbit, turns, size, file}` captures the studio canvas (model, clips,
scripts: water, particles, a whole scene) to a .webm in the project. Turntable: orbit:true turns:1. Animation reel: clip +
orbit:false + a set camera (view camera/zoom). Vertical short: size [1080,1920].

## Any page or scene: record it yourself
1. Build the scene as a self-contained HTML page (three.js via an import map, or canvas 2D); drive everything from a single
   `t` (seconds) so any frame can be rendered exactly: `render(t)`.
2. Real-time capture (quick): in the page, `const rec = new MediaRecorder(canvas.captureStream(30), {mimeType:"video/webm;codecs=vp9", videoBitsPerSecond: 8e6})`,
   collect `ondataavailable`, stop after N s, then hand the Blob back (POST to a local server, or `Browser eval` returning
   base64 in chunks).
3. Frame-exact capture (best quality, any speed): a Node script with Playwright opens the page, and for each frame calls
   `window.render(i / fps)` then `page.screenshot({path: f"frames/%05d.png"})` (or `canvas.toDataURL`), then
   `ffmpeg -framerate 30 -i frames/%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 out.mp4` (H.264 MP4 plays everywhere).
   Add audio with `-i music.wav -shortest`. Check `ffmpeg -encoders` first; use libvpx-vp9 / webm if libx264 is missing.
4. Look at a few frames (`ffmpeg -i out.mp4 -vf fps=1,tile=4x2 -frames:v 1 sheet.png`) before saying it is done.

## Making it look directed, not generated
- Storyboard first: 4-8 shots with a purpose each (establish, reveal, detail, action, payoff). 2-4 s per shot.
- Camera: ease every move (ease in-out), keep the subject on thirds, slow push-ins for drama, orbit for products, cut on
  action. Never a static, centred, unlit frame.
- Light: key + rim + fill, a coloured rim to separate the subject, fog / gradient background for depth, bloom on emissives.
- Motion: anticipation, overshoot, settle (feel.md); stagger elements by 60-120 ms instead of moving them all at once.
- Type: titles animate in with the beat, hold long enough to read (3 words per second), consistent fonts.
- Sound: music bed + hits on cuts and impacts (WebAudio / a wav you synthesise); keep -14 LUFS-ish, never clip.
- Frame rates: 24 cinematic, 30 web, 60 game footage. Sizes: 1920x1080 landscape, 1080x1920 shorts/reels, 1080x1080 square.
