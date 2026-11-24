import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { AnimProp, Clip, Filters, Keyframe, MediaAsset, Project, TextStyle, Track, TrackKind } from './types';
import { uid } from './lib/media';

export const defaultFilters = (): Filters => ({
  brightness: 1, contrast: 1, saturation: 1, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: 0,
  temperature: 0, tint: 0, vignette: 0, sharpen: 0,
});

export const defaultText = (content = 'Your Text'): TextStyle => ({
  content, font: 'Montserrat', size: 96, color: '#ffffff', bold: true, italic: false, align: 'center',
  strokeColor: '#000000', strokeWidth: 0, shadow: 12, shadowColor: 'rgba(0,0,0,0.6)', background: '', bgPadding: 18,
  letterSpacing: 0, lineHeight: 1.15, uppercase: false, animation: 'fade', highlightColor: '#ffd400', maxWidth: 0.85,
});

export function makeClip(p: Partial<Clip> & Pick<Clip, 'trackId' | 'type'>): Clip {
  return {
    id: uid('c_'), name: p.type, start: 0, duration: 5, inPoint: 0, speed: 1, volume: 1, muted: false,
    fadeIn: 0, fadeOut: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false, fit: 'contain',
    crop: { top: 0, right: 0, bottom: 0, left: 0 }, filters: defaultFilters(), effect: 'none', effectAmount: 0.5,
    blend: 'source-over', chroma: { enabled: false, color: '#00ff00', similarity: 0.35, smoothness: 0.08, spill: 0.3 },
    bgMode: 'none', bgColor: '#1e90ff', bgInvert: false,
    transitionIn: { type: 'none', duration: 0.5 }, transitionOut: { type: 'none', duration: 0.5 }, keyframes: {},
    ...p,
  };
}

const newProject = (): Project => ({
  name: 'Untitled Project', width: 1920, height: 1080, fps: 30, background: '#000000',
  tracks: [
    { id: 't_v2', kind: 'visual', name: 'Overlay', muted: false, hidden: false, locked: false },
    { id: 't_v1', kind: 'visual', name: 'Main', muted: false, hidden: false, locked: false },
    { id: 't_a1', kind: 'audio', name: 'Audio 1', muted: false, hidden: false, locked: false },
  ],
  clips: [], markers: [],
});

export interface Job { id: string; label: string; progress: number; detail?: string }
export interface Toast { id: string; msg: string; kind: 'info' | 'error' | 'success' }

interface State {
  project: Project;
  assets: Record<string, MediaAsset>;
  selectedId: string | null;
  time: number;
  playing: boolean;
  zoom: number; // px per second
  snapping: boolean;
  past: Project[];
  future: Project[];
  jobs: Job[];
  toasts: Toast[];
  leftTab: string;
  lastTranscript: string;

  set: (p: Partial<State>) => void;
  commit: (fn: (d: Draft<Project>) => void, history?: boolean) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  loadProject: (p: Project, assets: Record<string, MediaAsset>) => void;
  newProject: () => void;

  addAsset: (a: MediaAsset) => void;
  removeAsset: (id: string) => void;
  addClipFromAsset: (a: MediaAsset, at?: { start?: number; trackId?: string }) => string;
  addClip: (c: Clip) => void;
  addTextClip: (content?: string, style?: Partial<TextStyle>) => string;
  addSolidClip: (color: string) => string;
  updateClip: (id: string, fn: (c: Draft<Clip>) => void, history?: boolean) => void;
  deleteClip: (id: string, ripple?: boolean) => void;
  splitClip: (id: string, t: number) => void;
  splitAll: (t: number) => void;
  duplicateClip: (id: string) => void;
  detachAudio: (id: string) => void;
  addTrack: (kind: TrackKind, top?: boolean) => string;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  removeTrack: (id: string) => void;
  setKeyframe: (clipId: string, prop: AnimProp, t: number, v: number) => void;
  removeKeyframe: (clipId: string, prop: AnimProp, t: number) => void;
  addMarker: (t: number, label?: string) => void;
  job: (label: string) => { update: (p: number, detail?: string) => void; done: () => void };
  toast: (msg: string, kind?: Toast['kind']) => void;
}

export const projectDuration = (p: Project) => p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);

export const overlaps = (p: Project, trackId: string, start: number, dur: number, ignore?: string) =>
  p.clips.some((c) => c.trackId === trackId && c.id !== ignore && start < c.start + c.duration - 1e-4 && start + dur > c.start + 1e-4);

function trackEnd(p: Project, trackId: string) {
  return p.clips.filter((c) => c.trackId === trackId).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
}

const HISTORY = 100;

export const useStore = create<State>((set, get) => ({
  project: newProject(),
  assets: {},
  selectedId: null,
  time: 0,
  playing: false,
  zoom: 60,
  snapping: true,
  past: [],
  future: [],
  jobs: [],
  toasts: [],
  leftTab: 'media',
  lastTranscript: '',

  set: (p) => set(p),
  commit: (fn, history = true) => {
    const prev = get().project;
    const next = produce(prev, fn);
    if (next === prev) return;
    set(history ? { project: next, past: [...get().past.slice(-HISTORY), prev], future: [] } : { project: next });
  },
  checkpoint: () => set({ past: [...get().past.slice(-HISTORY), get().project], future: [] }),
  undo: () => {
    const { past, project, future } = get();
    if (!past.length) return;
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future] });
  },
  redo: () => {
    const { past, project, future } = get();
    if (!future.length) return;
    set({ project: future[0], future: future.slice(1), past: [...past, project] });
  },
  loadProject: (p, assets) => set({ project: p, assets, past: [], future: [], selectedId: null, time: 0 }),
  newProject: () => set({ project: newProject(), past: [], future: [], selectedId: null, time: 0 }),

  addAsset: (a) => set({ assets: { ...get().assets, [a.id]: a } }),
  removeAsset: (id) => {
    get().commit((d) => { d.clips = d.clips.filter((c) => c.assetId !== id); });
    const { [id]: _, ...rest } = get().assets;
    set({ assets: rest });
  },

  addClipFromAsset: (a, at = {}) => {
    const p = get().project;
    const kind: TrackKind = a.kind === 'audio' ? 'audio' : 'visual';
    let trackId = at.trackId;
    if (!trackId) {
      const tracks = p.tracks.filter((t) => t.kind === kind);
      trackId = kind === 'visual' ? tracks[tracks.length - 1]?.id : tracks[0]?.id;
      if (!trackId) trackId = get().addTrack(kind);
    }
    const dur = a.kind === 'image' ? 5 : a.duration;
    let start = at.start ?? trackEnd(get().project, trackId);
    if (overlaps(get().project, trackId, start, dur)) {
      // find a free track of the same kind or create one
      const free = get().project.tracks.find((t) => t.kind === kind && !overlaps(get().project, t.id, start, dur));
      trackId = free ? free.id : get().addTrack(kind, kind === 'visual');
    }
    const c = makeClip({
      trackId, type: a.kind, assetId: a.id, name: a.name, start, duration: dur,
    });
    get().commit((d) => { d.clips.push(c); });
    set({ selectedId: c.id });
    return c.id;
  },
  addClip: (c) => { get().commit((d) => { d.clips.push(c); }); set({ selectedId: c.id }); },

  addTextClip: (content, style) => {
    const p = get().project;
    const t = get().time;
    let track = p.tracks.find((tr) => tr.kind === 'visual' && !overlaps(p, tr.id, t, 3));
    const trackId = track && track.id !== p.tracks.filter((x) => x.kind === 'visual').slice(-1)[0]?.id ? track.id : get().addTrack('visual', true);
    const c = makeClip({ trackId, type: 'text', name: content || 'Text', start: t, duration: 3, text: { ...defaultText(content), ...style } });
    get().commit((d) => { d.clips.push(c); });
    set({ selectedId: c.id });
    return c.id;
  },
  addSolidClip: (color) => {
    const p = get().project;
    const t = get().time;
    const track = p.tracks.find((tr) => tr.kind === 'visual' && !overlaps(p, tr.id, t, 5));
    const trackId = track ? track.id : get().addTrack('visual', true);
    const c = makeClip({ trackId, type: 'solid', name: 'Color', start: t, duration: 5, color, fit: 'stretch' });
    get().commit((d) => { d.clips.push(c); });
    set({ selectedId: c.id });
    return c.id;
  },

  updateClip: (id, fn, history = true) => get().commit((d) => {
    const c = d.clips.find((x) => x.id === id);
    if (c) fn(c);
  }, history),

  deleteClip: (id, ripple = false) => {
    get().commit((d) => {
      const c = d.clips.find((x) => x.id === id);
      if (!c) return;
      d.clips = d.clips.filter((x) => x.id !== id);
      if (ripple) for (const o of d.clips) if (o.trackId === c.trackId && o.start >= c.start + c.duration - 1e-4) o.start -= c.duration;
    });
    if (get().selectedId === id) set({ selectedId: null });
  },

  splitClip: (id, t) => {
    const c0 = get().project.clips.find((c) => c.id === id);
    if (!c0 || t <= c0.start + 0.02 || t >= c0.start + c0.duration - 0.02) return;
    const rel = t - c0.start;
    const second = produce(c0, (d) => {
      d.id = uid('c_');
      d.start = t;
      d.duration = c0.duration - rel;
      d.inPoint = c0.reverse ? c0.inPoint : c0.inPoint + rel * c0.speed;
      d.transitionIn = { type: 'none', duration: 0.5 };
      d.fadeIn = 0;
      for (const k of Object.keys(d.keyframes) as AnimProp[]) d.keyframes[k] = d.keyframes[k]!.filter((f) => f.t >= rel).map((f) => ({ ...f, t: f.t - rel }));
    });
    get().commit((d) => {
      const c = d.clips.find((x) => x.id === id)!;
      c.duration = rel;
      if (c0.reverse) c.inPoint = c0.inPoint + (c0.duration - rel) * c0.speed;
      c.transitionOut = { type: 'none', duration: 0.5 };
      c.fadeOut = 0;
      for (const k of Object.keys(c.keyframes) as AnimProp[]) c.keyframes[k] = c.keyframes[k]!.filter((f) => f.t <= rel);
      d.clips.push(second);
    });
    set({ selectedId: second.id });
  },
  splitAll: (t) => {
    const ids = get().project.clips.filter((c) => t > c.start && t < c.start + c.duration).map((c) => c.id);
    ids.forEach((id) => get().splitClip(id, t));
  },

  duplicateClip: (id) => {
    const p = get().project;
    const c = p.clips.find((x) => x.id === id);
    if (!c) return;
    let start = c.start + c.duration;
    let trackId = c.trackId;
    if (overlaps(p, trackId, start, c.duration)) {
      const tr = p.tracks.find((t) => t.kind === p.tracks.find((x) => x.id === c.trackId)!.kind && !overlaps(p, t.id, c.start, c.duration));
      if (tr) { trackId = tr.id; start = c.start; } else start = trackEnd(p, trackId);
    }
    const n = { ...structuredClone(c), id: uid('c_'), start, trackId };
    get().commit((d) => { d.clips.push(n); });
    set({ selectedId: n.id });
  },

  detachAudio: (id) => {
    const p = get().project;
    const c = p.clips.find((x) => x.id === id);
    if (!c || c.type !== 'video') return;
    let tr = p.tracks.find((t) => t.kind === 'audio' && !overlaps(p, t.id, c.start, c.duration));
    const trackId = tr ? tr.id : get().addTrack('audio');
    const a = makeClip({
      trackId, type: 'audio', assetId: c.assetId, name: c.name + ' (audio)', start: c.start, duration: c.duration,
      inPoint: c.inPoint, speed: c.speed, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
    });
    get().commit((d) => {
      d.clips.find((x) => x.id === id)!.muted = true;
      d.clips.push(a);
    });
  },

  addTrack: (kind, top = false) => {
    const id = uid('t_');
    const n = get().project.tracks.filter((t) => t.kind === kind).length + 1;
    get().commit((d) => {
      const tr: Track = { id, kind, name: kind === 'visual' ? `Video ${n}` : `Audio ${n}`, muted: false, hidden: false, locked: false };
      if (kind === 'visual') {
        if (top) d.tracks.unshift(tr);
        else { const i = d.tracks.findIndex((t) => t.kind === 'audio'); d.tracks.splice(i < 0 ? d.tracks.length : i, 0, tr); }
      } else d.tracks.push(tr);
    }, false);
    return id;
  },
  updateTrack: (id, patch) => get().commit((d) => { Object.assign(d.tracks.find((t) => t.id === id)!, patch); }),
  removeTrack: (id) => get().commit((d) => {
    d.tracks = d.tracks.filter((t) => t.id !== id);
    d.clips = d.clips.filter((c) => c.trackId !== id);
  }),

  setKeyframe: (clipId, prop, t, v) => get().updateClip(clipId, (c) => {
    const list = (c.keyframes[prop] ||= []);
    const ex = list.find((k) => Math.abs(k.t - t) < 0.02);
    if (ex) ex.v = v;
    else { list.push({ t, v, ease: 'easeInOut' } as Keyframe); list.sort((a, b) => a.t - b.t); }
  }),
  removeKeyframe: (clipId, prop, t) => get().updateClip(clipId, (c) => {
    c.keyframes[prop] = (c.keyframes[prop] || []).filter((k) => Math.abs(k.t - t) >= 0.02);
    if (!c.keyframes[prop]!.length) delete c.keyframes[prop];
  }),

  addMarker: (t, label = '') => get().commit((d) => {
    d.markers.push({ id: uid('m_'), t, label: label || `M${d.markers.length + 1}`, color: '#ffb02e' });
  }),

  job: (label) => {
    const id = uid('j_');
    set({ jobs: [...get().jobs, { id, label, progress: 0 }] });
    return {
      update: (progress, detail) => set({ jobs: get().jobs.map((j) => (j.id === id ? { ...j, progress, detail } : j)) }),
      done: () => set({ jobs: get().jobs.filter((j) => j.id !== id) }),
    };
  },
  toast: (msg, kind = 'info') => {
    const id = uid();
    set({ toasts: [...get().toasts, { id, msg, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 3500);
  },
}));

export const selectedClip = () => {
  const s = useStore.getState();
  return s.project.clips.find((c) => c.id === s.selectedId) || null;
};

/** run an async task with a progress job + error toast */
export async function runJob<T>(label: string, fn: (update: (p: number, detail?: string) => void) => Promise<T>): Promise<T | undefined> {
  const s = useStore.getState();
  const j = s.job(label);
  try {
    const r = await fn(j.update);
    return r;
  } catch (e) {
    console.error(e);
    useStore.getState().toast(`${label} failed: ${(e as Error).message || e}`, 'error');
    return undefined;
  } finally {
    j.done();
  }
}
