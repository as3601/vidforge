import { useState } from 'react';
import { useStore, defaultFilters } from '../store';
import type { AnimProp, Clip, EffectType, Filters, TransitionType } from '../types';
import { animValue } from '../engine/compositor';
import { Section, Slider, Select, Color, Toggle, KF, Btn } from './ui';
import { Trash2, Copy, Scissors, Unlink, RotateCcw, FlipHorizontal, FlipVertical, Wand2 } from 'lucide-react';
import { fmtTime } from '../lib/media';
import { autoColor } from '../ai/actions';

const TRANSITIONS: [TransitionType, string][] = [
  ['none', 'None'], ['fade', 'Fade'], ['slideLeft', 'Slide ←'], ['slideRight', 'Slide →'], ['slideUp', 'Slide ↑'], ['slideDown', 'Slide ↓'],
  ['zoomIn', 'Zoom in'], ['zoomOut', 'Zoom out'], ['wipeLeft', 'Wipe ←'], ['wipeRight', 'Wipe →'], ['circle', 'Iris circle'], ['blur', 'Blur'], ['spin', 'Spin'], ['flash', 'Flash'],
  ['whipLeft', 'Whip ←'], ['whipRight', 'Whip →'], ['whipUp', 'Whip ↑'], ['zoomThrough', 'Zoom-through'], ['glitchIn', 'Glitch'],
];
const EFFECTS: [EffectType, string][] = [
  ['none', 'None'], ['glitch', 'Glitch'], ['rgbSplit', 'RGB split'], ['vhs', 'VHS'], ['shake', 'Camera shake'], ['pixelate', 'Pixelate'],
  ['mirror', 'Mirror'], ['kaleido', 'Kaleidoscope'], ['grain', 'Film grain'], ['posterize', 'Posterize'], ['edge', 'Sketch / edges'],
];
const BLENDS: [GlobalCompositeOperation, string][] = [
  ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ['color-dodge', 'Color dodge'], ['color-burn', 'Color burn'], ['hard-light', 'Hard light'], ['soft-light', 'Soft light'], ['difference', 'Difference'],
  ['exclusion', 'Exclusion'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'], ['lighter', 'Add'],
];
export const LOOKS: Record<string, Partial<Filters>> = {
  'Cinematic': { contrast: 1.15, saturation: 0.85, temperature: -0.15, vignette: 0.45, tint: 0.05 },
  'Teal & Orange': { contrast: 1.12, saturation: 1.2, temperature: 0.25, tint: -0.2, hue: -6 },
  'Vintage': { sepia: 0.45, contrast: 0.9, brightness: 1.05, vignette: 0.5, saturation: 0.8 },
  'Noir': { grayscale: 1, contrast: 1.45, brightness: 0.95, vignette: 0.6 },
  'Warm': { temperature: 0.45, saturation: 1.1 },
  'Cool': { temperature: -0.45, brightness: 1.03 },
  'Vivid': { saturation: 1.55, contrast: 1.12 },
  'Faded': { contrast: 0.78, brightness: 1.12, saturation: 0.75 },
  'Cyberpunk': { hue: -25, saturation: 1.6, tint: 0.45, contrast: 1.2 },
  'Matte': { contrast: 0.85, brightness: 1.06, saturation: 0.9, temperature: 0.08 },
};

export function Inspector() {
  const clip = useStore((s) => s.project.clips.find((c) => c.id === s.selectedId));
  const time = useStore((s) => s.time);
  const p = useStore((s) => s.project);
  const [tab, setTab] = useState('basic');
  if (!clip) return <ProjectSettings />;

  const S = useStore.getState;
  const up = (fn: (c: Clip) => void) => S().updateClip(clip.id, fn as any, false);
  const cp = () => S().checkpoint();
  const local = Math.max(0, Math.min(clip.duration, time - clip.start));
  const val = (k: AnimProp) => animValue(clip, k, local);
  const setAnim = (k: AnimProp, v: number) => {
    if (clip.keyframes[k]?.length && time >= clip.start && time <= clip.start + clip.duration) {
      up((c) => {
        const list = c.keyframes[k]!;
        const ex = list.find((f) => Math.abs(f.t - local) < 0.02);
        if (ex) ex.v = v; else { list.push({ t: local, v, ease: 'easeInOut' }); list.sort((a, b) => a.t - b.t); }
      });
    } else up((c) => { (c as any)[k] = v; });
  };
  const visual = clip.type !== 'audio';
  const media = clip.type === 'video' || clip.type === 'image';
  const hasAudio = clip.type === 'video' || clip.type === 'audio';
  const tabs = [
    ['basic', clip.type === 'text' ? 'Text' : 'Basic'],
    ...(visual ? [['color', 'Color'], ['fx', 'Effects']] : []),
    ['anim', 'Animate'],
    ...(hasAudio ? [['audio', 'Audio']] : []),
  ];
  const t = tabs.some(([k]) => k === tab) ? tab : 'basic';

  return (
    <div className="inspector">
      <div className="insp-head">
        <input className="clip-name" value={clip.name} onFocus={cp} onChange={(e) => up((c) => { c.name = e.target.value; })} />
        <div className="insp-actions">
          <button title="Split at playhead (S)" onClick={() => S().splitClip(clip.id, time)}><Scissors size={14} /></button>
          <button title="Duplicate (Ctrl+D)" onClick={() => S().duplicateClip(clip.id)}><Copy size={14} /></button>
          {clip.type === 'video' && <button title="Detach audio" onClick={() => S().detachAudio(clip.id)}><Unlink size={14} /></button>}
          <button title="Delete (Del)" onClick={() => S().deleteClip(clip.id)}><Trash2 size={14} /></button>
        </div>
      </div>
      <div className="meta">{clip.type.toUpperCase()} · {fmtTime(clip.start, p.fps)} → {fmtTime(clip.start + clip.duration, p.fps)} · {clip.duration.toFixed(2)}s</div>
      <div className="tabs small">
        {tabs.map(([k, l]) => <button key={k} className={t === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div className="insp-body">
        {t === 'basic' && clip.type === 'text' && <TextEditor clip={clip} up={up} cp={cp} />}
        {t === 'basic' && clip.type === 'solid' && <Section title="Fill"><Color label="Color" value={clip.color || '#000'} onChange={(v) => { cp(); up((c) => { c.color = v; }); }} /></Section>}
        {t === 'basic' && visual && (
          <Section title="Transform" right={<button className="icon" title="Reset" onClick={() => { cp(); up((c) => { c.x = 0; c.y = 0; c.scale = 1; c.rotation = 0; c.opacity = 1; c.keyframes = {}; }); }}><RotateCcw size={12} /></button>}>
            <Slider label="X" value={val('x')} min={-p.width} max={p.width} step={1} onStart={cp} onChange={(v) => setAnim('x', v)} kf={<KF clip={clip} prop="x" value={val('x')} />} />
            <Slider label="Y" value={val('y')} min={-p.height} max={p.height} step={1} onStart={cp} onChange={(v) => setAnim('y', v)} kf={<KF clip={clip} prop="y" value={val('y')} />} />
            <Slider label="Scale" value={val('scale')} min={0.05} max={5} onStart={cp} onChange={(v) => setAnim('scale', v)} kf={<KF clip={clip} prop="scale" value={val('scale')} />} />
            <Slider label="Rotate" value={val('rotation')} min={-360} max={360} step={0.5} onStart={cp} onChange={(v) => setAnim('rotation', v)} kf={<KF clip={clip} prop="rotation" value={val('rotation')} />} />
            <Slider label="Opacity" value={val('opacity')} min={0} max={1} onStart={cp} onChange={(v) => setAnim('opacity', v)} kf={<KF clip={clip} prop="opacity" value={val('opacity')} />} />
            <div className="row btns">
              <Btn small active={clip.flipH} onClick={() => { cp(); up((c) => { c.flipH = !c.flipH; }); }}><FlipHorizontal size={13} /> Flip H</Btn>
              <Btn small active={clip.flipV} onClick={() => { cp(); up((c) => { c.flipV = !c.flipV; }); }}><FlipVertical size={13} /> Flip V</Btn>
            </div>
            {media && <Select label="Fit" value={clip.fit} options={[['contain', 'Fit'], ['cover', 'Fill (crop)'], ['stretch', 'Stretch']]} onChange={(v) => { cp(); up((c) => { c.fit = v; }); }} />}
            <div className="row"><span className="lbl">Position</span><div className="align-grid">
              {[['↖', -1, -1], ['↑', 0, -1], ['↗', 1, -1], ['←', -1, 0], ['•', 0, 0], ['→', 1, 0], ['↙', -1, 1], ['↓', 0, 1], ['↘', 1, 1]].map(([l, ax, ay]) => (
                <button key={l as string} className="align" title="Snap position" onClick={() => { cp(); up((c) => { c.x = (ax as number) * p.width * 0.3; c.y = (ay as number) * p.height * 0.35; c.keyframes.x = undefined; c.keyframes.y = undefined; delete c.keyframes.x; delete c.keyframes.y; }); }}>{l}</button>
              ))}
            </div></div>
          </Section>
        )}
        {t === 'basic' && media && (
          <Section title="Crop" open={false}>
            {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
              <Slider key={k} label={k[0].toUpperCase() + k.slice(1)} value={clip.crop[k]} min={0} max={0.9} onStart={cp} onChange={(v) => up((c) => { c.crop[k] = v; })} fmt={(v) => Math.round(v * 100) + '%'} />
            ))}
          </Section>
        )}
        {t === 'basic' && (clip.type === 'video' || clip.type === 'audio') && (
          <Section title="Speed">
            <Slider label="Speed" value={clip.speed} min={0.1} max={8} onStart={cp} onChange={(v) => {
              const a = S().assets[clip.assetId!];
              up((c) => { const src = c.duration * c.speed; c.speed = v; c.duration = Math.min(src, (a.duration - c.inPoint)) / v; });
            }} fmt={(v) => v.toFixed(2) + '×'} />
            <div className="row btns">{[0.25, 0.5, 1, 1.5, 2, 4].map((v) => <Btn small key={v} active={clip.speed === v} onClick={() => {
              cp(); const a = S().assets[clip.assetId!];
              up((c) => { const src = c.duration * c.speed; c.speed = v; c.duration = Math.min(src, a.duration - c.inPoint) / v; });
            }}>{v}×</Btn>)}</div>
          </Section>
        )}
        {t === 'basic' && (
          <Section title="Timing" open={false}>
            <Slider label="Start" value={clip.start} min={0} max={Math.max(60, clip.start + 30)} step={0.01} onStart={cp} onChange={(v) => up((c) => { c.start = Math.max(0, v); })} fmt={(v) => fmtTime(v, p.fps)} />
            {(clip.type === 'text' || clip.type === 'image' || clip.type === 'solid') && <Slider label="Duration" value={clip.duration} min={0.1} max={120} onStart={cp} onChange={(v) => up((c) => { c.duration = Math.max(0.1, v); })} />}
          </Section>
        )}

        {t === 'color' && <ColorTab clip={clip} up={up} cp={cp} />}
        {t === 'fx' && <FxTab clip={clip} up={up} cp={cp} />}

        {t === 'anim' && (
          <>
            {(['transitionIn', 'transitionOut'] as const).map((k) => (
              <Section key={k} title={k === 'transitionIn' ? 'In transition' : 'Out transition'}>
                <div className="chip-grid">
                  {TRANSITIONS.map(([v, l]) => <button key={v} className={'chip' + (clip[k].type === v ? ' on' : '')} onClick={() => { cp(); up((c) => { c[k].type = v; }); }}>{l}</button>)}
                </div>
                <Slider label="Duration" value={clip[k].duration} min={0.1} max={Math.max(0.2, Math.min(3, clip.duration / 2))} onStart={cp} onChange={(v) => up((c) => { c[k].duration = v; })} fmt={(v) => v.toFixed(2) + 's'} />
              </Section>
            ))}
            <Section title="Quick motion presets">
              <div className="chip-grid">
                {([
                  ['Ken Burns in', { scale: [[0, 1], [1, 1.25]] }, false],
                  ['Ken Burns out', { scale: [[0, 1.25], [1, 1]] }, false],
                  ['Pan left→right', { x: [[0, -120], [1, 120]], scale: [[0, 1.2], [1, 1.2]] }, false],
                  ['Pan right→left', { x: [[0, 120], [1, -120]], scale: [[0, 1.2], [1, 1.2]] }, false],
                  ['Pulse', { scale: [[0, 1], [0.25, 1.08], [0.5, 1], [0.75, 1.08], [1, 1]] }, false],
                  ['Pop in', { scale: [[0, 0], [0.25, 1.1], [0.4, 1]] }, true],
                  ['Spin in', { rotation: [[0, -180], [0.5, 0]], scale: [[0, 0.2], [0.5, 1]] }, true],
                  ['Drop in', { y: [[0, -p.height], [0.45, 0]] }, true],
                ] as [string, Record<string, number[][]>, boolean][]).map(([l, spec, abs]) => (
                  <button key={l} className="chip" onClick={() => {
                    cp();
                    up((c) => {
                      for (const [prop, pts] of Object.entries(spec)) {
                        c.keyframes[prop as AnimProp] = pts.map(([f, v]) => ({ t: abs ? Math.min(f, c.duration) : f * c.duration, v, ease: 'easeInOut' as const }));
                      }
                    });
                  }}>{l}</button>
                ))}
                <button className="chip danger" onClick={() => { cp(); up((c) => { c.keyframes = {}; }); }}>Clear all keyframes</button>
              </div>
            </Section>
            <Section title="Keyframes">
              {Object.entries(clip.keyframes).filter(([, l]) => l?.length).length === 0 && <div className="hint">Click the ◆ next to any property to keyframe it at the playhead. Move the playhead, change the value → animation.</div>}
              {Object.entries(clip.keyframes).map(([prop, list]) => list && list.length > 0 && (
                <div key={prop} className="kf-list">
                  <b>{prop}</b>
                  {list.map((k, i) => (
                    <span key={i} className="kf-item">
                      <button onClick={() => useStore.getState().set({ time: clip.start + k.t })}>{k.t.toFixed(2)}s = {k.v.toFixed(2)}</button>
                      <select value={k.ease} onChange={(e) => { cp(); up((c) => { c.keyframes[prop as AnimProp]![i].ease = e.target.value as any; }); }}>
                        {['linear', 'easeInOut', 'easeIn', 'easeOut', 'hold'].map((x) => <option key={x}>{x}</option>)}
                      </select>
                    </span>
                  ))}
                </div>
              ))}
            </Section>
          </>
        )}

        {t === 'audio' && (
          <Section title="Audio">
            <Toggle label="Mute" value={clip.muted} onChange={(v) => { cp(); up((c) => { c.muted = v; }); }} />
            <Slider label="Volume" value={val('volume')} min={0} max={1} onStart={cp} onChange={(v) => setAnim('volume', v)} fmt={(v) => Math.round(v * 100) + '%'} kf={<KF clip={clip} prop="volume" value={val('volume')} />} />
            <Slider label="Fade in" value={clip.fadeIn} min={0} max={Math.min(10, clip.duration)} onStart={cp} onChange={(v) => up((c) => { c.fadeIn = v; })} fmt={(v) => v.toFixed(1) + 's'} />
            <Slider label="Fade out" value={clip.fadeOut} min={0} max={Math.min(10, clip.duration)} onStart={cp} onChange={(v) => up((c) => { c.fadeOut = v; })} fmt={(v) => v.toFixed(1) + 's'} />
            <div className="hint">Ducking tip: keyframe Volume down under voice-overs. More audio AI (denoise, normalize, voice changer) is in Tools.</div>
          </Section>
        )}
      </div>
    </div>
  );
}

function ColorTab({ clip, up, cp }: { clip: Clip; up: (fn: (c: Clip) => void) => void; cp: () => void }) {
  const f = clip.filters;
  const set = (k: keyof Filters) => (v: number) => up((c) => { c.filters[k] = v; });
  return (
    <>
      <Section title="Looks / LUT presets">
        <div className="chip-grid">
          {Object.entries(LOOKS).map(([n, l]) => <button key={n} className="chip" onClick={() => { cp(); up((c) => { c.filters = { ...defaultFilters(), ...l }; }); }}>{n}</button>)}
          {clip.type === 'video' && <button className="chip ai" onClick={() => autoColor(clip.id)}><Wand2 size={11} /> AI auto-enhance</button>}
          <button className="chip danger" onClick={() => { cp(); up((c) => { c.filters = defaultFilters(); }); }}>Reset</button>
        </div>
      </Section>
      <Section title="Light">
        <Slider label="Brightness" value={f.brightness} min={0} max={2} onStart={cp} onChange={set('brightness')} />
        <Slider label="Contrast" value={f.contrast} min={0} max={2} onStart={cp} onChange={set('contrast')} />
        <Slider label="Vignette" value={f.vignette} min={0} max={1} onStart={cp} onChange={set('vignette')} />
        <Slider label="Sharpen" value={f.sharpen} min={0} max={1} onStart={cp} onChange={set('sharpen')} />
        <Slider label="Blur" value={f.blur} min={0} max={40} step={0.5} onStart={cp} onChange={set('blur')} />
      </Section>
      <Section title="Color">
        <Slider label="Saturation" value={f.saturation} min={0} max={3} onStart={cp} onChange={set('saturation')} />
        <Slider label="Temperature" value={f.temperature} min={-1} max={1} onStart={cp} onChange={set('temperature')} />
        <Slider label="Tint" value={f.tint} min={-1} max={1} onStart={cp} onChange={set('tint')} />
        <Slider label="Hue" value={f.hue} min={-180} max={180} step={1} onStart={cp} onChange={set('hue')} />
        <Slider label="Grayscale" value={f.grayscale} min={0} max={1} onStart={cp} onChange={set('grayscale')} />
        <Slider label="Sepia" value={f.sepia} min={0} max={1} onStart={cp} onChange={set('sepia')} />
        <Slider label="Invert" value={f.invert} min={0} max={1} onStart={cp} onChange={set('invert')} />
      </Section>
    </>
  );
}

function FxTab({ clip, up, cp }: { clip: Clip; up: (fn: (c: Clip) => void) => void; cp: () => void }) {
  const media = clip.type === 'video' || clip.type === 'image';
  return (
    <>
      <Section title="Effect">
        <div className="chip-grid">
          {EFFECTS.map(([v, l]) => <button key={v} className={'chip' + (clip.effect === v ? ' on' : '')} onClick={() => { cp(); up((c) => { c.effect = v; }); }}>{l}</button>)}
        </div>
        {clip.effect !== 'none' && <Slider label="Intensity" value={clip.effectAmount} min={0} max={1} onStart={cp} onChange={(v) => up((c) => { c.effectAmount = v; })} />}
      </Section>
      {media && (
        <Section title="AI background (person segmentation)">
          <div className="chip-grid">
            {([['none', 'Off'], ['remove', 'Remove'], ['blur', 'Blur bg'], ['color', 'Color bg']] as const).map(([v, l]) => (
              <button key={v} className={'chip' + (clip.bgMode === v ? ' on' : '') + (v !== 'none' ? ' ai' : '')} onClick={() => { cp(); up((c) => { c.bgMode = v; }); }}>{l}</button>
            ))}
          </div>
          {clip.bgMode === 'color' && <Color label="Bg color" value={clip.bgColor} onChange={(v) => up((c) => { c.bgColor = v; })} />}
          {clip.bgMode !== 'none' && <Toggle label="Invert mask" value={clip.bgInvert} onChange={(v) => up((c) => { c.bgInvert = v; })} />}
          <div className="hint">Runs Google MediaPipe locally on your GPU. First use downloads a ~250 KB model. Put the cut-out over another video track for a virtual set.</div>
        </Section>
      )}
      {media && (
        <Section title="Chroma key (green screen)" open={clip.chroma.enabled}>
          <Toggle label="Enabled" value={clip.chroma.enabled} onChange={(v) => { cp(); up((c) => { c.chroma.enabled = v; }); }} />
          <Color label="Key color" value={clip.chroma.color} onChange={(v) => up((c) => { c.chroma.color = v; })} />
          <Slider label="Similarity" value={clip.chroma.similarity} min={0} max={1} onStart={cp} onChange={(v) => up((c) => { c.chroma.similarity = v; })} />
          <Slider label="Smoothness" value={clip.chroma.smoothness} min={0} max={0.5} onStart={cp} onChange={(v) => up((c) => { c.chroma.smoothness = v; })} />
          <Slider label="Spill" value={clip.chroma.spill} min={0} max={1} onStart={cp} onChange={(v) => up((c) => { c.chroma.spill = v; })} />
        </Section>
      )}
      <Section title="Blend mode">
        <Select value={clip.blend} options={BLENDS} onChange={(v) => { cp(); up((c) => { c.blend = v; }); }} />
      </Section>
    </>
  );
}

const FONTS = ['Montserrat', 'Inter', 'Poppins', 'Anton', 'Bebas Neue', 'Playfair Display', 'Pacifico', 'Roboto Mono', 'Impact', 'Georgia', 'Arial'];

function TextEditor({ clip, up, cp }: { clip: Clip; up: (fn: (c: Clip) => void) => void; cp: () => void }) {
  const s = clip.text!;
  const set = <K extends keyof typeof s>(k: K) => (v: (typeof s)[K]) => up((c) => { (c.text as any)[k] = v; if (k === 'content') c.name = String(v).slice(0, 40); });
  return (
    <>
      <Section title="Content">
        <textarea className="ta" value={s.content} rows={3} onFocus={cp} onChange={(e) => set('content')(e.target.value)} />
        <Select label="Font" value={s.font} options={FONTS.map((f) => [f, f] as [string, string])} onChange={(v) => { cp(); set('font')(v); }} />
        <Slider label="Size" value={s.size} min={8} max={400} step={1} onStart={cp} onChange={set('size')} />
        <Color label="Color" value={s.color} onChange={set('color')} />
        <div className="row btns">
          <Btn small active={s.bold} onClick={() => { cp(); set('bold')(!s.bold); }}><b>B</b></Btn>
          <Btn small active={s.italic} onClick={() => { cp(); set('italic')(!s.italic); }}><i>I</i></Btn>
          <Btn small active={s.uppercase} onClick={() => { cp(); set('uppercase')(!s.uppercase); }}>AA</Btn>
          {(['left', 'center', 'right'] as const).map((a) => <Btn small key={a} active={s.align === a} onClick={() => { cp(); set('align')(a); }}>{a}</Btn>)}
        </div>
        <Slider label="Wrap width" value={s.maxWidth} min={0.1} max={1} onStart={cp} onChange={set('maxWidth')} />
        <Slider label="Spacing" value={s.letterSpacing} min={-5} max={40} step={0.5} onStart={cp} onChange={set('letterSpacing')} />
        <Slider label="Line height" value={s.lineHeight} min={0.7} max={2.5} onStart={cp} onChange={set('lineHeight')} />
      </Section>
      <Section title="Text animation">
        <div className="chip-grid">
          {(['none', 'fade', 'pop', 'slideUp', 'bounce', 'typewriter', 'wordByWord', 'karaoke', 'slideLeft', 'slideRight', 'stamp'] as const).map((a) => (
            <button key={a} className={'chip' + (s.animation === a ? ' on' : '')} onClick={() => { cp(); set('animation')(a); }}>{a}</button>
          ))}
        </div>
        {s.animation === 'karaoke' && <Color label="Highlight" value={s.highlightColor} onChange={set('highlightColor')} />}
      </Section>
      <Section title="Stroke, shadow & box">
        <Slider label="Stroke" value={s.strokeWidth} min={0} max={30} step={0.5} onStart={cp} onChange={set('strokeWidth')} />
        <Color label="Stroke color" value={s.strokeColor} onChange={set('strokeColor')} />
        <Slider label="Shadow" value={s.shadow} min={0} max={60} step={1} onStart={cp} onChange={set('shadow')} />
        <Color label="Shadow color" value={s.shadowColor} onChange={set('shadowColor')} />
        <Color label="Box" value={s.background} onChange={set('background')} />
        <div className="row btns"><Btn small onClick={() => { cp(); set('background')(s.background ? '' : 'rgba(0,0,0,0.65)'); }}>{s.background ? 'Remove box' : 'Add box'}</Btn></div>
        <Slider label="Box padding" value={s.bgPadding} min={0} max={80} step={1} onStart={cp} onChange={set('bgPadding')} />
      </Section>
    </>
  );
}

function ProjectSettings() {
  const p = useStore((s) => s.project);
  const S = useStore.getState;
  const ratios: [string, number, number][] = [['16:9 YouTube', 1920, 1080], ['9:16 Reels/TikTok/Shorts', 1080, 1920], ['1:1 Square', 1080, 1080], ['4:5 Instagram', 1080, 1350], ['4:3 Classic', 1440, 1080], ['21:9 Cinema', 2560, 1080], ['4K UHD', 3840, 2160], ['720p', 1280, 720]];
  return (
    <div className="inspector">
      <div className="insp-head"><input className="clip-name" value={p.name} onFocus={() => S().checkpoint()} onChange={(e) => S().commit((d) => { d.name = e.target.value; }, false)} /></div>
      <div className="meta">Project · {p.width}×{p.height} · {p.fps} fps · {p.clips.length} clips</div>
      <div className="insp-body">
        <Section title="Canvas / aspect ratio">
          <div className="chip-grid">
            {ratios.map(([l, w, h]) => <button key={l} className={'chip' + (p.width === w && p.height === h ? ' on' : '')} onClick={() => S().commit((d) => { d.width = w; d.height = h; })}>{l}</button>)}
          </div>
          <Select label="Frame rate" value={String(p.fps)} options={[['24', '24 fps (film)'], ['25', '25 fps'], ['30', '30 fps'], ['50', '50 fps'], ['60', '60 fps']]} onChange={(v) => S().commit((d) => { d.fps = +v; })} />
          <Color label="Background" value={p.background} onChange={(v) => S().commit((d) => { d.background = v; }, false)} />
        </Section>
        <Section title="Tips">
          <div className="hint">
            • Drag media from the library onto the timeline, or double-click to append.<br />
            • Select a clip to edit it here. Drag on the preview to move it, scroll to scale.<br />
            • <b>Space</b> play · <b>S</b> split · <b>Del</b> delete · <b>Shift+Del</b> ripple delete · <b>Ctrl+D</b> duplicate · <b>Ctrl+Z/Y</b> undo/redo · <b>M</b> marker · <b>←/→</b> frame step · <b>Ctrl+C/V</b> copy/paste · <b>+/-</b> zoom
          </div>
        </Section>
      </div>
    </div>
  );
}
