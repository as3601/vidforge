import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { Clip, MediaAsset, Project } from '../types';
import { renderFrame, sourceTime, clipGain, type SourceProvider } from './compositor';
import { decodeAudio, seekVideo, encodeWav } from '../lib/media';
import { imageFor, loadImage } from './player';
import { loadSegmenter } from '../ai/vision';
import { projectDuration } from '../store';

export interface ExportOpts { width: number; height: number; fps: number; bitrate: number; from: number; to: number; audio: boolean }

function audible(p: Project, assets: Record<string, MediaAsset>) {
  return p.clips.filter((c) => {
    const a = c.assetId ? assets[c.assetId] : undefined;
    const tr = p.tracks.find((t) => t.id === c.trackId);
    if (!a || !tr || tr.muted || c.muted) return false;
    if (c.type === 'audio') return true;
    return c.type === 'video' && a.hasAudio && !tr.hidden;
  });
}

export async function mixAudio(p: Project, assets: Record<string, MediaAsset>, from: number, to: number, sampleRate = 48000): Promise<AudioBuffer> {
  const len = Math.max(1, Math.ceil((to - from) * sampleRate));
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const master = ctx.createDynamicsCompressor(); // gentle limiter to avoid clipping when mixing
  master.threshold.value = -3; master.knee.value = 2; master.ratio.value = 12; master.attack.value = 0.003; master.release.value = 0.1;
  master.connect(ctx.destination);
  for (const c of audible(p, assets)) {
    const s = Math.max(c.start, from), e = Math.min(c.start + c.duration, to);
    if (e <= s) continue;
    let buf: AudioBuffer;
    try { buf = await decodeAudio(assets[c.assetId!].blob); } catch { continue; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = c.speed;
    const g = ctx.createGain();
    const animated = c.fadeIn > 0 || c.fadeOut > 0 || (c.keyframes.volume?.length ?? 0) > 0;
    if (animated) {
      const step = 1 / 50;
      for (let t = s; t <= e + 1e-6; t += step) g.gain.setValueAtTime(clipGain(c, t), t - from);
    } else g.gain.value = clipGain(c, s + 0.001);
    src.connect(g).connect(master);
    src.start(s - from, sourceTime(c, s), (e - s) * c.speed);
  }
  return ctx.startRendering();
}

class ExportSources implements SourceProvider {
  els = new Map<string, HTMLVideoElement>();
  /** idle, already-loaded elements per asset — recycled so montages with many cuts don't spawn one decoder per clip */
  free = new Map<string, HTMLVideoElement[]>();
  constructor(private assets: Record<string, MediaAsset>) {}
  async prepare(p: Project, t: number) {
    const jobs: Promise<void>[] = [];
    const byId = new Map(p.clips.map((c) => [c.id, c]));
    for (const [id, v] of this.els) {
      const c = byId.get(id);
      if (c && t >= c.start && t < c.start + c.duration) continue;
      this.els.delete(id);
      const k = v.dataset.asset!;
      if (!this.free.has(k)) this.free.set(k, []);
      this.free.get(k)!.push(v);
    }
    for (const c of p.clips) {
      if (c.type === 'image' && t >= c.start && t < c.start + c.duration && c.assetId && this.assets[c.assetId]) { await loadImage(this.assets[c.assetId]); continue; }
      if (c.type !== 'video' || !(t >= c.start && t < c.start + c.duration)) continue;
      const a = this.assets[c.assetId!];
      if (!a) continue;
      let v = this.els.get(c.id);
      if (!v) v = this.free.get(a.id)?.pop();
      if (v) this.els.set(c.id, v);
      else {
        v = document.createElement('video');
        v.muted = true; v.preload = 'auto'; v.src = a.url; v.dataset.asset = a.id;
        this.els.set(c.id, v);
        await new Promise<void>((res) => { v!.addEventListener('loadeddata', () => res(), { once: true }); v!.addEventListener('error', () => res(), { once: true }); });
      }
      jobs.push(seekVideo(v, Math.min(a.duration - 0.001, sourceTime(c, t))));
    }
    await Promise.all(jobs);
  }
  get(c: Clip) {
    const a = c.assetId ? this.assets[c.assetId] : undefined;
    if (!a) return null;
    if (a.kind === 'image') { const im = imageFor(a); return im ? { src: im, w: im.naturalWidth, h: im.naturalHeight } : null; }
    const v = this.els.get(c.id);
    return v && v.videoWidth ? { src: v, w: v.videoWidth, h: v.videoHeight } : null;
  }
  dispose() { for (const v of [...this.els.values(), ...[...this.free.values()].flat()]) { v.removeAttribute('src'); v.load(); } }
}

async function pickVideoCodec(w: number, h: number, fps: number, bitrate: number) {
  for (const codec of ['avc1.640034', 'avc1.640033', 'avc1.4d0034', 'avc1.42003e', 'avc1.640028', 'avc1.42001f']) {
    const cfg: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: fps, bitrateMode: 'variable' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
  }
  throw new Error('No H.264 encoder available in this browser. Use Chrome or Edge.');
}

export async function exportMp4(p: Project, assets: Record<string, MediaAsset>, o: ExportOpts, onP: (p: number, d: string) => void, signal: { cancel: boolean }): Promise<Blob> {
  if (!('VideoEncoder' in window)) throw new Error('WebCodecs not supported – use Chrome, Edge or Opera');
  const W = o.width & ~1, H = o.height & ~1;
  await document.fonts.ready;
  if (p.clips.some((c) => c.bgMode !== 'none')) { onP(0, 'Loading AI segmentation…'); await loadSegmenter(); }

  const vcfg = await pickVideoCodec(W, H, o.fps, o.bitrate);
  let audioCfg: AudioEncoderConfig | null = null;
  let aCodec: 'aac' | 'opus' = 'aac';
  const hasAudio = o.audio && audible(p, assets).length > 0;
  if (hasAudio) {
    for (const [codec, mc] of [['mp4a.40.2', 'aac'], ['opus', 'opus']] as const) {
      const cfg = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 };
      try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) { audioCfg = cfg; aCodec = mc; break; } } catch { /* next */ }
    }
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: o.fps },
    ...(audioCfg ? { audio: { codec: aCodec, sampleRate: 48000, numberOfChannels: 2 } } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let err: Error | null = null;
  const venc = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: (e) => { err = e as Error; } });
  venc.configure(vcfg);

  // ---- audio first (fast) ----
  if (audioCfg) {
    onP(0, 'Mixing audio…');
    const buf = await mixAudio(p, assets, o.from, o.to);
    const aenc = new AudioEncoder({ output: (ch, meta) => muxer.addAudioChunk(ch, meta), error: (e) => { err = e as Error; } });
    aenc.configure(audioCfg);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const N = 4800;
    for (let i = 0; i < buf.length; i += N) {
      const n = Math.min(N, buf.length - i);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / 48000) * 1e6), data });
      aenc.encode(ad); ad.close();
    }
    await aenc.flush(); aenc.close();
  }

  // ---- video frames ----
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
  const src = new ExportSources(assets);
  const total = Math.max(1, Math.round((o.to - o.from) * o.fps));
  const scale = W / p.width;
  const t0 = performance.now();
  try {
    for (let i = 0; i < total; i++) {
      if (signal.cancel) throw new Error('Export cancelled');
      if (err) throw err;
      // Browsers stop decoding video in background tabs, so seeks return stale frames — wait until visible.
      while (document.hidden && !signal.cancel) {
        onP(i / total, 'Paused — keep this tab visible while exporting');
        await new Promise((r) => setTimeout(r, 300));
      }
      const t = o.from + i / o.fps;
      await src.prepare(p, t);
      renderFrame(ctx, { ...p, width: p.width, height: p.height }, t, src, { scale, maxProc: 1920, time: t });
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i / o.fps) * 1e6), duration: Math.round(1e6 / o.fps) });
      venc.encode(frame, { keyFrame: i % (o.fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
      if (i % 5 === 0) {
        const el = (performance.now() - t0) / 1000;
        const eta = (el / (i + 1)) * (total - i - 1);
        onP(i / total, `Rendering frame ${i + 1}/${total} · ${((i + 1) / el).toFixed(1)} fps · ~${Math.ceil(eta)}s left`);
      }
    }
    await venc.flush();
  } finally {
    src.dispose();
    try { venc.close(); } catch { /* closed */ }
  }
  muxer.finalize();
  onP(1, 'Done');
  return new Blob([(muxer.target as ArrayBufferTarget).buffer], { type: 'video/mp4' });
}

export async function exportWav(p: Project, assets: Record<string, MediaAsset>) {
  const buf = await mixAudio(p, assets, 0, projectDuration(p));
  return encodeWav([buf.getChannelData(0), buf.getChannelData(1)], buf.sampleRate);
}

export async function snapshotPng(p: Project, assets: Record<string, MediaAsset>, t: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = p.width; c.height = p.height;
  const src = new ExportSources(assets);
  await src.prepare(p, t);
  renderFrame(c.getContext('2d')!, p, t, src, { scale: 1, maxProc: 1920, time: t });
  src.dispose();
  return new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
}
