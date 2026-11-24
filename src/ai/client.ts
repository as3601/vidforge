let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; onProgress?: (p: number, d?: string) => void }>();

function w() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, type } = e.data;
    const p = pending.get(id);
    if (!p) return;
    if (type === 'progress') p.onProgress?.(e.data.progress, e.data.detail);
    else if (type === 'done') { pending.delete(id); p.res(e.data.result); }
    else if (type === 'error') { pending.delete(id); p.rej(new Error(e.data.error)); }
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.rej(new Error(e.message || 'AI worker crashed')); pending.clear(); worker = null; };
  return worker;
}

export function aiCall<T = any>(msg: Record<string, any>, onProgress?: (p: number, d?: string) => void, transfer: Transferable[] = []): Promise<T> {
  const id = ++seq;
  return new Promise<T>((res, rej) => {
    pending.set(id, { res, rej, onProgress });
    w().postMessage({ ...msg, id }, transfer);
  });
}

export interface AsrChunk { text: string; timestamp: [number, number | null] }
export const transcribe = (audio: Float32Array, opts: { model: string; language?: string; translate?: boolean; words?: boolean }, onP?: (p: number, d?: string) => void) =>
  aiCall<{ text: string; chunks: AsrChunk[] }>({ task: 'asr', audio, ...opts }, onP, [audio.buffer]);

export const synthesize = (text: string, voice: string, speed: number, onP?: (p: number, d?: string) => void) =>
  aiCall<{ audio: Float32Array; rate: number }>({ task: 'tts', text, voice, speed }, onP);

export const translateTexts = (texts: string[], src: string, tgt: string, onP?: (p: number, d?: string) => void) =>
  aiCall<string[]>({ task: 'translate', texts, src, tgt }, onP);

export const summarize = (text: string, onP?: (p: number, d?: string) => void) => aiCall<string>({ task: 'summarize', text }, onP);

export const captionImage = (image: Blob, onP?: (p: number, d?: string) => void) => aiCall<string>({ task: 'caption-image', image }, onP);
