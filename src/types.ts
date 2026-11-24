export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  url: string; // object URL (runtime only)
  blob: Blob;
  duration: number; // seconds (images: Infinity-like default 5)
  width: number;
  height: number;
  hasAudio: boolean;
  thumbnail?: string; // data URL
  filmstrip?: string[]; // data URLs
  waveform?: number[]; // normalized peaks 0..1
}

export type TrackKind = 'visual' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
}

export type ClipType = 'video' | 'audio' | 'image' | 'text' | 'solid';

export type AnimProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume';

export interface Keyframe {
  t: number; // seconds relative to clip start
  v: number;
  ease: 'linear' | 'easeInOut' | 'easeIn' | 'easeOut' | 'hold';
}

export type TransitionType =
  | 'none' | 'fade' | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown'
  | 'zoomIn' | 'zoomOut' | 'wipeLeft' | 'wipeRight' | 'circle' | 'blur' | 'spin' | 'flash'
  | 'whipLeft' | 'whipRight' | 'whipUp' | 'zoomThrough' | 'glitchIn';

export interface Transition { type: TransitionType; duration: number }

export interface Filters {
  brightness: number; // 1 = neutral
  contrast: number;
  saturation: number;
  hue: number; // degrees
  blur: number; // px
  grayscale: number; // 0..1
  sepia: number;
  invert: number;
  temperature: number; // -1..1
  tint: number; // -1..1
  vignette: number; // 0..1
  sharpen: number; // 0..1
}

export type EffectType = 'none' | 'pixelate' | 'shake' | 'mirror' | 'glitch' | 'grain' | 'rgbSplit' | 'vhs' | 'kaleido' | 'posterize' | 'edge';

export interface TextStyle {
  content: string;
  font: string;
  size: number; // px at project resolution
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  strokeColor: string;
  strokeWidth: number;
  shadow: number; // blur px
  shadowColor: string;
  background: string; // '' = none
  bgPadding: number;
  letterSpacing: number;
  lineHeight: number;
  uppercase: boolean;
  animation: 'none' | 'fade' | 'typewriter' | 'pop' | 'slideUp' | 'bounce' | 'wordByWord' | 'karaoke' | 'slideLeft' | 'slideRight' | 'stamp';
  highlightColor: string;
  maxWidth: number; // fraction of canvas width
}

export interface Clip {
  id: string;
  trackId: string;
  type: ClipType;
  assetId?: string;
  name: string;
  start: number;
  duration: number;
  inPoint: number;
  speed: number;
  volume: number;
  muted: boolean;
  fadeIn: number;
  fadeOut: number;
  x: number; // offset from center, project px
  y: number;
  scale: number; // 1 = fit (contain)
  rotation: number; // deg
  opacity: number;
  flipH: boolean;
  flipV: boolean;
  fit: 'contain' | 'cover' | 'stretch';
  crop: { top: number; right: number; bottom: number; left: number }; // fractions
  filters: Filters;
  effect: EffectType;
  effectAmount: number; // 0..1
  blend: GlobalCompositeOperation;
  chroma: { enabled: boolean; color: string; similarity: number; smoothness: number; spill: number };
  bgMode: 'none' | 'remove' | 'blur' | 'color';
  bgColor: string;
  bgInvert: boolean;
  transitionIn: Transition;
  transitionOut: Transition;
  keyframes: Partial<Record<AnimProp, Keyframe[]>>;
  text?: TextStyle;
  color?: string; // solid clips
  reverse?: boolean;
}

export interface Marker { id: string; t: number; label: string; color: string }

export interface Project {
  name: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
}
