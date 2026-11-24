// Signal-processing "AI" — runs instantly with no model downloads.
import type { Clip, MediaAsset } from '../types';
import { decodeAudio, seekVideo } from '../lib/media';
import { detectSubject } from './vision';

/** Find non-silent ranges [start,end] in source seconds */
export async function findSpeechRanges(asset: MediaAsset, from: number, to: number, opts: { thresholdDb: number; minSilence: number; padding: number }) {
  const buf = await decodeAudio(asset.blob);
  const sr = buf.sampleRate;
  const win = Math.round(sr * 0.02);
  const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const thr = Math.pow(10, opts.thresholdDb / 20);
  const s0 = Math.floor(from * sr), s1 = Math.min(buf.length, Math.floor(to * sr));
  const loud: boolean[] = [];
  for (let s = s0; s < s1; s += win) {
    let sum = 0, n = 0;
    for (const ch of chs) for (let i = s; i < Math.min(s + win, s1); i += 2) { sum += ch[i] * ch[i]; n++; }
    loud.push(Math.sqrt(sum / Math.max(1, n)) > thr);
  }
  const minSilWins = Math.ceil(opts.minSilence / 0.02);
  // close short gaps
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < loud.length) {
    if (!loud[i]) { i++; continue; }
    let j = i;
    while (j < loud.length) {
      if (loud[j]) { j++; continue; }
      let k = j; while (k < loud.length && !loud[k]) k++;
      if (k - j >= minSilWins || k >= loud.length) break;
      j = k;
    }
    ranges.push([from + i * 0.02, from + j * 0.02]);
    i = j;
  }
  return ranges.map(([a, b]) => [Math.max(from, a - opts.padding), Math.min(to, b + opts.padding)] as [number, number])
    .reduce<[number, number][]>((acc, r) => { const l = acc[acc.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else acc.push(r); return acc; }, [])
    .filter(([a, b]) => b - a > 0.08);
}

/** Beat / onset detection (spectral-flux-like energy novelty) – returns times in source seconds */
export async function detectBeats(asset: MediaAsset, sensitivity = 0.5): Promise<{ beats: number[]; bpm: number }> {
  const buf = await decodeAudio(asset.blob);
  const sr = buf.sampleRate, ch = buf.getChannelData(0);
  const hop = 512;
  const energy: number[] = [];
  // crude low-pass to emphasise kick/bass
  let lp = 0;
  for (let s = 0; s + hop < ch.length; s += hop) {
    let e = 0;
    for (let i = s; i < s + hop; i++) { lp += 0.15 * (ch[i] - lp); e += lp * lp; }
    energy.push(Math.sqrt(e / hop));
  }
  const flux = energy.map((e, i) => Math.max(0, e - (energy[i - 1] ?? e)));
  const W = 43; // ~0.46 s window
  const beats: number[] = [];
  let last = -1;
  const k = 1.2 + (1 - sensitivity) * 1.6;
  for (let i = 0; i < flux.length; i++) {
    let m = 0, n = 0;
    for (let j = Math.max(0, i - W); j < Math.min(flux.length, i + W); j++) { m += flux[j]; n++; }
    m /= n;
    const t = (i * hop) / sr;
    if (flux[i] > m * k && flux[i] > 0.002 && flux[i] >= (flux[i - 1] ?? 0) && flux[i] >= (flux[i + 1] ?? 0) && t - last > 0.25) { beats.push(t); last = t; }
  }
  // BPM from inter-onset histogram
  const hist = new Map<number, number>();
  for (let i = 1; i < beats.length; i++) {
    let bpm = 60 / (beats[i] - beats[i - 1]);
    while (bpm < 70) bpm *= 2; while (bpm > 180) bpm /= 2;
    const r = Math.round(bpm);
    hist.set(r, (hist.get(r) || 0) + 1);
  }
  const bpm = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
  return { beats, bpm };
}

function frameGrabber(asset: MediaAsset, w = 96) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = asset.url;
  const h = Math.max(2, Math.round((w * asset.height) / asset.width));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  return {
    canvas: c,
    async grab(t: number) { await seekVideo(v, t); x.drawImage(v, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; },
    async grabFull(t: number) {
      await seekVideo(v, t);
      const fc = document.createElement('canvas'); fc.width = asset.width; fc.height = asset.height;
      fc.getContext('2d')!.drawImage(v, 0, 0); return fc;
    },
    dispose() { v.removeAttribute('src'); v.load(); },
  };
}

/** Scene-cut detection by colour histogram distance. Returns cut times (source seconds) */
export async function detectScenes(asset: MediaAsset, from: number, to: number, threshold: number, onP: (p: number) => void) {
  const g = frameGrabber(asset);
  const step = 1 / 6;
  const cuts: number[] = [];
  let prev: Float32Array | null = null;
  const hist = (d: Uint8ClampedArray) => {
    const hh = new Float32Array(48);
    for (let i = 0; i < d.length; i += 4) { hh[d[i] >> 4]++; hh[16 + (d[i + 1] >> 4)]++; hh[32 + (d[i + 2] >> 4)]++; }
    const n = d.length / 4; for (let i = 0; i < 48; i++) hh[i] /= n; return hh;
  };
  let lastCut = from;
  for (let t = from; t < to; t += step) {
    const h = hist(await g.grab(t));
    if (prev) {
      let d = 0; for (let i = 0; i < 48; i++) d += Math.abs(h[i] - prev[i]);
      d /= 6; // normalise ~0..1
      if (d > threshold && t - lastCut > 0.6) { cuts.push(t); lastCut = t; }
    }
    prev = h;
    onP((t - from) / (to - from));
  }
  g.dispose();
  return cuts;
}

/** Auto colour enhance: analyse sampled frames and return filter corrections */
export async function autoEnhance(asset: MediaAsset, from: number, to: number) {
  const g = frameGrabber(asset, 128);
  let lum = 0, lum2 = 0, sat = 0, rr = 0, bb = 0, n = 0;
  for (let i = 0; i < 6; i++) {
    const d = await g.grab(from + ((to - from) * (i + 0.5)) / 6);
    for (let k = 0; k < d.length; k += 16) {
      const r = d[k] / 255, gg = d[k + 1] / 255, b = d[k + 2] / 255;
      const l = 0.299 * r + 0.587 * gg + 0.114 * b;
      lum += l; lum2 += l * l; sat += Math.max(r, gg, b) - Math.min(r, gg, b); rr += r; bb += b; n++;
    }
  }
  g.dispose();
  const mean = lum / n, std = Math.sqrt(Math.max(0, lum2 / n - mean * mean)), s = sat / n;
  const cast = (rr - bb) / n;
  return {
    brightness: +Math.min(1.6, Math.max(0.75, 0.5 / Math.max(0.15, mean))).toFixed(2),
    contrast: +Math.min(1.5, Math.max(0.9, 0.22 / Math.max(0.08, std))).toFixed(2),
    saturation: +Math.min(1.6, Math.max(1, 0.28 / Math.max(0.08, s))).toFixed(2),
    temperature: +Math.max(-0.5, Math.min(0.5, -cast * 2)).toFixed(2),
  };
}

/** Auto-reframe: track subject and return x/y keyframes (project px offsets) for a cover-fit clip */
export async function trackSubject(asset: MediaAsset, clip: Clip, projW: number, projH: number, mode: 'face' | 'object', onP: (p: number) => void) {
  const g = frameGrabber(asset, Math.min(640, asset.width));
  const k = Math.max(projW / asset.width, projH / asset.height); // cover scale
  const dw = asset.width * k, dh = asset.height * k;
  const maxX = Math.max(0, (dw - projW) / 2), maxY = Math.max(0, (dh - projH) / 2);
  const step = 0.5;
  const pts: { t: number; x: number; y: number }[] = [];
  let lastX = 0, lastY = 0;
  const N = Math.max(1, Math.ceil(clip.duration / step));
  for (let i = 0; i <= N; i++) {
    const local = Math.min(clip.duration - 0.01, i * step);
    const st = clip.inPoint + local * clip.speed;
    await g.grab(st);
    const b = await detectSubject(g.canvas, mode);
    if (b) {
      const sc = asset.width / g.canvas.width;
      const cx = (b.x + b.w / 2) * sc, cy = (b.y + b.h / 2) * sc;
      lastX = Math.max(-maxX, Math.min(maxX, (asset.width / 2 - cx) * k));
      lastY = Math.max(-maxY, Math.min(maxY, (asset.height / 2 - cy) * k));
    }
    pts.push({ t: local, x: lastX, y: lastY });
    onP(i / N);
  }
  g.dispose();
  // smooth (moving average) for camera-operator feel
  const sm = pts.map((p, i) => {
    const w = pts.slice(Math.max(0, i - 2), i + 3);
    return { t: p.t, x: w.reduce((a, b) => a + b.x, 0) / w.length, y: w.reduce((a, b) => a + b.y, 0) / w.length };
  });
  return sm;
}

export { frameGrabber };
