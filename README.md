# VidForge Studio

A free, browser-based, AI-powered video editor. Everything — editing, rendering, and every AI model — runs **locally in your browser**. There are no paid APIs, no accounts, and no uploads. (The one exception is the optional AI Image generator, which sends your prompt to the free Pollinations service.)

## Getting started

**You need:** [Node.js](https://nodejs.org) 20.19 or newer (the LTS version is fine) and a desktop **Chrome or Edge** browser. Export needs WebCodecs, and WebGPU speeds up the AI.

### 1. Download
```bash
git clone https://github.com/as3601/vidforge.git
cd vidforge
```
No git? On the GitHub page click **Code → Download ZIP**, then unzip it.

### 2. Run
**Windows, easiest way:** double-click `Start VidForge.bat`. The first run installs dependencies, which takes a few minutes. Then it opens the app in your browser.

**Any OS, from a terminal:**
```bash
npm install        # first time only
npm run dev        # then open http://localhost:5190
```

To build a static version you can host anywhere: `npm run build` (output goes to `dist/`).

The AI models download the first time you use each feature, so the first use is slow and later uses are fast.

## Editing
- Multi-track timeline: unlimited video/overlay and audio tracks, drag to move between tracks, trim from either edge, snapping (playhead, clip edges, markers), zoom (Ctrl+wheel), markers, lock/hide/mute per track
- Split, ripple delete, duplicate, copy/paste, detach audio, freeze frame, undo/redo (100 steps)
- Direct manipulation on the preview: drag to move, corner handles to scale, top handle to rotate (Shift snaps to 15°), wheel to scale, snap-to-centre
- Keyframe animation for X, Y, scale, rotation, opacity and volume, with linear/ease/hold curves, plus motion presets (Ken Burns, pan, pop, spin, drop, pulse)
- 13 transitions: fade, slide ×4, zoom in/out, wipe ×2, iris circle, blur, spin, flash
- Colour: brightness, contrast, saturation, temperature, tint, hue, vignette, sharpen, blur, grayscale, sepia, invert, plus 10 one-click looks
- Effects: glitch, RGB split, VHS, camera shake, pixelate, mirror, kaleidoscope, film grain, posterize, sketch
- Chroma key (green/blue screen) with spill suppression; 17 blend modes; crop; flip; fit/fill/stretch
- Speed 0.1×–8× with pitch preserved in preview
- Text: 11 fonts, stroke, shadow, boxes, letter spacing, and 8 animations (fade, pop, slide, bounce, typewriter, word-by-word, karaoke). Includes title presets, caption styles, emoji stickers and colour solids
- Record your screen, webcam or microphone directly into the project
- Any aspect ratio: 16:9, 9:16, 1:1, 4:5, 4:3, 21:9, 4K; 24–60 fps
- Autosave to IndexedDB (media included); save/open project files

## AI (free and open-source, runs locally)
| Feature | Model / technique |
|---|---|
| Auto captions in ~99 languages, plus translate-to-English | OpenAI Whisper (tiny/base/small) via Transformers.js, WebGPU when available |
| Caption translation (200 languages) | Meta NLLB-200 |
| AI voiceover (28 voices) | Kokoro-82M TTS; MMS-TTS for Hindi/Spanish/French/German |
| Background removal / blur / replace | Google MediaPipe selfie segmentation |
| Auto-reframe to vertical (face/object tracking) | MediaPipe BlazeFace / EfficientDet |
| Silence removal (jump cuts) | RMS voice-activity analysis |
| Scene detection and auto-split | Colour-histogram shot-boundary detection |
| Beat detection, BPM, cut-to-beat | Onset/flux analysis |
| Auto colour-correct | Frame statistics (exposure, contrast, cast) |
| Describe frame / summarise transcript | ViT-GPT2 captioning / DistilBART |
| AI image / B-roll | Pollinations (free, no key) |

Models download once on first use and are cached by the browser.

## FFmpeg tools (WebAssembly)
Convert any format to MP4, reverse, stabilise, video denoise, AI audio denoise, loudness normalisation (−14 LUFS), voice enhance, voice changers (chipmunk/deep/robot), echo, extract audio, motion-interpolated slow motion, 60fps interpolation, black and white.

## Export
- MP4 (H.264 + AAC) through the hardware WebCodecs encoder, at up to 2× project resolution, 24–60 fps, with selectable quality and range
- Animated GIF (palette-optimised)
- WAV audio mixdown
- PNG frame snapshot

## Shortcuts
`Space` play/pause · `S` split (`Shift+S` all tracks) · `Del` delete · `Shift+Del` ripple delete · `Ctrl+D` duplicate · `Ctrl+C/V` copy/paste · `Ctrl+Z/Y` undo/redo · `M` marker · `←/→` frame step (`Shift` = 1s) · `J/K/L` back 5s / pause / forward 5s · `+/-` zoom · `Ctrl+S` save project

## Architecture
- `src/engine/compositor.ts` – Canvas2D renderer (transforms, keyframes, transitions, effects, chroma, text)
- `src/engine/player.ts` – real-time preview that keeps one media element per clip in sync with the master clock
- `src/engine/exporter.ts` – frame-accurate offline render to WebCodecs and the MP4 muxer; OfflineAudioContext mixdown
- `src/ai/` – MediaPipe vision, a Transformers.js worker (Whisper/Kokoro/NLLB), and signal analysis
- `src/lib/ffmpeg.ts` – ffmpeg.wasm tool presets
- `src/store.ts` – Zustand + Immer project state with undo history

## License
MIT. See [LICENSE](LICENSE).
