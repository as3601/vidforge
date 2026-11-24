/// <reference lib="webworker" />
// Heavy ML runs here so the editor UI stays smooth. All models are open-source and run locally.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

type Msg =
  | { id: number; task: 'asr'; audio: Float32Array; model: string; language?: string; translate?: boolean; words?: boolean }
  | { id: number; task: 'tts'; text: string; voice: string; speed: number }
  | { id: number; task: 'translate'; texts: string[]; src: string; tgt: string }
  | { id: number; task: 'summarize'; text: string }
  | { id: number; task: 'caption-image'; image: Blob };

const cache = new Map<string, Promise<any>>();
const hasWebGPU = !!(self as any).navigator?.gpu;

function progress(id: number, label: string) {
  return (p: any) => {
    if (p.status === 'progress' && p.total) (self as any).postMessage({ id, type: 'progress', progress: p.loaded / p.total, detail: `Downloading ${label} (${(p.loaded / 1e6).toFixed(0)}/${(p.total / 1e6).toFixed(0)} MB)` });
    else if (p.status === 'ready') (self as any).postMessage({ id, type: 'progress', progress: 1, detail: `${label} ready` });
  };
}

function get(task: string, model: string, id: number, opts: any = {}) {
  const key = task + model;
  if (!cache.has(key)) {
    const load = (o: any) => pipeline(task as any, model, { progress_callback: progress(id, model.split('/').pop()!), ...o });
    // retry transient network failures, and fall back from WebGPU to WASM if GPU init fails
    const p = (async () => {
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const o = attempt === 2 && opts.device === 'webgpu' ? { dtype: 'q8' } : opts;
        try { return await load(o); } catch (err) {
          last = err;
          (self as any).postMessage({ id, type: 'progress', progress: 0, detail: `Retrying model load (${attempt + 1}/3)…` });
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      throw last;
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return cache.get(key)!;
}

let kokoro: Promise<any> | null = null;

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  const post = (data: any, transfer: Transferable[] = []) => (self as any).postMessage({ id: m.id, ...data }, transfer);
  try {
    if (m.task === 'asr') {
      const asr = await get('automatic-speech-recognition', m.model, m.id, hasWebGPU ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } } : { dtype: 'q8' });
      post({ type: 'progress', progress: 0.5, detail: 'Transcribing…' });
      const out = await asr(m.audio, {
        return_timestamps: m.words ? 'word' : true,
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(m.model.endsWith('.en') ? {} : { language: m.language || null, task: m.translate ? 'translate' : 'transcribe' }),
      });
      post({ type: 'done', result: out });
    } else if (m.task === 'tts') {
      if (m.voice.startsWith('mms:')) {
        const tts = await get('text-to-speech', 'Xenova/mms-tts-' + m.voice.slice(4), m.id, { dtype: 'fp32' });
        const out = await tts(m.text);
        post({ type: 'done', result: { audio: out.audio, rate: out.sampling_rate } });
      } else {
        const { KokoroTTS } = await import('kokoro-js');
        kokoro ||= KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'wasm', progress_callback: progress(m.id, 'Kokoro voice') } as any);
        kokoro.catch(() => { kokoro = null; });
        const tts = await kokoro;
        post({ type: 'progress', progress: 0.6, detail: 'Synthesizing speech…' });
        const out = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
        const audio: Float32Array = out.audio instanceof Float32Array ? out.audio : out.data;
        post({ type: 'done', result: { audio, rate: out.sampling_rate } });
      }
    } else if (m.task === 'translate') {
      const tr = await get('translation', 'Xenova/nllb-200-distilled-600M', m.id, { dtype: 'q8' });
      const res: string[] = [];
      for (let i = 0; i < m.texts.length; i++) {
        const o = await tr(m.texts[i], { src_lang: m.src, tgt_lang: m.tgt });
        res.push(o[0].translation_text);
        post({ type: 'progress', progress: (i + 1) / m.texts.length, detail: `Translating ${i + 1}/${m.texts.length}` });
      }
      post({ type: 'done', result: res });
    } else if (m.task === 'summarize') {
      const s = await get('summarization', 'Xenova/distilbart-cnn-6-6', m.id, { dtype: 'q8' });
      const o = await s(m.text.slice(0, 3500), { max_new_tokens: 120 });
      post({ type: 'done', result: o[0].summary_text });
    } else if (m.task === 'caption-image') {
      const cap = await get('image-to-text', 'Xenova/vit-gpt2-image-captioning', m.id, { dtype: 'q8' });
      const url = URL.createObjectURL(m.image);
      const o = await cap(url);
      URL.revokeObjectURL(url);
      post({ type: 'done', result: o[0].generated_text });
    }
  } catch (err) {
    post({ type: 'error', error: (err as Error).message || String(err) });
  }
};
