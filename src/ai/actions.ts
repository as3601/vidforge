import { useStore, makeClip, defaultText, runJob, overlaps } from '../store';
import type { Clip, TextStyle } from '../types';
import { createAsset, decodeMono, encodeWav, uid } from '../lib/media';
import { transcribe, synthesize, translateTexts, summarize, captionImage } from './client';
import { findSpeechRanges, detectScenes, detectBeats, autoEnhance, trackSubject, frameGrabber } from './analysis';
import { runFFmpeg, type FFTool } from '../lib/ffmpeg';
import { snapshotPng } from '../engine/exporter';

const S = () => useStore.getState();
const clipById = (id: string) => S().project.clips.find((c) => c.id === id);
const assetOf = (c: Clip) => (c.assetId ? S().assets[c.assetId] : undefined);

export const CAPTION_STYLES: Record<string, { label: string; style: Partial<TextStyle> }> = {
  pop: { label: 'Bold Pop', style: { font: 'Montserrat', bold: true, uppercase: true, strokeWidth: 6, strokeColor: '#000000', shadow: 0, animation: 'pop', color: '#ffffff' } },
  karaoke: { label: 'Karaoke', style: { font: 'Poppins', bold: true, strokeWidth: 5, strokeColor: '#000000', animation: 'karaoke', highlightColor: '#ffd400', shadow: 8 } },
  boxed: { label: 'Boxed', style: { font: 'Inter', bold: true, background: 'rgba(0,0,0,0.7)', strokeWidth: 0, shadow: 0, animation: 'fade' } },
  word: { label: 'Word by word', style: { font: 'Anton', bold: false, uppercase: true, strokeWidth: 4, strokeColor: '#000000', animation: 'wordByWord', color: '#ffffff' } },
  neon: { label: 'Neon', style: { font: 'Poppins', bold: true, color: '#7df9ff', shadow: 24, shadowColor: '#00e5ff', strokeWidth: 0, animation: 'fade' } },
  minimal: { label: 'Minimal', style: { font: 'Inter', bold: false, strokeWidth: 0, shadow: 10, animation: 'fade' } },
};

function newTrackTop(name: string) {
  const id = S().addTrack('visual', true);
  S().commit((d) => { d.tracks.find((t) => t.id === id)!.name = name; }, false);
  return id;
}

// ---------------- Auto captions (Whisper) ----------------
export async function autoCaptions(clipId: string, o: { model: string; language: string; translate: boolean; wordsPer: number; style: string; position: number }) {
  const c = clipById(clipId);
  const a = c && assetOf(c);
  if (!c || !a || a.kind === 'image') return S().toast('Select a video or audio clip first', 'error');
  await runJob('AI captions', async (up) => {
    up(0.02, 'Extracting audio…');
    const audio = await decodeMono(a.blob, 16000, c.inPoint, c.duration * c.speed);
    const out = await transcribe(audio, { model: o.model, language: o.language || undefined, translate: o.translate }, (p, d) => up(Math.min(0.95, p * 0.9), d));
    const p = S().project;
    const H = p.height;
    const trackId = newTrackTop('Captions');
    const st = { ...defaultText(''), size: Math.round(H * (p.width < p.height ? 0.045 : 0.065)), maxWidth: 0.86, ...CAPTION_STYLES[o.style]?.style };
    const clips: Clip[] = [];
    const chunks = out.chunks?.length ? out.chunks : [{ text: out.text, timestamp: [0, c.duration * c.speed] as [number, number] }];
    for (const ch of chunks) {
      const s0 = ch.timestamp[0] ?? 0;
      const e0 = ch.timestamp[1] ?? s0 + 3;
      const words = ch.text.trim().split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      const groups: string[][] = [];
      for (let i = 0; i < words.length; i += o.wordsPer) groups.push(words.slice(i, i + o.wordsPer));
      const totalChars = words.join(' ').length;
      let acc = 0;
      for (const g of groups) {
        const txt = g.join(' ');
        const gs = s0 + ((e0 - s0) * acc) / totalChars;
        acc += txt.length + 1;
        const ge = s0 + ((e0 - s0) * Math.min(totalChars, acc)) / totalChars;
        const start = c.start + gs / c.speed;
        const dur = Math.max(0.25, (ge - gs) / c.speed);
        if (start >= c.start + c.duration) continue;
        clips.push(makeClip({ trackId, type: 'text', name: txt, start, duration: Math.min(dur, c.start + c.duration - start), y: H * o.position, text: { ...st, content: txt } }));
      }
    }
    // prevent overlaps
    clips.sort((x, y) => x.start - y.start);
    for (let i = 0; i < clips.length - 1; i++) if (clips[i].start + clips[i].duration > clips[i + 1].start) clips[i].duration = Math.max(0.1, clips[i + 1].start - clips[i].start);
    S().commit((d) => { d.clips.push(...clips); });
    S().set({ lastTranscript: out.text });
    S().toast(`Added ${clips.length} captions`, 'success');
  });
}

export async function translateCaptionTrack(trackId: string, src: string, tgt: string) {
  const clips = S().project.clips.filter((c) => c.trackId === trackId && c.type === 'text');
  if (!clips.length) return S().toast('That track has no text clips', 'error');
  await runJob('Translate captions', async (up) => {
    const res = await translateTexts(clips.map((c) => c.text!.content), src, tgt, up);
    S().commit((d) => { clips.forEach((c, i) => { const x = d.clips.find((y) => y.id === c.id)!; x.text!.content = res[i]; x.name = res[i]; }); });
    S().toast('Captions translated', 'success');
  });
}

export async function summarizeText(text: string) {
  return runJob('AI summary', (up) => summarize(text, up));
}

// ---------------- Silence removal (jump cuts) ----------------
export async function removeSilence(clipId: string, o: { thresholdDb: number; minSilence: number; padding: number }) {
  const c = clipById(clipId);
  const a = c && assetOf(c);
  if (!c || !a || !a.hasAudio && a.kind !== 'audio') return S().toast('Select a clip with audio', 'error');
  await runJob('Remove silences', async (up) => {
    up(0.2, 'Analysing audio…');
    const ranges = await findSpeechRanges(a, c.inPoint, c.inPoint + c.duration * c.speed, o);
    if (!ranges.length) throw new Error('Everything is below the threshold – lower it');
    const removed = c.duration - ranges.reduce((s, [x, y]) => s + (y - x) / c.speed, 0);
    let t = c.start;
    const parts = ranges.map(([x, y]) => {
      const n: Clip = { ...structuredClone(c), id: uid('c_'), start: t, inPoint: x, duration: (y - x) / c.speed, transitionIn: { type: 'none', duration: 0.5 }, transitionOut: { type: 'none', duration: 0.5 }, keyframes: {} };
      t += n.duration;
      return n;
    });
    S().commit((d) => {
      d.clips = d.clips.filter((x) => x.id !== c.id);
      // ripple the rest of the track (and linked audio if detached) left
      for (const o2 of d.clips) if (o2.trackId === c.trackId && o2.start >= c.start + c.duration - 1e-3) o2.start -= removed;
      d.clips.push(...parts);
    });
    S().set({ selectedId: parts[0].id });
    S().toast(`Removed ${removed.toFixed(1)}s of silence in ${parts.length - 1} cuts`, 'success');
  });
}

// ---------------- Scene detection ----------------
export async function splitScenes(clipId: string, threshold: number) {
  const c = clipById(clipId);
  const a = c && assetOf(c);
  if (!c || !a || a.kind !== 'video') return S().toast('Select a video clip', 'error');
  await runJob('Scene detection', async (up) => {
    const cuts = await detectScenes(a, c.inPoint, c.inPoint + c.duration * c.speed, threshold, (p) => up(p, 'Scanning frames…'));
    const times = cuts.map((s) => c.start + (s - c.inPoint) / c.speed).sort((x, y) => y - x);
    let id = c.id;
    for (const t of times.reverse()) { S().splitClip(id, t); id = S().selectedId!; }
    S().toast(cuts.length ? `Split into ${cuts.length + 1} scenes` : 'No scene changes found', cuts.length ? 'success' : 'info');
  });
}

// ---------------- Beats ----------------
export async function beatMarkers(clipId: string, sensitivity: number) {
  const c = clipById(clipId);
  const a = c && assetOf(c);
  if (!c || !a) return S().toast('Select an audio/video clip', 'error');
  await runJob('Beat detection', async (up) => {
    up(0.3, 'Listening for beats…');
    const { beats, bpm } = await detectBeats(a, sensitivity);
    const inside = beats.filter((b) => b >= c.inPoint && b < c.inPoint + c.duration * c.speed).map((b) => c.start + (b - c.inPoint) / c.speed);
    S().commit((d) => { d.markers = d.markers.filter((m) => !m.label.startsWith('♪')); inside.forEach((t, i) => d.markers.push({ id: uid('m_'), t, label: '♪' + (i + 1), color: '#ff4fa3' })); });
    S().toast(`${inside.length} beats · ~${bpm} BPM`, 'success');
  });
}

/** Cut visual clips on a track exactly at beat markers – instant music video */
export function cutToBeats(clipId: string) {
  const c = clipById(clipId);
  if (!c) return;
  const beats = S().project.markers.filter((m) => m.label.startsWith('♪')).map((m) => m.t).filter((t) => t > c.start && t < c.start + c.duration).sort((a, b) => a - b);
  if (!beats.length) return S().toast('Run beat detection on your music first', 'error');
  let id = c.id;
  for (const t of beats) { S().splitClip(id, t); id = S().selectedId!; }
  S().toast(`Cut into ${beats.length + 1} beat-synced shots`, 'success');
}

// ---------------- Colour / framing ----------------
export async function autoColor(clipId: string) {
  const c = clipById(clipId);
  const a = c && assetOf(c);
  if (!c || !a || a.kind !== 'video') return S().toast('Select a video clip', 'error');
  await runJob('Auto enhance', async () => {
    const r = await autoEnhance(a, c.inPoint, c.inPoint + c.duration * c.speed);
    S().updateClip(clipId, (d) => { Object.assign(d.filters, r); d.filters.sharpen = Math.max(d.filters.sharpen, 0.15); });
    S().toast('Colour corrected', 'success');
  });
}

export async function autoReframe(clipId: string, mode: 'face' | 'object') {
  const c = clipById(clipId);
  const a = c && assetOf(c);
  if (!c || !a || a.kind !== 'video') return S().toast('Select a video clip', 'error');
  await runJob('Auto reframe', async (up) => {
    up(0.02, 'Loading detector…');
    const p = S().project;
    const pts = await trackSubject(a, c, p.width, p.height, mode, (q) => up(q, 'Tracking subject…'));
    S().updateClip(clipId, (d) => {
      d.fit = 'cover'; d.scale = 1;
      d.keyframes.x = pts.map((q) => ({ t: q.t, v: q.x, ease: 'easeInOut' as const }));
      d.keyframes.y = pts.map((q) => ({ t: q.t, v: q.y, ease: 'easeInOut' as const }));
    });
    S().toast('Subject tracked – camera follows automatically', 'success');
  });
}

// ---------------- Generative ----------------
export async function textToSpeech(text: string, voice: string, speed: number) {
  if (!text.trim()) return;
  await runJob('AI voiceover', async (up) => {
    const { audio, rate } = await synthesize(text, voice, speed, up);
    const blob = encodeWav([audio], rate);
    const asset = await createAsset(blob, `Voice – ${text.slice(0, 24)}.wav`);
    S().addAsset(asset);
    const p = S().project;
    const t = S().time;
    const tr = p.tracks.find((x) => x.kind === 'audio' && !overlaps(p, x.id, t, asset.duration));
    S().addClipFromAsset(asset, { start: t, trackId: tr?.id ?? S().addTrack('audio') });
    S().toast('Voiceover added at playhead', 'success');
  });
}

export async function generateImage(prompt: string, w: number, h: number, seed?: number) {
  if (!prompt.trim()) return;
  await runJob('AI image', async (up) => {
    up(0.2, 'Generating (Pollinations · free)…');
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&seed=${seed ?? Math.floor(Math.random() * 1e6)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Image service returned ' + r.status);
    const blob = await r.blob();
    const asset = await createAsset(new File([blob], `AI – ${prompt.slice(0, 30)}.jpg`, { type: blob.type || 'image/jpeg' }));
    S().addAsset(asset);
    S().toast('Image added to media library', 'success');
  });
}

export async function describeFrame() {
  return runJob('Describe frame', async (up) => {
    const s = S();
    const png = await snapshotPng(s.project, s.assets, s.time);
    return captionImage(png, up);
  });
}

// ---------------- Frame tools ----------------
export async function freezeFrame(clipId: string, t: number) {
  const c = clipById(clipId);
  const a = c && assetOf(c);
  if (!c || !a || a.kind !== 'video') return S().toast('Select a video clip under the playhead', 'error');
  await runJob('Freeze frame', async () => {
    const g = frameGrabber(a);
    const cv = await g.grabFull(c.inPoint + (t - c.start) * c.speed);
    g.dispose();
    const blob = await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), 'image/png'));
    const asset = await createAsset(new File([blob], `Freeze ${t.toFixed(2)}s.png`, { type: 'image/png' }));
    S().addAsset(asset);
    S().splitClip(clipId, t);
    const right = S().selectedId!;
    S().commit((d) => {
      for (const x of d.clips) if (x.trackId === c.trackId && x.start >= t - 1e-4) x.start += 2;
      const img = makeClip({ ...structuredClone(c), id: uid('c_'), type: 'image', assetId: asset.id, name: 'Freeze', start: t, duration: 2, inPoint: 0, keyframes: {}, transitionIn: { type: 'none', duration: 0.5 }, transitionOut: { type: 'none', duration: 0.5 } });
      d.clips.push(img);
    });
    S().set({ selectedId: right });
  });
}

export async function applyFFTool(clipId: string, tool: FFTool) {
  const c = clipById(clipId);
  const a = c && assetOf(c);
  if (!c || !a) return S().toast('Select a clip', 'error');
  await runJob(tool.label, async (up) => {
    up(0.01, 'Loading FFmpeg (first time ~30MB)…');
    const out = await runFFmpeg(a.blob, a.name, tool.args, 'out.' + tool.ext, tool.mime, (p) => up(p, 'Processing…'));
    const asset = await createAsset(new File([out], `${a.name.replace(/\.[^.]+$/, '')} – ${tool.label}.${tool.ext}`, { type: tool.mime }));
    S().addAsset(asset);
    if (tool.id === 'extract') {
      S().addClipFromAsset(asset, { start: c.start });
      S().updateClip(clipId, (d) => { d.muted = true; });
    } else if (asset.kind === c.type || (asset.kind === 'audio' && c.type === 'audio')) {
      const ratio = asset.duration / Math.max(0.001, a.duration);
      S().updateClip(clipId, (d) => {
        d.assetId = asset.id;
        if (tool.id === 'reverse') d.inPoint = Math.max(0, a.duration - (c.inPoint + c.duration * c.speed));
        else d.inPoint = c.inPoint * ratio;
        d.duration = Math.min(d.duration * ratio, (asset.duration - d.inPoint) / d.speed);
      });
    }
    S().toast(`${tool.label} applied`, 'success');
  });
}
