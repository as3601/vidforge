import type { Clip, MediaAsset, Project } from '../types';
import { useStore, projectDuration } from '../store';
import { renderFrame, sourceTime, clipGain, type SourceProvider } from './compositor';

const images = new Map<string, HTMLImageElement>();
export function imageFor(a: MediaAsset): HTMLImageElement | null {
  let im = images.get(a.id);
  if (!im) { im = new Image(); im.src = a.url; images.set(a.id, im); }
  return im.complete && im.naturalWidth ? im : null;
}

/** resolves once the asset's image is decoded (used by the exporter so stills never render black) */
export async function loadImage(a: MediaAsset): Promise<HTMLImageElement | null> {
  imageFor(a);
  const im = images.get(a.id)!;
  if (im.complete && im.naturalWidth) return im;
  try { await im.decode(); } catch { return null; }
  return im;
}

/** Live preview engine: keeps one media element per clip in sync with the master clock */
class PreviewEngine {
  els = new Map<string, HTMLMediaElement>();
  canvas: HTMLCanvasElement | null = null;
  quality = 0.5;
  private raf = 0;
  private clockStart = 0;
  private timeStart = 0;
  private dirty = true;
  private lastDraw = 0;
  meter = { l: 0, r: 0 };

  attach(c: HTMLCanvasElement | null) {
    this.canvas = c;
    this.invalidate();
    if (!this.raf) this.loop();
  }

  invalidate() { this.dirty = true; }

  private el(c: Clip, a: MediaAsset): HTMLMediaElement {
    let e = this.els.get(c.id);
    if (e && e.dataset.asset !== a.id) { e.pause(); e.removeAttribute('src'); this.els.delete(c.id); e = undefined; }
    if (!e) {
      e = document.createElement(a.kind === 'audio' ? 'audio' : 'video');
      e.preload = 'auto';
      (e as HTMLVideoElement).playsInline = true;
      e.dataset.asset = a.id;
      e.src = a.url;
      e.addEventListener('seeked', () => this.invalidate());
      e.addEventListener('loadeddata', () => this.invalidate());
      this.els.set(c.id, e);
    }
    return e;
  }

  sources: SourceProvider = {
    get: (c) => {
      const a = c.assetId ? useStore.getState().assets[c.assetId] : undefined;
      if (!a) return null;
      if (a.kind === 'image') { const im = imageFor(a); return im ? { src: im, w: im.naturalWidth, h: im.naturalHeight } : null; }
      const v = this.els.get(c.id) as HTMLVideoElement | undefined;
      if (!v || v.readyState < 2 || !v.videoWidth) return null;
      return { src: v, w: v.videoWidth, h: v.videoHeight };
    },
  };

  play() {
    const s = useStore.getState();
    const dur = projectDuration(s.project);
    if (s.time >= dur - 0.05) s.set({ time: 0 });
    this.clockStart = performance.now();
    this.timeStart = useStore.getState().time;
    s.set({ playing: true });
  }
  pause() { useStore.getState().set({ playing: false }); this.syncMedia(useStore.getState().project, useStore.getState().time, false); }
  toggle() { useStore.getState().playing ? this.pause() : this.play(); }
  seek(t: number) {
    const s = useStore.getState();
    t = Math.max(0, t);
    s.set({ time: t });
    if (s.playing) { this.clockStart = performance.now(); this.timeStart = t; }
    this.invalidate();
  }

  private syncMedia(p: Project, t: number, playing: boolean) {
    const s = useStore.getState();
    const live = new Set<string>();
    for (const c of p.clips) {
      if (c.type !== 'video' && c.type !== 'audio') continue;
      const a = c.assetId ? s.assets[c.assetId] : undefined;
      if (!a) continue;
      const track = p.tracks.find((tr) => tr.id === c.trackId);
      const active = t >= c.start && t < c.start + c.duration && !!track && !(track.kind === 'visual' && track.hidden);
      const upcoming = t < c.start && c.start - t < 1.5;
      if (!active && !upcoming) continue;
      live.add(c.id);
      const e = this.el(c, a);
      if (upcoming) {
        if (!e.paused) e.pause();
        if (Math.abs(e.currentTime - c.inPoint) > 0.05 && !e.seeking) e.currentTime = c.inPoint;
        continue;
      }
      const target = sourceTime(c, t);
      const vol = track?.muted ? 0 : clipGain(c, t);
      e.volume = Math.min(1, vol);
      e.muted = vol <= 0;
      if (e.playbackRate !== c.speed) e.playbackRate = c.speed;
      if (playing) {
        if (Math.abs(e.currentTime - target) > 0.25 && !e.seeking) e.currentTime = target;
        if (e.paused) e.play().catch(() => {});
      } else {
        if (!e.paused) e.pause();
        if (Math.abs(e.currentTime - target) > 0.5 / p.fps && !e.seeking) e.currentTime = target;
      }
    }
    for (const [id, e] of this.els) {
      if (!live.has(id)) {
        if (!e.paused) e.pause();
        if (!p.clips.some((c) => c.id === id)) { e.removeAttribute('src'); e.load(); this.els.delete(id); }
      }
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const s = useStore.getState();
    let t = s.time;
    if (s.playing) {
      t = this.timeStart + (performance.now() - this.clockStart) / 1000;
      const dur = projectDuration(s.project);
      if (t >= dur) { t = dur; s.set({ time: t, playing: false }); }
      else s.set({ time: t });
      this.dirty = true;
    }
    this.syncMedia(s.project, t, s.playing);
    const now = performance.now();
    if (!this.canvas || (!this.dirty && now - this.lastDraw < 250)) return;
    this.dirty = false;
    this.lastDraw = now;
    const p = s.project;
    const q = this.quality;
    const w = Math.round(p.width * q), h = Math.round(p.height * q);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const ctx = this.canvas.getContext('2d')!;
    try {
      renderFrame(ctx, p, t, this.sources, { scale: q, maxProc: q < 0.75 ? 960 : 1920, time: t });
    } catch (e) { console.error(e); }
  };
}

export const engine = new PreviewEngine();
useStore.subscribe((s, prev) => { if (s.project !== prev.project || s.assets !== prev.assets) engine.invalidate(); });
