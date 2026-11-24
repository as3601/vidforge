import { memo, useEffect, useRef, useState } from 'react';
import { useStore, projectDuration, overlaps } from '../store';
import type { Clip, MediaAsset, Track } from '../types';
import { engine } from '../engine/player';
import { fmtTime } from '../lib/media';
import { Eye, EyeOff, Volume2, VolumeX, Lock, Unlock, Trash2, Plus, Scissors, Undo2, Redo2, Magnet, ZoomIn, ZoomOut, Bookmark, Film, Music } from 'lucide-react';

const HEAD_W = 168;
const ROW_H: Record<string, number> = { visual: 58, audio: 46 };

export function Timeline() {
  const project = useStore((s) => s.project);
  const zoom = useStore((s) => s.zoom);
  const snapping = useStore((s) => s.snapping);
  const selectedId = useStore((s) => s.selectedId);
  const assets = useStore((s) => s.assets);
  const scroller = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(1000);
  const S = useStore.getState;

  useEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left - HEAD_W + el.scrollLeft;
      const tAt = x / S().zoom;
      const nz = Math.max(4, Math.min(600, S().zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      S().set({ zoom: nz });
      requestAnimationFrame(() => { el.scrollLeft = tAt * nz - (e.clientX - rect.left - HEAD_W); });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener('wheel', wheel); };
  }, []);

  const dur = projectDuration(project);
  const width = Math.max(dur + 20, (viewW - HEAD_W) / zoom) * zoom;

  const seekFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const el = scroller.current!;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left - HEAD_W + el.scrollLeft;
    engine.seek(Math.max(0, x / S().zoom));
  };
  const startScrub = (e: React.PointerEvent) => {
    seekFromEvent(e);
    const mv = (ev: PointerEvent) => seekFromEvent(ev);
    const upF = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upF); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', upF);
  };

  const fit = () => {
    const d = Math.max(5, projectDuration(S().project));
    S().set({ zoom: Math.max(4, (viewW - HEAD_W - 40) / d) });
    scroller.current!.scrollLeft = 0;
  };

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <button title="Undo (Ctrl+Z)" onClick={() => S().undo()}><Undo2 size={15} /></button>
        <button title="Redo (Ctrl+Y)" onClick={() => S().redo()}><Redo2 size={15} /></button>
        <span className="sep" />
        <button title="Split selected at playhead (S) — Shift+S splits all tracks" onClick={() => selectedId ? S().splitClip(selectedId, S().time) : S().splitAll(S().time)}><Scissors size={15} /> Split</button>
        <button title="Delete (Del)" disabled={!selectedId} onClick={() => selectedId && S().deleteClip(selectedId)}><Trash2 size={15} /></button>
        <button title="Add marker (M)" onClick={() => S().addMarker(S().time)}><Bookmark size={15} /></button>
        <button title="Snapping" className={snapping ? 'on' : ''} onClick={() => S().set({ snapping: !snapping })}><Magnet size={15} /></button>
        <span className="sep" />
        <button title="Add video track" onClick={() => S().addTrack('visual', true)}><Plus size={13} /><Film size={13} /></button>
        <button title="Add audio track" onClick={() => S().addTrack('audio')}><Plus size={13} /><Music size={13} /></button>
        <div style={{ flex: 1 }} />
        <TimeReadout />
        <div style={{ flex: 1 }} />
        <button title="Zoom out (-)" onClick={() => S().set({ zoom: Math.max(4, zoom / 1.4) })}><ZoomOut size={15} /></button>
        <input type="range" min={4} max={600} value={zoom} onChange={(e) => S().set({ zoom: +e.target.value })} style={{ width: 110 }} />
        <button title="Zoom in (+)" onClick={() => S().set({ zoom: Math.min(600, zoom * 1.4) })}><ZoomIn size={15} /></button>
        <button onClick={fit} title="Fit project">Fit</button>
      </div>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-inner" style={{ width: width + HEAD_W }}>
          <div className="tl-ruler-row">
            <div className="tl-corner" style={{ width: HEAD_W }} />
            <Ruler width={width} zoom={zoom} onPointerDown={startScrub} />
          </div>
          {project.tracks.map((tr) => (
            <TrackRow key={tr.id} track={tr} clips={project.clips.filter((c) => c.trackId === tr.id)} zoom={zoom} width={width} selectedId={selectedId} assets={assets} scroller={scroller} />
          ))}
          <Playhead zoom={zoom} scroller={scroller} />
          {project.markers.map((m) => (
            <div key={m.id} className="marker-line" style={{ left: HEAD_W + m.t * zoom, borderColor: m.color }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TimeReadout() {
  const time = useStore((s) => s.time);
  const fps = useStore((s) => s.project.fps);
  const dur = useStore((s) => projectDuration(s.project));
  return <span className="readout">{fmtTime(time, fps)} <span className="dim">/ {fmtTime(dur, fps)}</span></span>;
}

const Ruler = memo(function Ruler({ width, zoom, onPointerDown }: { width: number; zoom: number; onPointerDown: (e: React.PointerEvent) => void }) {
  const markers = useStore((s) => s.project.markers);
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const major = steps.find((s) => s * zoom >= 80) ?? 600;
  const ticks = [];
  for (let t = 0; t * zoom < width; t += major) {
    ticks.push(<div key={t} className="tick" style={{ left: t * zoom }}><span>{fmtTime(t, 30, major < 1)}</span></div>);
    for (let k = 1; k < 5; k++) ticks.push(<div key={t + '_' + k} className="tick minor" style={{ left: (t + (major * k) / 5) * zoom }} />);
  }
  return (
    <div className="tl-ruler" style={{ width }} onPointerDown={onPointerDown}>
      {ticks}
      {markers.map((m) => (
        <div key={m.id} className="marker" style={{ left: m.t * zoom, background: m.color }} title={`${m.label} – double-click to delete`}
          onPointerDown={(e) => { e.stopPropagation(); engine.seek(m.t); }}
          onDoubleClick={() => useStore.getState().commit((d) => { d.markers = d.markers.filter((x) => x.id !== m.id); })}>
          <span>{m.label}</span>
        </div>
      ))}
    </div>
  );
});

function Playhead({ zoom, scroller }: { zoom: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const time = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = time * zoom;
    const vis = el.clientWidth - HEAD_W;
    if (x > el.scrollLeft + vis - 40 || x < el.scrollLeft) el.scrollLeft = x - 60;
  }, [time, playing, zoom]);
  return <div className="playhead" style={{ left: HEAD_W + time * zoom }}><div className="ph-head" /></div>;
}

function TrackRow({ track, clips, zoom, width, selectedId, assets, scroller }: {
  track: Track; clips: Clip[]; zoom: number; width: number; selectedId: string | null; assets: Record<string, MediaAsset>; scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const S = useStore.getState;
  const h = ROW_H[track.kind];
  const [over, setOver] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    setOver(false);
    const id = e.dataTransfer.getData('vf/asset');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const a = S().assets[id];
    if (!a) return;
    const el = scroller.current!;
    const rect = el.getBoundingClientRect();
    const t = Math.max(0, (e.clientX - rect.left - HEAD_W + el.scrollLeft) / S().zoom);
    const kindOk = (a.kind === 'audio') === (track.kind === 'audio');
    const dur = a.kind === 'image' ? 5 : a.duration;
    if (kindOk && !overlaps(S().project, track.id, t, dur)) S().addClipFromAsset(a, { start: t, trackId: track.id });
    else S().addClipFromAsset(a, { start: t });
  };
  return (
    <div className={'tl-row ' + track.kind + (track.hidden ? ' hidden' : '')} style={{ height: h }}>
      <div className="tl-head" style={{ width: HEAD_W }}>
        <input className="tname" value={track.name} onChange={(e) => S().updateTrack(track.id, { name: e.target.value })} />
        <div className="ticons">
          {track.kind === 'visual'
            ? <button title="Hide" onClick={() => S().updateTrack(track.id, { hidden: !track.hidden })}>{track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
            : null}
          <button title="Mute" onClick={() => S().updateTrack(track.id, { muted: !track.muted })}>{track.muted ? <VolumeX size={13} className="warn" /> : <Volume2 size={13} />}</button>
          <button title="Lock" onClick={() => S().updateTrack(track.id, { locked: !track.locked })}>{track.locked ? <Lock size={13} className="warn" /> : <Unlock size={13} />}</button>
          <button title="Delete track" onClick={() => { if (!clips.length || confirm(`Delete track "${track.name}" and its ${clips.length} clips?`)) S().removeTrack(track.id); }}><Trash2 size={13} /></button>
        </div>
      </div>
      <div className={'tl-lane' + (over ? ' over' : '')} style={{ width }} data-track={track.id}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('vf/asset')) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onPointerDown={(e) => { if (e.target === e.currentTarget) { S().set({ selectedId: null }); } }}>
        {clips.map((c) => <ClipView key={c.id} clip={c} zoom={zoom} h={h} selected={c.id === selectedId} asset={c.assetId ? assets[c.assetId] : undefined} locked={track.locked} scroller={scroller} />)}
      </div>
    </div>
  );
}

function snapTime(t: number, ignoreId: string, zoom: number) {
  const s = useStore.getState();
  if (!s.snapping) return { t, snapped: false };
  const thr = 8 / zoom;
  const cands = [0, s.time, ...s.project.markers.map((m) => m.t)];
  for (const c of s.project.clips) if (c.id !== ignoreId) cands.push(c.start, c.start + c.duration);
  let best = t, bd = thr;
  for (const c of cands) { const d = Math.abs(c - t); if (d < bd) { bd = d; best = c; } }
  return { t: best, snapped: best !== t };
}

const ClipView = memo(function ClipView({ clip, zoom, h, selected, asset, locked, scroller }: {
  clip: Clip; zoom: number; h: number; selected: boolean; asset?: MediaAsset; locked: boolean; scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const S = useStore.getState;
  const left = clip.start * zoom;
  const w = Math.max(2, clip.duration * zoom);

  const drag = (e: React.PointerEvent, mode: 'move' | 'l' | 'r') => {
    e.stopPropagation();
    if (e.button !== 0) return;
    S().set({ selectedId: clip.id });
    if (locked) return;
    const x0 = e.clientX;
    const orig = { ...clip };
    let moved = false;
    const kind = S().project.tracks.find((t) => t.id === clip.trackId)!.kind;
    const maxSrc = asset && asset.kind !== 'image' ? asset.duration : Infinity;
    const mv = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / S().zoom;
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (!moved) { S().checkpoint(); moved = true; }
      const p = S().project;
      if (mode === 'move') {
        let start = Math.max(0, orig.start + dt);
        const a = snapTime(start, clip.id, S().zoom);
        const b = snapTime(start + orig.duration, clip.id, S().zoom);
        if (a.snapped) start = a.t; else if (b.snapped) start = b.t - orig.duration;
        start = Math.max(0, start);
        // track under pointer
        let trackId = S().project.clips.find((c) => c.id === clip.id)!.trackId;
        const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-track]') as HTMLElement | null;
        if (el) {
          const tid = el.dataset.track!;
          const tr = p.tracks.find((t) => t.id === tid);
          if (tr && tr.kind === kind && !tr.locked) trackId = tid;
        }
        if (!overlaps(p, trackId, start, orig.duration, clip.id)) S().updateClip(clip.id, (c) => { c.start = start; c.trackId = trackId; }, false);
      } else if (mode === 'l') {
        const end = orig.start + orig.duration;
        let ns = snapTime(orig.start + dt, clip.id, S().zoom).t;
        const minByMedia = isFinite(maxSrc) ? orig.start - orig.inPoint / orig.speed : -Infinity;
        const prev = p.clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id && c.start + c.duration <= orig.start + 1e-4).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
        ns = Math.max(ns, minByMedia, prev, 0);
        ns = Math.min(ns, end - 0.05);
        S().updateClip(clip.id, (c) => {
          c.start = ns; c.duration = end - ns;
          if (isFinite(maxSrc) || c.type === 'video' || c.type === 'audio') c.inPoint = Math.max(0, orig.inPoint + (ns - orig.start) * orig.speed);
        }, false);
      } else {
        let ne = snapTime(orig.start + orig.duration + dt, clip.id, S().zoom).t;
        const maxByMedia = isFinite(maxSrc) ? orig.start + (maxSrc - orig.inPoint) / orig.speed : Infinity;
        const next = p.clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id && c.start >= orig.start + orig.duration - 1e-4).reduce((m, c) => Math.min(m, c.start), Infinity);
        ne = Math.min(ne, maxByMedia, next);
        ne = Math.max(ne, orig.start + 0.05);
        S().updateClip(clip.id, (c) => { c.duration = ne - orig.start; }, false);
      }
      // auto-scroll near edges
      const sc = scroller.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (ev.clientX > r.right - 30) sc.scrollLeft += 12; else if (ev.clientX < r.left + HEAD_W + 30) sc.scrollLeft -= 12;
      }
    };
    const upF = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upF); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', upF);
  };

  const label = clip.type === 'text' ? '𝐓 ' + (clip.text?.content || '') : clip.name;
  const kfTimes = [...new Set(Object.values(clip.keyframes).flatMap((l) => (l || []).map((k) => +k.t.toFixed(2))))];

  return (
    <div className={`clip ${clip.type}${selected ? ' sel' : ''}${clip.muted ? ' muted' : ''}`} style={{ left, width: w, height: h - 6 }}
      onPointerDown={(e) => drag(e, 'move')}
      onContextMenu={(e) => { e.preventDefault(); S().set({ selectedId: clip.id }); }}
      onDoubleClick={() => engine.seek(clip.start)}>
      {clip.type === 'video' && asset?.filmstrip && <Filmstrip clip={clip} asset={asset} w={w} h={h - 6} />}
      {clip.type === 'image' && asset?.thumbnail && <div className="thumbs" style={{ backgroundImage: `url(${asset.thumbnail})` }} />}
      {clip.type === 'solid' && <div className="thumbs" style={{ background: clip.color }} />}
      {asset?.waveform && (clip.type === 'audio' || (clip.type === 'video' && asset.hasAudio)) && (
        <Wave peaks={asset.waveform} dur={asset.duration} from={clip.inPoint} len={clip.duration * clip.speed} w={w} h={clip.type === 'audio' ? h - 22 : 16} />
      )}
      <div className="clip-label">{clip.speed !== 1 && <b>{clip.speed}× </b>}{label}</div>
      {clip.transitionIn.type !== 'none' && <div className="tr-in" style={{ width: clip.transitionIn.duration * zoom }} title={'In: ' + clip.transitionIn.type} />}
      {clip.transitionOut.type !== 'none' && <div className="tr-out" style={{ width: clip.transitionOut.duration * zoom }} title={'Out: ' + clip.transitionOut.type} />}
      {clip.fadeIn > 0 && <div className="fade-in" style={{ width: clip.fadeIn * zoom }} />}
      {clip.fadeOut > 0 && <div className="fade-out" style={{ width: clip.fadeOut * zoom }} />}
      {kfTimes.map((t) => <div key={t} className="kfdot" style={{ left: t * zoom - 4 }} />)}
      {(clip.bgMode !== 'none' || clip.chroma.enabled) && <div className="badge">AI</div>}
      <div className="handle l" onPointerDown={(e) => drag(e, 'l')} />
      <div className="handle r" onPointerDown={(e) => drag(e, 'r')} />
    </div>
  );
});

function Filmstrip({ clip, asset, w, h }: { clip: Clip; asset: MediaAsset; w: number; h: number }) {
  const tw = Math.max(20, (h * asset.width) / Math.max(1, asset.height));
  const n = Math.min(80, Math.ceil(w / tw));
  const fs = asset.filmstrip!;
  return (
    <div className="thumbs strip">
      {Array.from({ length: n }, (_, i) => {
        const st = clip.inPoint + ((i + 0.5) * tw / w) * clip.duration * clip.speed;
        const idx = Math.max(0, Math.min(fs.length - 1, Math.floor((st / asset.duration) * fs.length)));
        return <img key={i} src={fs[idx]} style={{ width: tw, height: h }} draggable={false} />;
      })}
    </div>
  );
}

const Wave = memo(function Wave({ peaks, dur, from, len, w, h }: { peaks: number[]; dur: number; from: number; len: number; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const cw = Math.min(8000, Math.max(1, Math.round(w)));
    c.width = cw; c.height = h * 2;
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, cw, h * 2);
    x.fillStyle = 'rgba(255,255,255,0.55)';
    const i0 = (from / dur) * peaks.length, i1 = ((from + len) / dur) * peaks.length;
    for (let px = 0; px < cw; px++) {
      const a = Math.floor(i0 + ((i1 - i0) * px) / cw), b = Math.max(a + 1, Math.floor(i0 + ((i1 - i0) * (px + 1)) / cw));
      let m = 0; for (let i = a; i < b && i < peaks.length; i++) m = Math.max(m, peaks[i] || 0);
      const ph = Math.max(1, m * h * 2 * 0.95);
      x.fillRect(px, h - ph / 2, 1, ph);
    }
  }, [peaks, dur, from, len, w, h]);
  return <canvas ref={ref} className="wave" style={{ width: w, height: h }} />;
});
