import type { AnimProp, Clip, Keyframe, Project, Transition } from '../types';
import { clamp, hexToRgb } from '../lib/media';
import { segmentPerson } from '../ai/vision';

export interface SourceProvider {
  /** returns drawable + its intrinsic size, or null if not ready */
  get(clip: Clip): { src: CanvasImageSource; w: number; h: number } | null;
}

export interface RenderOpts { scale: number; maxProc: number; time: number }

// ---------- animation helpers ----------
const EASE: Record<Keyframe['ease'], (x: number) => number> = {
  linear: (x) => x,
  easeIn: (x) => x * x * x,
  easeOut: (x) => 1 - Math.pow(1 - x, 3),
  easeInOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  hold: () => 0,
};

export function animValue(clip: Clip, prop: AnimProp, local: number): number {
  const base = (clip as any)[prop] as number;
  const kf = clip.keyframes[prop];
  if (!kf || !kf.length) return base;
  if (local <= kf[0].t) return kf[0].v;
  const last = kf[kf.length - 1];
  if (local >= last.t) return last.v;
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i], b = kf[i + 1];
    if (local >= a.t && local <= b.t) {
      const x = (local - a.t) / Math.max(1e-6, b.t - a.t);
      return a.v + (b.v - a.v) * EASE[a.ease](x);
    }
  }
  return base;
}

export const sourceTime = (c: Clip, t: number) => c.inPoint + (t - c.start) * c.speed;

/** audio gain for a clip at timeline time t (fades + keyframed volume) */
export function clipGain(c: Clip, t: number) {
  const local = t - c.start;
  let g = animValue(c, 'volume', local);
  if (c.fadeIn > 0 && local < c.fadeIn) g *= local / c.fadeIn;
  if (c.fadeOut > 0 && local > c.duration - c.fadeOut) g *= Math.max(0, (c.duration - local) / c.fadeOut);
  return c.muted ? 0 : Math.max(0, g);
}

function rand(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- canvas pools ----------
const pool = new Map<string, HTMLCanvasElement>();
function canvas(key: string, w: number, h: number) {
  let c = pool.get(key);
  if (!c) { c = document.createElement('canvas'); pool.set(key, c); }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}
const ctx2d = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;

let noiseTile: HTMLCanvasElement | null = null;
function noise() {
  if (noiseTile) return noiseTile;
  noiseTile = document.createElement('canvas');
  noiseTile.width = noiseTile.height = 256;
  const x = noiseTile.getContext('2d')!;
  const id = x.createImageData(256, 256);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = Math.random() * 255;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  x.putImageData(id, 0, 0);
  return noiseTile;
}

// ---------- transitions ----------
interface TState { alpha: number; dx: number; dy: number; scale: number; rot: number; blur: number; clip?: (ctx: CanvasRenderingContext2D, W: number, H: number) => void; flash: number }

function applyTransition(tr: Transition, q: number, dir: 1 | -1, s: TState, W: number, H: number) {
  q = EASE.easeInOut(clamp(q, 0, 1));
  const r = 1 - q;
  switch (tr.type) {
    case 'fade': s.alpha *= q; break;
    case 'slideLeft': s.dx += dir * r * W; break;
    case 'slideRight': s.dx -= dir * r * W; break;
    case 'slideUp': s.dy += dir * r * H; break;
    case 'slideDown': s.dy -= dir * r * H; break;
    case 'zoomIn': s.scale *= 0.2 + 0.8 * q; s.alpha *= q; break;
    case 'zoomOut': s.scale *= 1 + r * 0.8; s.alpha *= q; break;
    case 'wipeLeft': s.clip = (c) => { c.rect(dir > 0 ? 0 : W * r, 0, W * q, H); }; break;
    case 'wipeRight': s.clip = (c) => { c.rect(dir > 0 ? W * r : 0, 0, W * q, H); }; break;
    case 'circle': s.clip = (c) => { c.arc(W / 2, H / 2, (q * Math.hypot(W, H)) / 2, 0, Math.PI * 2); }; break;
    case 'blur': s.blur += r * 40; s.alpha *= Math.min(1, q * 2); break;
    case 'spin': s.rot += dir * r * 270; s.scale *= Math.max(0.01, q); break;
    case 'flash': s.flash = Math.max(s.flash, r); s.alpha *= Math.min(1, q * 3); break;
    // whip pan: fast directional slide with heavy motion blur that peaks mid-move
    case 'whipLeft': s.dx += dir * r * W * 0.9; s.blur += Math.sin(r * Math.PI) * 38 + r * 10; break;
    case 'whipRight': s.dx -= dir * r * W * 0.9; s.blur += Math.sin(r * Math.PI) * 38 + r * 10; break;
    case 'whipUp': s.dy += dir * r * H * 0.9; s.blur += Math.sin(r * Math.PI) * 38 + r * 10; break;
    // zoom-through: incoming shot rushes from huge+blurred to rest; outgoing rushes into the lens
    case 'zoomThrough': s.scale *= dir > 0 ? 1 + r * 1.6 : 1 + r * 2.2; s.blur += r * 32; s.alpha *= Math.min(1, q * 2.5); break;
    case 'glitchIn': { const k = Math.floor(r * 9); s.dx += (k % 2 ? 1 : -1) * r * 70; s.flash = Math.max(s.flash, r > 0.6 ? 0.35 * r : 0); s.alpha *= q > 0.15 ? 1 : q / 0.15; break; }
  }
}

// ---------- processing ----------
function needsProcessing(c: Clip) {
  const f = c.filters;
  return c.chroma.enabled || c.bgMode !== 'none' || (c.effect !== 'none' && c.effect !== 'shake') || f.temperature !== 0 || f.tint !== 0 || f.vignette > 0 || f.sharpen > 0;
}

function chromaKey(img: ImageData, c: Clip) {
  const [kr, kg, kb] = hexToRgb(c.chroma.color);
  const kcb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb;
  const kcr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
  const sim = c.chroma.similarity * 180, sm = Math.max(1, c.chroma.smoothness * 180);
  const d = img.data;
  const greenKey = kg >= kr && kg >= kb;
  const spill = c.chroma.spill;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
    const dist = Math.hypot(cb - kcb, cr - kcr);
    const a = clamp((dist - sim) / sm, 0, 1);
    d[i + 3] = d[i + 3] * a;
    if (spill > 0 && a > 0) {
      if (greenKey) { const m = Math.max(r, b); if (g > m) d[i + 1] = g - (g - m) * spill; }
      else { const m = Math.max(r, g); if (b > m) d[i + 2] = b - (b - m) * spill; }
    }
  }
}

function sharpen(img: ImageData, amt: number) {
  const { width: w, height: h, data: s } = img;
  const src = new Uint8ClampedArray(s);
  const k = amt * 1.5;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = (y * w + x) * 4;
    for (let ch = 0; ch < 3; ch++) {
      const c = src[i + ch];
      const n = src[i - 4 + ch] + src[i + 4 + ch] + src[i - w * 4 + ch] + src[i + w * 4 + ch];
      s[i + ch] = c + k * (4 * c - n);
    }
  }
}

function applyEffect(c: Clip, cv: HTMLCanvasElement, t: number) {
  const x = ctx2d(cv);
  const W = cv.width, H = cv.height, a = c.effectAmount;
  switch (c.effect) {
    case 'pixelate': {
      const block = Math.max(2, (4 + a * 60) * (W / 1280));
      const tw = Math.max(1, Math.round(W / block)), th = Math.max(1, Math.round(H / block));
      const tmp = canvas('pix', tw, th);
      tmp.getContext('2d')!.drawImage(cv, 0, 0, tw, th);
      x.save(); x.imageSmoothingEnabled = false; x.clearRect(0, 0, W, H); x.drawImage(tmp, 0, 0, W, H); x.restore();
      break;
    }
    case 'mirror': {
      x.save(); x.translate(W, 0); x.scale(-1, 1);
      x.drawImage(cv, 0, 0, W / 2, H, 0, 0, W / 2, H); x.restore();
      break;
    }
    case 'kaleido': {
      const tmp = canvas('kal', Math.ceil(W / 2), Math.ceil(H / 2));
      tmp.getContext('2d')!.drawImage(cv, 0, 0, W / 2, H / 2, 0, 0, W / 2, H / 2);
      x.clearRect(0, 0, W, H);
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        x.save(); x.translate(W / 2, H / 2); x.scale(sx, sy); x.drawImage(tmp, -W / 2, -H / 2); x.restore();
      }
      break;
    }
    case 'glitch': {
      const R = rand(Math.floor(t * 14) + 7);
      if (R() > 0.35 + (1 - a) * 0.5) break;
      const tmp = canvas('gl', W, H);
      const tx = tmp.getContext('2d')!; tx.clearRect(0, 0, W, H); tx.drawImage(cv, 0, 0);
      const n = 3 + Math.floor(R() * 8 * a);
      for (let i = 0; i < n; i++) {
        const sy = R() * H, sh = 4 + R() * H * 0.12, off = (R() - 0.5) * W * 0.15 * a;
        x.clearRect(0, sy, W, sh);
        x.drawImage(tmp, 0, sy, W, sh, off, sy, W, sh);
      }
      x.save(); x.globalCompositeOperation = 'lighter'; x.globalAlpha = 0.25 * a;
      x.fillStyle = R() > 0.5 ? '#ff0040' : '#00ffe0'; x.fillRect(0, R() * H, W, 2 + R() * 10); x.restore();
      break;
    }
    case 'rgbSplit':
    case 'vhs': {
      const img = x.getImageData(0, 0, W, H), d = img.data, s = new Uint8ClampedArray(d);
      const off = Math.round((c.effect === 'vhs' ? 3 + a * 6 : 4 + a * 24) * (W / 1280));
      for (let y = 0; y < H; y++) {
        const row = y * W * 4;
        for (let xx = 0; xx < W; xx++) {
          const i = row + xx * 4;
          const l = row + Math.max(0, xx - off) * 4, r = row + Math.min(W - 1, xx + off) * 4;
          d[i] = s[r]; d[i + 2] = s[l + 2];
        }
      }
      x.putImageData(img, 0, 0);
      if (c.effect === 'vhs') {
        x.save(); x.globalCompositeOperation = 'source-atop'; x.globalAlpha = 0.18;
        x.fillStyle = '#000';
        for (let y = 0; y < H; y += 4) x.fillRect(0, y, W, 2);
        x.globalAlpha = 0.15 * a; x.globalCompositeOperation = 'overlay';
        const n = noise(); const R = rand(Math.floor(t * 30));
        x.drawImage(n, R() * 128, R() * 128, 128, 128, 0, 0, W, H);
        x.restore();
      }
      break;
    }
    case 'grain': {
      x.save(); x.globalCompositeOperation = 'overlay'; x.globalAlpha = 0.15 + a * 0.5;
      const n = noise(); const R = rand(Math.floor(t * 24));
      const p = x.createPattern(n, 'repeat')!;
      x.translate(-R() * 256, -R() * 256); x.fillStyle = p; x.fillRect(0, 0, W + 256, H + 256);
      x.restore();
      break;
    }
    case 'posterize': {
      const img = x.getImageData(0, 0, W, H), d = img.data;
      const lv = 2 + Math.round((1 - a) * 6), st = 255 / (lv - 1);
      for (let i = 0; i < d.length; i += 4) { d[i] = Math.round(d[i] / st) * st; d[i + 1] = Math.round(d[i + 1] / st) * st; d[i + 2] = Math.round(d[i + 2] / st) * st; }
      x.putImageData(img, 0, 0);
      break;
    }
    case 'edge': {
      const img = x.getImageData(0, 0, W, H), d = img.data, s = new Uint8ClampedArray(d);
      const L = (i: number) => s[i] * 0.3 + s[i + 1] * 0.59 + s[i + 2] * 0.11;
      for (let y = 1; y < H - 1; y++) for (let xx = 1; xx < W - 1; xx++) {
        const i = (y * W + xx) * 4;
        const gx = L(i + 4) - L(i - 4), gy = L(i + W * 4) - L(i - W * 4);
        const m = Math.min(255, Math.hypot(gx, gy) * (1 + a * 3));
        const o = 255 - m;
        d[i] = d[i + 1] = d[i + 2] = a > 0.5 ? m : o;
      }
      x.putImageData(img, 0, 0);
      break;
    }
  }
}

function process(c: Clip, src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, opts: RenderOpts): HTMLCanvasElement {
  const k = Math.min(1, opts.maxProc / sw);
  const pw = Math.max(2, Math.round(sw * k)), ph = Math.max(2, Math.round(sh * k));
  const cv = canvas('proc_' + c.id, pw, ph);
  const x = ctx2d(cv);
  x.globalCompositeOperation = 'source-over';
  x.globalAlpha = 1;
  x.clearRect(0, 0, pw, ph);
  x.drawImage(src, sx, sy, sw, sh, 0, 0, pw, ph);

  const f = c.filters;
  if (f.sharpen > 0) { const img = x.getImageData(0, 0, pw, ph); sharpen(img, f.sharpen); x.putImageData(img, 0, 0); }

  if (c.bgMode !== 'none') {
    const mask = segmentPerson(cv, c.bgInvert);
    if (mask) {
      const person = canvas('person_' + c.id, pw, ph);
      const px = person.getContext('2d')!;
      px.globalCompositeOperation = 'source-over';
      px.clearRect(0, 0, pw, ph);
      px.drawImage(cv, 0, 0);
      px.globalCompositeOperation = 'destination-in';
      px.imageSmoothingEnabled = true;
      px.drawImage(mask, 0, 0, pw, ph);
      px.globalCompositeOperation = 'source-over';
      if (c.bgMode === 'remove') x.clearRect(0, 0, pw, ph);
      else if (c.bgMode === 'color') { x.fillStyle = c.bgColor; x.fillRect(0, 0, pw, ph); }
      else if (c.bgMode === 'blur') {
        const b = canvas('bgblur', pw, ph); const bx = b.getContext('2d')!;
        bx.filter = `blur(${Math.round(pw / 60)}px)`; bx.drawImage(cv, 0, 0); bx.filter = 'none';
        x.drawImage(b, 0, 0);
      }
      x.drawImage(person, 0, 0);
    }
  }

  if (c.chroma.enabled) { const img = x.getImageData(0, 0, pw, ph); chromaKey(img, c); x.putImageData(img, 0, 0); }

  if (c.effect !== 'none' && c.effect !== 'shake') applyEffect(c, cv, opts.time);

  x.save();
  x.globalCompositeOperation = 'source-atop';
  if (f.temperature) { x.globalAlpha = Math.abs(f.temperature) * 0.28; x.fillStyle = f.temperature > 0 ? '#ff8a00' : '#0077ff'; x.fillRect(0, 0, pw, ph); }
  if (f.tint) { x.globalAlpha = Math.abs(f.tint) * 0.22; x.fillStyle = f.tint > 0 ? '#ff00c8' : '#00ff3c'; x.fillRect(0, 0, pw, ph); }
  if (f.vignette > 0) {
    x.globalAlpha = 1;
    const g = x.createRadialGradient(pw / 2, ph / 2, Math.min(pw, ph) * 0.25, pw / 2, ph / 2, Math.hypot(pw, ph) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${f.vignette})`);
    x.fillStyle = g; x.fillRect(0, 0, pw, ph);
  }
  x.restore();
  return cv;
}

export function cssFilter(c: Clip, extraBlur: number, scale: number) {
  const f = c.filters;
  const parts: string[] = [];
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
  if (f.saturation !== 1) parts.push(`saturate(${f.saturation})`);
  if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
  if (f.grayscale) parts.push(`grayscale(${f.grayscale})`);
  if (f.sepia) parts.push(`sepia(${f.sepia})`);
  if (f.invert) parts.push(`invert(${f.invert})`);
  const b = (f.blur + extraBlur) * scale;
  if (b > 0.1) parts.push(`blur(${b.toFixed(1)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

// ---------- text ----------
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}

function drawText(ctx: CanvasRenderingContext2D, c: Clip, local: number, W: number) {
  const s = c.text!;
  let content = s.uppercase ? s.content.toUpperCase() : s.content;
  ctx.font = `${s.italic ? 'italic ' : ''}${s.bold ? '800 ' : '400 '}${s.size}px "${s.font}", sans-serif`;
  if ('letterSpacing' in ctx) (ctx as any).letterSpacing = `${s.letterSpacing}px`;
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, content, W * s.maxWidth);
  const lh = s.size * s.lineHeight;
  const totalH = lh * lines.length;
  const allWords = content.split(/\s+/).filter(Boolean);
  const nW = allWords.length;
  const span = c.duration * 0.92;
  let visibleChars = Infinity, visibleWords = Infinity, activeWord = -1;
  if (s.animation === 'typewriter') visibleChars = Math.floor((local / Math.min(span, content.length / 18)) * content.length);
  if (s.animation === 'wordByWord') visibleWords = Math.floor((local / span) * nW) + 1;
  if (s.animation === 'karaoke') activeWord = Math.min(nW - 1, Math.floor((local / span) * nW));

  let charCount = 0, wordIdx = 0;
  lines.forEach((line, li) => {
    const y = -totalH / 2 + lh * (li + 0.5);
    const lw = ctx.measureText(line).width;
    const x0 = s.align === 'left' ? -W * s.maxWidth / 2 : s.align === 'right' ? W * s.maxWidth / 2 - lw : -lw / 2;
    if (s.background) {
      ctx.save(); ctx.shadowColor = 'transparent'; ctx.fillStyle = s.background;
      const p = s.bgPadding;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x0 - p, y - lh / 2 - p / 3, lw + p * 2, lh + (p * 2) / 3, p * 0.6);
      else ctx.rect(x0 - p, y - lh / 2, lw + 2 * p, lh);
      ctx.fill(); ctx.restore();
    }
    const words = line.split(' ');
    let x = x0;
    ctx.textAlign = 'left';
    for (let wi = 0; wi < words.length; wi++) {
      let w = words[wi] + (wi < words.length - 1 ? ' ' : '');
      const full = ctx.measureText(w).width;
      if (charCount >= visibleChars || wordIdx >= visibleWords) { charCount += w.length; wordIdx++; x += full; continue; }
      if (charCount + w.length > visibleChars) w = w.slice(0, visibleChars - charCount);
      ctx.save();
      let col = s.color;
      if (activeWord === wordIdx) { col = s.highlightColor; ctx.translate(x + full / 2, y); ctx.scale(1.08, 1.08); ctx.translate(-(x + full / 2), -y); }
      if (s.animation === 'wordByWord' && wordIdx === visibleWords - 1) {
        const p = clamp(((local / span) * nW) % 1 * 3, 0, 1);
        ctx.globalAlpha *= p; ctx.translate(x + full / 2, y); ctx.scale(0.7 + 0.3 * p, 0.7 + 0.3 * p); ctx.translate(-(x + full / 2), -y);
      }
      if (s.shadow > 0) { ctx.shadowColor = s.shadowColor; ctx.shadowBlur = s.shadow; ctx.shadowOffsetY = s.shadow / 4; }
      if (s.strokeWidth > 0) { ctx.lineJoin = 'round'; ctx.lineWidth = s.strokeWidth * 2; ctx.strokeStyle = s.strokeColor; ctx.strokeText(w, x, y); ctx.shadowColor = 'transparent'; }
      ctx.fillStyle = col; ctx.fillText(w, x, y);
      ctx.restore();
      charCount += words[wi].length + 1; wordIdx++; x += full;
    }
  });
}

function textAnim(c: Clip, local: number, st: TState) {
  const a = c.text!.animation, d = c.duration;
  const inT = Math.min(0.45, d / 3), outT = Math.min(0.35, d / 4);
  const qi = clamp(local / inT, 0, 1), qo = clamp((d - local) / outT, 0, 1);
  if (a === 'fade') st.alpha *= Math.min(qi, qo);
  if (a === 'pop') { const e = EASE.easeOut(qi); st.scale *= qi < 1 ? 0.4 + 0.6 * e + Math.sin(qi * Math.PI) * 0.15 : 1; st.alpha *= Math.min(1, qi * 3) * qo; }
  if (a === 'slideUp') { st.dy += (1 - EASE.easeOut(qi)) * 80; st.alpha *= qi * qo; }
  if (a === 'bounce') { st.scale *= 1 + Math.sin(local * 9) * Math.exp(-local * 3) * 0.25; st.alpha *= Math.min(1, qi * 3) * qo; }
  // name-card style: glide in from the side with a soft overshoot, exit the same way
  if (a === 'slideLeft' || a === 'slideRight') {
    const sgn = a === 'slideLeft' ? -1 : 1;
    st.dx += sgn * ((1 - EASE.easeOut(qi)) * 420 + (1 - qo) * 260);
    st.blur += (1 - qi) * 14;
    st.alpha *= Math.min(qi * 1.5, qo);
  }
  // stamp: slams down from big to size with a tiny settle
  if (a === 'stamp') { const e = EASE.easeOut(clamp(local / 0.22, 0, 1)); st.scale *= 1 + (1 - e) * 1.4 - Math.sin(clamp((local - 0.22) / 0.2, 0, 1) * Math.PI) * 0.05; st.alpha *= Math.min(1, local / 0.08) * qo; }
}

// ---------- main ----------
export function renderFrame(ctx: CanvasRenderingContext2D, p: Project, t: number, sources: SourceProvider, opts: RenderOpts) {
  const W = p.width, H = p.height, S = opts.scale;
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = p.background;
  ctx.fillRect(0, 0, W, H);

  const visualTracks = p.tracks.filter((tr) => tr.kind === 'visual' && !tr.hidden).reverse();
  for (const tr of visualTracks) {
    const clips = p.clips.filter((c) => c.trackId === tr.id && t >= c.start && t < c.start + c.duration);
    for (const c of clips) drawClip(ctx, p, c, t, sources, opts);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawClip(ctx: CanvasRenderingContext2D, p: Project, c: Clip, t: number, sources: SourceProvider, opts: RenderOpts) {
  const W = p.width, H = p.height, S = opts.scale;
  const local = t - c.start;
  const st: TState = { alpha: 1, dx: 0, dy: 0, scale: 1, rot: 0, blur: 0, flash: 0 };
  if (c.transitionIn.type !== 'none' && local < c.transitionIn.duration) applyTransition(c.transitionIn, local / c.transitionIn.duration, 1, st, W, H);
  const rem = c.duration - local;
  if (c.transitionOut.type !== 'none' && rem < c.transitionOut.duration) applyTransition(c.transitionOut, rem / c.transitionOut.duration, -1, st, W, H);
  if (c.type === 'text' && c.text) textAnim(c, local, st);

  const x = animValue(c, 'x', local), y = animValue(c, 'y', local);
  const scale = animValue(c, 'scale', local) * st.scale;
  const rot = animValue(c, 'rotation', local) + st.rot;
  const alpha = clamp(animValue(c, 'opacity', local), 0, 1) * st.alpha;
  if (alpha <= 0.001) return;

  let shakeX = 0, shakeY = 0, shakeR = 0;
  if (c.effect === 'shake') {
    const a = c.effectAmount * 40;
    shakeX = Math.sin(t * 47) * a + Math.sin(t * 13) * a * 0.5;
    shakeY = Math.cos(t * 53) * a * 0.7;
    shakeR = Math.sin(t * 31) * c.effectAmount * 1.5;
  }

  ctx.save();
  if (st.clip) { ctx.beginPath(); st.clip(ctx, W, H); ctx.clip(); }
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = c.blend;
  ctx.filter = cssFilter(c, st.blur, S);
  ctx.translate(W / 2 + x + st.dx + shakeX, H / 2 + y + st.dy + shakeY);
  ctx.rotate(((rot + shakeR) * Math.PI) / 180);
  ctx.scale(scale * (c.flipH ? -1 : 1), scale * (c.flipV ? -1 : 1));

  if (c.type === 'text' && c.text) {
    drawText(ctx, c, local, W);
  } else if (c.type === 'solid') {
    // crop turns a solid into bars / lines / panels (letterbox, lower-thirds, HUD accents)
    const cr = c.crop;
    ctx.fillStyle = c.color || '#000';
    ctx.fillRect(-W / 2 + cr.left * W, -H / 2 + cr.top * H, W * (1 - cr.left - cr.right), H * (1 - cr.top - cr.bottom));
  } else {
    const s = sources.get(c);
    if (s) {
      const cr = c.crop;
      const sx = cr.left * s.w, sy = cr.top * s.h;
      const sw = Math.max(1, s.w * (1 - cr.left - cr.right)), sh = Math.max(1, s.h * (1 - cr.top - cr.bottom));
      let dw: number, dh: number;
      if (c.fit === 'stretch') { dw = W; dh = H; }
      else {
        const k = c.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
        dw = sw * k; dh = sh * k;
      }
      if (needsProcessing(c)) {
        const pc = process(c, s.src, sx, sy, sw, sh, opts);
        ctx.drawImage(pc, -dw / 2, -dh / 2, dw, dh);
      } else ctx.drawImage(s.src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    }
  }
  ctx.restore();
  if (st.flash > 0) {
    ctx.save(); ctx.globalAlpha = st.flash * 0.9; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore();
  }
}

/** the on-canvas bounding box (project px, unrotated center/size) used for direct manipulation */
export function clipBox(p: Project, c: Clip, local: number, srcW: number, srcH: number) {
  const W = p.width, H = p.height;
  const cr = c.crop;
  const sw = srcW * (1 - cr.left - cr.right), sh = srcH * (1 - cr.top - cr.bottom);
  let dw = W, dh = H;
  if (c.type !== 'solid' && c.type !== 'text' && c.fit !== 'stretch' && sw > 0 && sh > 0) {
    const k = c.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    dw = sw * k; dh = sh * k;
  }
  const s = animValue(c, 'scale', local);
  return { cx: W / 2 + animValue(c, 'x', local), cy: H / 2 + animValue(c, 'y', local), w: dw * s, h: dh * s, rot: animValue(c, 'rotation', local) };
}
