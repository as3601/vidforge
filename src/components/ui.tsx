import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Diamond } from 'lucide-react';
import { useStore } from '../store';
import type { AnimProp, Clip } from '../types';

export function Section({ title, children, open = true, right }: { title: string; children: ReactNode; open?: boolean; right?: ReactNode }) {
  const [o, setO] = useState(open);
  return (
    <div className="section">
      <div className="section-h" onClick={() => setO(!o)}>
        {o ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{title}</span>
        <div style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>{right}</div>
      </div>
      {o && <div className="section-b">{children}</div>}
    </div>
  );
}

export function Slider({ label, value, min, max, step = 0.01, onChange, onStart, fmt, kf }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; onStart?: () => void; fmt?: (v: number) => string; kf?: ReactNode;
}) {
  return (
    <label className="row slider">
      <span className="lbl">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onPointerDown={onStart} onChange={(e) => onChange(+e.target.value)} />
      <input className="num" type="number" step={step} value={+value.toFixed(3)} onFocus={onStart}
        onChange={(e) => onChange(+e.target.value)} />
      {fmt && <span className="unit">{fmt(value)}</span>}
      {kf}
    </label>
  );
}

export function Select<T extends string>({ label, value, options, onChange }: { label?: string; value: T; options: [T, string][] | readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <label className="row">
      {label && <span className="lbl">{label}</span>}
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

export function Color({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return (
    <label className="row">
      <span className="lbl">{label}</span>
      <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} />
      <input className="txt" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row toggle">
      <span className="lbl">{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="sw" />
    </label>
  );
}

/** keyframe diamond: filled when a keyframe exists at the playhead */
export function KF({ clip, prop, value }: { clip: Clip; prop: AnimProp; value: number }) {
  const time = useStore((s) => s.time);
  const local = time - clip.start;
  const list = clip.keyframes[prop] || [];
  const on = list.some((k) => Math.abs(k.t - local) < 0.02);
  const has = list.length > 0;
  const inside = local >= 0 && local <= clip.duration;
  return (
    <button className={'kf' + (on ? ' on' : has ? ' has' : '')} title={on ? 'Remove keyframe' : 'Add keyframe at playhead'} disabled={!inside}
      onClick={() => on ? useStore.getState().removeKeyframe(clip.id, prop, local) : useStore.getState().setKeyframe(clip.id, prop, local, value)}>
      <Diamond size={11} />
    </button>
  );
}

export function Btn({ children, onClick, title, primary, small, disabled, active }: { children: ReactNode; onClick?: () => void; title?: string; primary?: boolean; small?: boolean; disabled?: boolean; active?: boolean }) {
  return <button className={`btn${primary ? ' primary' : ''}${small ? ' small' : ''}${active ? ' active' : ''}`} title={title} onClick={onClick} disabled={disabled}>{children}</button>;
}
