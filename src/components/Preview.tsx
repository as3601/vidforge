import { useEffect, useRef, useState } from 'react';
import { useStore, projectDuration } from '../store';
import type { AnimProp, Clip, Project } from '../types';
import { engine } from '../engine/player';
import { clipBox } from '../engine/compositor';
import { fmtTime, download } from '../lib/media';
import { snapshotPng } from '../engine/exporter';
import { Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, Maximize, Camera, Grid3x3, Repeat } from 'lucide-react';

function setAnimated(clip: Clip, prop: AnimProp, v: number, time: number) {
  const local = time - clip.start;
  useStore.getState().updateClip(clip.id, (c) => {
    const list = c.keyframes[prop];
    if (list?.length) {
      const ex = list.find((f) => Math.abs(f.t - local) < 0.02);
      if (ex) ex.v = v; else { list.push({ t: local, v, ease: 'easeInOut' }); list.sort((a, b) => a.t - b.t); }
    } else (c as any)[prop] = v;
  }, false);
}

const measureCtx = document.createElement('canvas').getContext('2d')!;
function boxFor(p: Project, c: Clip, t: number) {
  const local = t - c.start;
  if (c.type === 'text' && c.text) {
    const s = c.text;
    measureCtx.font = `${s.italic ? 'italic ' : ''}${s.bold ? '800 ' : '400 '}${s.size}px "${s.font}", sans-serif`;
    const maxW = p.width * s.maxWidth;
    const lines: string[] = [];
    for (const para of (s.uppercase ? s.content.toUpperCase() : s.content).split('\n')) {
      let line = '';
      for (const w of para.split(/\s+/).filter(Boolean)) { const tt = line ? line + ' ' + w : w; if (measureCtx.measureText(tt).width > maxW && line) { lines.push(line); line = w; } else line = tt; }
      lines.push(line);
    }
    const w = Math.max(20, ...lines.map((l) => measureCtx.measureText(l).width)) + s.bgPadding * 2;
    const b = clipBox(p, c, local, 1, 1);
    const sc = b.w / p.width;
    return { ...b, w: w * sc, h: lines.length * s.size * s.lineHeight * sc };
  }
  const a = c.assetId ? useStore.getState().assets[c.assetId] : undefined;
  return clipBox(p, c, local, a?.width || p.width, a?.height || p.height);
}

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const project = useStore((s) => s.project);
  const time = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  const selectedId = useStore((s) => s.selectedId);
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [quality, setQuality] = useState(0.5);
  const [guides, setGuides] = useState(false);
  const [loop, setLoop] = useState(false);
  const S = useStore.getState;

  useEffect(() => { engine.attach(canvasRef.current); return () => engine.attach(null); }, []);
  useEffect(() => { engine.quality = quality; engine.invalidate(); }, [quality]);
  useEffect(() => {
    if (loop && !playing && time >= projectDuration(project) - 0.01 && projectDuration(project) > 0) { engine.seek(0); engine.play(); }
  }, [playing, loop]);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const ar = project.width / project.height;
      let w = r.width - 16, h = w / ar;
      if (h > r.height - 16) { h = r.height - 16; w = h * ar; }
      setSize({ w: Math.max(50, w), h: Math.max(30, h) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height]);

  const k = size.w / project.width;
  const sel = project.clips.find((c) => c.id === selectedId && c.type !== 'audio' && time >= c.start && time < c.start + c.duration);
  const box = sel ? boxFor(project, sel, time) : null;

  const toProject = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  const pick = (e: React.PointerEvent) => {
    const pt = toProject(e);
    const p = S().project;
    const vis = p.tracks.filter((t) => t.kind === 'visual' && !t.hidden && !t.locked);
    for (const tr of vis) {
      const cs = p.clips.filter((c) => c.trackId === tr.id && time >= c.start && time < c.start + c.duration);
      for (const c of cs) {
        const b = boxFor(p, c, time);
        if (Math.abs(pt.x - b.cx) < b.w / 2 && Math.abs(pt.y - b.cy) < b.h / 2) { S().set({ selectedId: c.id }); startMove(e, c); return; }
      }
    }
    S().set({ selectedId: null });
  };

  const startMove = (e: React.PointerEvent, c: Clip) => {
    e.stopPropagation();
    const p0 = toProject(e);
    const b0 = boxFor(S().project, c, time);
    const ox = b0.cx - S().project.width / 2, oy = b0.cy - S().project.height / 2;
    let started = false;
    const mv = (ev: PointerEvent) => {
      const p1 = toProject(ev);
      if (!started) { S().checkpoint(); started = true; }
      let nx = ox + p1.x - p0.x, ny = oy + p1.y - p0.y;
      if (Math.abs(nx) < 12 / k) nx = 0; // snap to center
      if (Math.abs(ny) < 12 / k) ny = 0;
      const cur = S().project.clips.find((x) => x.id === c.id)!;
      setAnimated(cur, 'x', Math.round(nx), S().time);
      setAnimated(S().project.clips.find((x) => x.id === c.id)!, 'y', Math.round(ny), S().time);
    };
    const upF = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upF); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', upF);
  };

  const startScale = (e: React.PointerEvent, c: Clip) => {
    e.stopPropagation();
    S().checkpoint();
    const b = boxFor(S().project, c, time);
    const d0 = Math.hypot(toProject(e).x - b.cx, toProject(e).y - b.cy);
    const s0 = c.keyframes.scale?.length ? b.w / (boxFor(S().project, { ...c, keyframes: { ...c.keyframes, scale: undefined }, scale: 1 }, time).w || 1) : c.scale;
    const mv = (ev: PointerEvent) => {
      const p1 = toProject(ev);
      const d = Math.hypot(p1.x - b.cx, p1.y - b.cy);
      setAnimated(S().project.clips.find((x) => x.id === c.id)!, 'scale', Math.max(0.02, +(s0 * (d / d0)).toFixed(3)), S().time);
    };
    const upF = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upF); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', upF);
  };

  const startRotate = (e: React.PointerEvent, c: Clip) => {
    e.stopPropagation();
    S().checkpoint();
    const b = boxFor(S().project, c, time);
    const mv = (ev: PointerEvent) => {
      const p1 = toProject(ev);
      let deg = (Math.atan2(p1.y - b.cy, p1.x - b.cx) * 180) / Math.PI + 90;
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
      setAnimated(S().project.clips.find((x) => x.id === c.id)!, 'rotation', +deg.toFixed(1), S().time);
    };
    const upF = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upF); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', upF);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!sel) return;
    const cur = sel;
    S().checkpoint();
    const local = time - cur.start;
    const base = cur.keyframes.scale?.length ? cur.keyframes.scale.reduce((a, kf) => (Math.abs(kf.t - local) < Math.abs(a.t - local) ? kf : a)).v : cur.scale;
    setAnimated(cur, 'scale', Math.max(0.02, +(base * (e.deltaY < 0 ? 1.05 : 1 / 1.05)).toFixed(3)), time);
  };

  const dur = projectDuration(project);
  const step = (n: number) => engine.seek(Math.max(0, Math.round(S().time * project.fps + n) / project.fps));

  return (
    <div className="preview">
      <div className="stage" ref={wrapRef}>
        <div className="canvas-wrap" style={{ width: size.w, height: size.h }} onPointerDown={pick} onWheel={onWheel}>
          <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} />
          {guides && <div className="guides"><div className="safe" /><div className="third v1" /><div className="third v2" /><div className="third h1" /><div className="third h2" /></div>}
          {box && sel && (
            <div className="sel-box" style={{ left: (box.cx - box.w / 2) * k, top: (box.cy - box.h / 2) * k, width: box.w * k, height: box.h * k, transform: `rotate(${box.rot}deg)` }}
              onPointerDown={(e) => startMove(e, sel)}>
              {['tl', 'tr', 'bl', 'br'].map((h) => <div key={h} className={'h ' + h} onPointerDown={(e) => startScale(e, sel)} />)}
              <div className="rot" onPointerDown={(e) => startRotate(e, sel)} />
            </div>
          )}
        </div>
      </div>
      <div className="transport">
        <button title="Start (Home)" onClick={() => engine.seek(0)}><SkipBack size={16} /></button>
        <button title="Previous frame (←)" onClick={() => step(-1)}><ChevronLeft size={18} /></button>
        <button className="play" title="Play/Pause (Space)" onClick={() => engine.toggle()}>{playing ? <Pause size={20} /> : <Play size={20} />}</button>
        <button title="Next frame (→)" onClick={() => step(1)}><ChevronRight size={18} /></button>
        <button title="End (End)" onClick={() => engine.seek(dur)}><SkipForward size={16} /></button>
        <button title="Loop" className={loop ? 'on' : ''} onClick={() => setLoop(!loop)}><Repeat size={15} /></button>
        <span className="readout">{fmtTime(time, project.fps)} <span className="dim">/ {fmtTime(dur, project.fps)}</span></span>
        <div style={{ flex: 1 }} />
        <select value={quality} onChange={(e) => setQuality(+e.target.value)} title="Preview resolution">
          <option value={0.25}>Preview ¼</option><option value={0.5}>Preview ½</option><option value={1}>Preview Full</option>
        </select>
        <button title="Safe area & thirds" className={guides ? 'on' : ''} onClick={() => setGuides(!guides)}><Grid3x3 size={15} /></button>
        <button title="Save frame as PNG" onClick={async () => download(await snapshotPng(S().project, S().assets, S().time), `frame_${S().time.toFixed(2)}.png`)}><Camera size={15} /></button>
        <button title="Fullscreen" onClick={() => wrapRef.current?.requestFullscreen()}><Maximize size={15} /></button>
      </div>
    </div>
  );
}
