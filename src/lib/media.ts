import type { MediaAsset, MediaKind } from '../types';

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function fmtTime(t: number, fps = 30, withFrames = true) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * fps);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (h ? h + ':' : '') + pad(m) + ':' + pad(s) + (withFrames ? '.' + pad(f) : '');
}

function kindOf(file: Blob, name: string): MediaKind | null {
  const t = file.type;
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('image/')) return 'image';
  const n = (name || '').toLowerCase();
  if (/\.(mp4|webm|mov|mkv|m4v|ogv|avi)$/.test(n)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/.test(n)) return 'audio';
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(n)) return 'image';
  return null;
}

function waitEvent(el: EventTarget, ok: string, timeout = 15000) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ok)), timeout);
    el.addEventListener(ok, () => { clearTimeout(t); res(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); rej(new Error('Media could not be decoded by the browser')); }, { once: true });
  });
}

export async function seekVideo(v: HTMLVideoElement, t: number, timeout = 3000) {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return;
  await new Promise<void>((res) => {
    const to = setTimeout(res, timeout);
    v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true });
    v.currentTime = t;
  });
}

const thumbCanvas = () => document.createElement('canvas');

function snapshot(src: CanvasImageSource, w: number, h: number, tw = 160) {
  const c = thumbCanvas();
  c.width = tw;
  c.height = Math.max(1, Math.round((tw * h) / w));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

export async function computePeaks(blob: Blob, buckets = 2000): Promise<{ peaks: number[]; ok: boolean }> {
  try {
    const buf = await decodeAudio(blob);
    const ch = buf.getChannelData(0);
    const size = Math.max(1, Math.floor(ch.length / buckets));
    const peaks: number[] = [];
    let max = 0;
    for (let i = 0; i < buckets; i++) {
      let m = 0;
      const s = i * size;
      for (let j = 0; j < size && s + j < ch.length; j += 4) m = Math.max(m, Math.abs(ch[s + j]));
      peaks.push(m);
      max = Math.max(max, m);
    }
    return { peaks: peaks.map((p) => (max ? p / max : 0)), ok: true };
  } catch {
    return { peaks: [], ok: false };
  }
}

const audioCache = new Map<Blob, Promise<AudioBuffer>>();
export function decodeAudio(blob: Blob, sampleRate = 48000): Promise<AudioBuffer> {
  const key = blob;
  if (sampleRate === 48000 && audioCache.has(key)) return audioCache.get(key)!;
  const p = (async () => {
    const ab = await blob.arrayBuffer();
    const ctx = new OfflineAudioContext(2, 1, sampleRate);
    return await ctx.decodeAudioData(ab);
  })();
  if (sampleRate === 48000) {
    audioCache.set(key, p);
    p.catch(() => audioCache.delete(key));
  }
  return p;
}

/** mono Float32 at given rate (for Whisper etc) */
export async function decodeMono(blob: Blob, rate = 16000, from = 0, dur?: number): Promise<Float32Array> {
  const src = await decodeAudio(blob);
  const len = dur ?? src.duration - from;
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(len * rate)), rate);
  const node = ctx.createBufferSource();
  node.buffer = src;
  node.connect(ctx.destination);
  node.start(0, from, len);
  const out = await ctx.startRendering();
  return out.getChannelData(0);
}

export async function createAsset(file: Blob, name?: string): Promise<MediaAsset> {
  const nm = name || (file as File).name || 'media';
  const kind = kindOf(file, nm);
  if (!kind) throw new Error(`Unsupported file: ${nm}`);
  const url = URL.createObjectURL(file);
  const base = { id: uid('a_'), name: nm, kind, url, blob: file } as const;

  if (kind === 'image') {
    const img = new Image();
    img.src = url;
    await waitEvent(img, 'load');
    return { ...base, duration: 5, width: img.naturalWidth || 1280, height: img.naturalHeight || 720, hasAudio: false, thumbnail: snapshot(img, img.naturalWidth, img.naturalHeight) };
  }

  if (kind === 'audio') {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.src = url;
    await waitEvent(a, 'loadedmetadata');
    let duration = a.duration;
    const { peaks } = await computePeaks(file);
    if (!isFinite(duration)) duration = (await decodeAudio(file)).duration;
    return { ...base, duration, width: 0, height: 0, hasAudio: true, waveform: peaks };
  }

  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.src = url;
  await waitEvent(v, 'loadeddata', 20000);
  let duration = v.duration;
  if (!isFinite(duration)) {
    v.currentTime = 1e9;
    await waitEvent(v, 'seeked').catch(() => {});
    duration = v.duration;
  }
  if (!v.videoWidth) throw new Error('This video codec is not supported by your browser. Use Tools → Convert with FFmpeg.');
  const w = v.videoWidth, h = v.videoHeight;
  const filmstrip: string[] = [];
  const N = 8;
  for (let i = 0; i < N; i++) {
    await seekVideo(v, Math.min(duration - 0.05, (duration * (i + 0.5)) / N));
    filmstrip.push(snapshot(v, w, h, 120));
  }
  await seekVideo(v, Math.min(0.5, duration / 2));
  const thumbnail = snapshot(v, w, h);
  const { peaks, ok } = await computePeaks(file);
  v.removeAttribute('src');
  v.load();
  return { ...base, duration, width: w, height: h, hasAudio: ok && peaks.some((p) => p > 0.01), thumbnail, filmstrip, waveform: ok ? peaks : undefined };
}

export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const n = channels[0].length, nc = channels.length;
  const buf = new ArrayBuffer(44 + n * nc * 2);
  const dv = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nc, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nc * 2, true);
  dv.setUint16(32, nc * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const s = Math.max(-1, Math.min(1, channels[c][i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
