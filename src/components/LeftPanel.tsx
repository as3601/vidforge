import { useRef, useState } from 'react';
import { useStore, runJob } from '../store';
import type { MediaAsset } from '../types';
import { createAsset, fmtTime } from '../lib/media';
import { Section, Slider, Select, Btn, Toggle } from './ui';
import { FF_TOOLS } from '../lib/ffmpeg';
import { CAPTION_STYLES, autoCaptions, translateCaptionTrack, summarizeText, removeSilence, splitScenes, beatMarkers, cutToBeats, autoColor, autoReframe, textToSpeech, generateImage, describeFrame, freezeFrame, applyFFTool } from '../ai/actions';
import { loadSegmenter } from '../ai/vision';
import { Upload, Film, Music, Image as ImageIcon, Trash2, Type, Sparkles, Wrench, Shapes, Video, Monitor, Mic, Square, Wand2 } from 'lucide-react';

export async function importFiles(files: FileList | File[]) {
  const arr = Array.from(files);
  await runJob(`Importing ${arr.length} file(s)`, async (up) => {
    for (let i = 0; i < arr.length; i++) {
      up(i / arr.length, arr[i].name);
      try { useStore.getState().addAsset(await createAsset(arr[i])); }
      catch (e) { useStore.getState().toast(`${arr[i].name}: ${(e as Error).message}`, 'error'); }
    }
  });
}

export function LeftPanel() {
  const tab = useStore((s) => s.leftTab);
  const set = useStore((s) => s.set);
  const tabs: [string, string, any][] = [['media', 'Media', Film], ['text', 'Text', Type], ['elements', 'Elements', Shapes], ['ai', 'AI Studio', Sparkles], ['tools', 'Tools', Wrench]];
  return (
    <div className="left">
      <div className="vtabs">
        {tabs.map(([k, l, I]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => set({ leftTab: k })}><I size={18} /><span>{l}</span></button>)}
      </div>
      <div className="left-body">
        {tab === 'media' && <MediaTab />}
        {tab === 'text' && <TextTab />}
        {tab === 'elements' && <ElementsTab />}
        {tab === 'ai' && <AiTab />}
        {tab === 'tools' && <ToolsTab />}
      </div>
    </div>
  );
}

function MediaTab() {
  const assets = useStore((s) => s.assets);
  const input = useRef<HTMLInputElement>(null);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const list = Object.values(assets);

  const record = async (kind: 'screen' | 'camera' | 'mic') => {
    try {
      const stream = kind === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true })
        : await navigator.mediaDevices.getUserMedia(kind === 'camera' ? { video: { width: 1920, height: 1080 }, audio: true } : { audio: true });
      const mime = kind === 'mic' ? 'audio/webm' : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm');
      const r = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRec(null);
        const blob = new Blob(chunks, { type: mime.split(';')[0] });
        await importFiles([new File([blob], `${kind} ${new Date().toLocaleTimeString().replace(/:/g, '-')}.webm`, { type: blob.type })]);
      };
      stream.getVideoTracks()[0]?.addEventListener('ended', () => r.state !== 'inactive' && r.stop());
      r.start(500);
      setRec(r);
    } catch (e) { useStore.getState().toast('Recording failed: ' + (e as Error).message, 'error'); }
  };

  return (
    <div className="pane">
      <input ref={input} type="file" multiple accept="video/*,audio/*,image/*,.mkv,.mov" hidden onChange={(e) => { if (e.target.files) importFiles(e.target.files); e.target.value = ''; }} />
      <button className="dropzone" onClick={() => input.current?.click()}>
        <Upload size={22} />
        <b>Import media</b>
        <span>Click or drop video, audio & images anywhere</span>
      </button>
      <div className="row btns rec">
        {rec ? <Btn primary onClick={() => rec.stop()}><Square size={12} /> Stop recording</Btn> : <>
          <Btn small onClick={() => record('screen')}><Monitor size={13} /> Screen</Btn>
          <Btn small onClick={() => record('camera')}><Video size={13} /> Camera</Btn>
          <Btn small onClick={() => record('mic')}><Mic size={13} /> Voice</Btn>
        </>}
      </div>
      {list.length === 0 && <div className="empty">No media yet. Import files, record, or generate with AI Studio.</div>}
      <div className="asset-grid">
        {list.map((a) => <AssetCard key={a.id} a={a} />)}
      </div>
    </div>
  );
}

function AssetCard({ a }: { a: MediaAsset }) {
  const S = useStore.getState;
  const Icon = a.kind === 'video' ? Film : a.kind === 'audio' ? Music : ImageIcon;
  return (
    <div className="asset" draggable onDragStart={(e) => { e.dataTransfer.setData('vf/asset', a.id); e.dataTransfer.effectAllowed = 'copy'; }}
      onDoubleClick={() => S().addClipFromAsset(a)} title="Drag to timeline or double-click to append">
      <div className="asset-thumb" style={a.thumbnail ? { backgroundImage: `url(${a.thumbnail})` } : undefined}>
        {a.kind === 'audio' && <AudioThumb peaks={a.waveform} />}
        <span className="kind"><Icon size={11} /></span>
        {a.kind !== 'image' && <span className="dur">{fmtTime(a.duration, 30, false)}</span>}
        <button className="del" title="Remove from project" onClick={(e) => { e.stopPropagation(); if (confirm(`Remove "${a.name}" and all its clips?`)) S().removeAsset(a.id); }}><Trash2 size={11} /></button>
        <button className="add" title="Add at playhead" onClick={(e) => { e.stopPropagation(); S().addClipFromAsset(a, { start: S().time }); }}>+</button>
      </div>
      <div className="asset-name">{a.name}</div>
    </div>
  );
}

function AudioThumb({ peaks }: { peaks?: number[] }) {
  if (!peaks) return null;
  const n = 40, step = Math.max(1, Math.floor(peaks.length / n));
  return <div className="athumb">{Array.from({ length: n }, (_, i) => <i key={i} style={{ height: `${10 + (peaks[i * step] || 0) * 85}%` }} />)}</div>;
}

const TEXT_PRESETS: { label: string; content: string; style: any; y?: number }[] = [
  { label: 'Big Title', content: 'BIG TITLE', style: { font: 'Bebas Neue', bold: false, size: 220, animation: 'pop', letterSpacing: 6 } },
  { label: 'Subtitle', content: 'A subtitle goes here', style: { font: 'Inter', bold: false, size: 64, animation: 'fade' }, y: 0.12 },
  { label: 'Lower third', content: 'Jane Doe\nFounder & CEO', style: { font: 'Montserrat', size: 52, align: 'left', background: 'rgba(15,15,25,0.8)', animation: 'slideUp', maxWidth: 0.4 }, y: 0.33 },
  { label: 'Elegant', content: 'Once upon a time', style: { font: 'Playfair Display', bold: false, italic: true, size: 110, animation: 'fade' } },
  { label: 'Handwritten', content: 'Summer vibes', style: { font: 'Pacifico', bold: false, size: 120, color: '#ffe066', animation: 'bounce' } },
  { label: 'Typewriter', content: 'Loading the future…', style: { font: 'Roboto Mono', bold: false, size: 64, animation: 'typewriter', shadow: 0 } },
  { label: 'Impact meme', content: 'WHEN THE CODE WORKS', style: { font: 'Anton', bold: false, size: 120, strokeWidth: 8, strokeColor: '#000', uppercase: true }, y: -0.36 },
  { label: 'Neon sign', content: 'OPEN 24/7', style: { font: 'Poppins', size: 140, color: '#ff4fd8', shadow: 40, shadowColor: '#ff00c8', animation: 'fade' } },
];

function TextTab() {
  const S = useStore.getState;
  const add = (content: string, style: any, y = 0) => {
    const id = S().addTextClip(content, style);
    if (y) S().updateClip(id, (c) => { c.y = y * S().project.height; }, false);
  };
  return (
    <div className="pane">
      <Btn primary onClick={() => add('Your Text', {})}><Type size={14} /> Add text</Btn>
      <Section title="Title presets">
        <div className="preset-grid">
          {TEXT_PRESETS.map((p) => (
            <button key={p.label} className="tpreset" onClick={() => add(p.content, p.style, p.y)}
              style={{ fontFamily: `"${p.style.font}"`, color: p.style.color || '#fff', fontStyle: p.style.italic ? 'italic' : 'normal', textShadow: p.style.shadow ? `0 0 8px ${p.style.shadowColor || '#000'}` : undefined }}>
              {p.label}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Caption styles">
        <div className="preset-grid">
          {Object.entries(CAPTION_STYLES).map(([k, v]) => (
            <button key={k} className="tpreset" style={{ fontFamily: `"${v.style.font}"` }} onClick={() => add('caption text here', { ...v.style, size: Math.round(S().project.height * 0.06) }, 0.32)}>{v.label}</button>
          ))}
        </div>
        <div className="hint">Want them generated from speech automatically? Use AI Studio → Auto captions.</div>
      </Section>
    </div>
  );
}

const STICKERS = ['🔥', '😂', '❤️', '👍', '✨', '🎉', '😎', '🚀', '💯', '👀', '⚡', '🎬', '⭐', '💥', '🤯', '👉', '✅', '❌', '🎵', '📍'];
const COLORS = ['#000000', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#1c1c1e'];

function ElementsTab() {
  const S = useStore.getState;
  return (
    <div className="pane">
      <Section title="Stickers / emoji">
        <div className="sticker-grid">
          {STICKERS.map((s) => <button key={s} onClick={() => { const id = S().addTextClip(s, { size: 220, shadow: 0, animation: 'pop', font: 'Inter' }); S().updateClip(id, (c) => { c.name = 'Sticker ' + s; }, false); }}>{s}</button>)}
        </div>
      </Section>
      <Section title="Color solids / backgrounds">
        <div className="sticker-grid">
          {COLORS.map((c) => <button key={c} style={{ background: c }} onClick={() => S().addSolidClip(c)} title={c} />)}
        </div>
        <div className="hint">Tip: set a solid's blend mode to Overlay/Multiply for colour washes, or scale it down to make shapes/bars.</div>
      </Section>
      <Section title="Overlays">
        <div className="chip-grid">
          <button className="chip" onClick={() => { const id = S().addSolidClip('#ff9a3c'); S().updateClip(id, (c) => { c.blend = 'soft-light'; c.opacity = 0.5; c.name = 'Warm wash'; }, false); }}>Warm wash</button>
          <button className="chip" onClick={() => { const id = S().addSolidClip('#000000'); S().updateClip(id, (c) => { c.transitionIn = { type: 'fade', duration: 1 }; c.transitionOut = { type: 'fade', duration: 1 }; c.duration = 2; c.name = 'Dip to black'; }, false); }}>Dip to black</button>
          <button className="chip" onClick={() => { const id = S().addSolidClip('#808080'); S().updateClip(id, (c) => { c.effect = 'grain'; c.effectAmount = 0.6; c.blend = 'overlay'; c.opacity = 0.6; c.name = 'Film grain'; }, false); }}>Film grain overlay</button>
        </div>
      </Section>
    </div>
  );
}

const LANGS: [string, string][] = [['', 'Auto-detect'], ['english', 'English'], ['hindi', 'Hindi'], ['spanish', 'Spanish'], ['french', 'French'], ['german', 'German'], ['portuguese', 'Portuguese'], ['italian', 'Italian'], ['japanese', 'Japanese'], ['korean', 'Korean'], ['chinese', 'Chinese'], ['arabic', 'Arabic'], ['russian', 'Russian'], ['turkish', 'Turkish'], ['dutch', 'Dutch'], ['bengali', 'Bengali'], ['urdu', 'Urdu'], ['tamil', 'Tamil']];
const NLLB: [string, string][] = [['eng_Latn', 'English'], ['hin_Deva', 'Hindi'], ['spa_Latn', 'Spanish'], ['fra_Latn', 'French'], ['deu_Latn', 'German'], ['por_Latn', 'Portuguese'], ['ita_Latn', 'Italian'], ['jpn_Jpan', 'Japanese'], ['kor_Hang', 'Korean'], ['zho_Hans', 'Chinese'], ['arb_Arab', 'Arabic'], ['rus_Cyrl', 'Russian'], ['tur_Latn', 'Turkish'], ['ben_Beng', 'Bengali'], ['urd_Arab', 'Urdu'], ['tam_Taml', 'Tamil']];
const VOICES: [string, string][] = [
  ['af_heart', '🇺🇸 Heart (F) ★'], ['af_bella', '🇺🇸 Bella (F)'], ['af_nicole', '🇺🇸 Nicole (F, whisper)'], ['af_sarah', '🇺🇸 Sarah (F)'], ['af_sky', '🇺🇸 Sky (F)'], ['af_nova', '🇺🇸 Nova (F)'],
  ['am_michael', '🇺🇸 Michael (M)'], ['am_adam', '🇺🇸 Adam (M)'], ['am_eric', '🇺🇸 Eric (M)'], ['am_fenrir', '🇺🇸 Fenrir (M)'], ['am_onyx', '🇺🇸 Onyx (M)'], ['am_puck', '🇺🇸 Puck (M)'],
  ['bf_emma', '🇬🇧 Emma (F)'], ['bf_isabella', '🇬🇧 Isabella (F)'], ['bm_george', '🇬🇧 George (M)'], ['bm_lewis', '🇬🇧 Lewis (M)'], ['bm_daniel', '🇬🇧 Daniel (M)'], ['bm_fable', '🇬🇧 Fable (M)'],
  ['mms:hin', '🇮🇳 Hindi (MMS)'], ['mms:spa', '🇪🇸 Spanish (MMS)'], ['mms:fra', '🇫🇷 French (MMS)'], ['mms:deu', '🇩🇪 German (MMS)'],
];

function AiTab() {
  const sel = useStore((s) => s.project.clips.find((c) => c.id === s.selectedId));
  const tracks = useStore((s) => s.project.tracks);
  const transcript = useStore((s) => s.lastTranscript);
  const p = useStore((s) => s.project);
  const S = useStore.getState;
  const [cap, setCap] = useState({ model: 'onnx-community/whisper-base', language: '', translate: false, wordsPer: 4, style: 'pop', position: 0.3 });
  const [sil, setSil] = useState({ thresholdDb: -38, minSilence: 0.45, padding: 0.12 });
  const [scene, setScene] = useState(0.35);
  const [beatSens, setBeatSens] = useState(0.5);
  const [tts, setTts] = useState({ text: 'Welcome to VidForge — the free AI video studio that runs entirely in your browser.', voice: 'af_heart', speed: 1 });
  const [img, setImg] = useState({ prompt: 'cinematic aerial shot of a neon cyberpunk city at night, rain, 4k', ar: 'project' });
  const [tr, setTr] = useState({ track: '', src: 'eng_Latn', tgt: 'hin_Deva' });
  const [out, setOut] = useState('');
  const media = sel && (sel.type === 'video' || sel.type === 'audio');
  const video = sel && sel.type === 'video';
  const need = (ok: any, what: string) => (ok ? null : <div className="need">Select a {what} clip on the timeline</div>);
  const textTracks = tracks.filter((t) => p.clips.some((c) => c.trackId === t.id && c.type === 'text'));

  return (
    <div className="pane ai">
      <div className="ai-banner"><Sparkles size={14} /> Every model here is free and open-source and runs locally in your browser. Nothing is uploaded except AI Image prompts.</div>

      <Section title="🗣️ Auto captions (Whisper)">
        <Select label="Model" value={cap.model} options={[['onnx-community/whisper-tiny', 'Tiny · fastest (40MB)'], ['onnx-community/whisper-base', 'Base · balanced (80MB)'], ['onnx-community/whisper-small', 'Small · accurate (250MB)']]} onChange={(v) => setCap({ ...cap, model: v })} />
        <Select label="Language" value={cap.language} options={LANGS} onChange={(v) => setCap({ ...cap, language: v })} />
        <Toggle label="Translate → English" value={cap.translate} onChange={(v) => setCap({ ...cap, translate: v })} />
        <Select label="Style" value={cap.style} options={Object.entries(CAPTION_STYLES).map(([k, v]) => [k, v.label] as [string, string])} onChange={(v) => setCap({ ...cap, style: v })} />
        <Slider label="Words/caption" value={cap.wordsPer} min={1} max={12} step={1} onChange={(v) => setCap({ ...cap, wordsPer: v })} />
        <Slider label="Position" value={cap.position} min={-0.45} max={0.45} onChange={(v) => setCap({ ...cap, position: v })} />
        {need(media, 'video/audio')}
        <Btn primary disabled={!media} onClick={() => sel && autoCaptions(sel.id, cap)}><Wand2 size={13} /> Generate captions</Btn>
      </Section>

      <Section title="🌐 Translate captions (NLLB-200)" open={false}>
        <Select label="Track" value={tr.track || textTracks[0]?.id || ''} options={textTracks.length ? textTracks.map((t) => [t.id, t.name] as [string, string]) : [['', '— no text tracks —']]} onChange={(v) => setTr({ ...tr, track: v })} />
        <Select label="From" value={tr.src} options={NLLB} onChange={(v) => setTr({ ...tr, src: v })} />
        <Select label="To" value={tr.tgt} options={NLLB} onChange={(v) => setTr({ ...tr, tgt: v })} />
        <Btn disabled={!textTracks.length} onClick={() => translateCaptionTrack(tr.track || textTracks[0].id, tr.src, tr.tgt)}>Translate (~600MB model, first time)</Btn>
      </Section>

      {transcript && (
        <Section title="📝 Transcript" open={false}>
          <textarea className="ta" rows={5} readOnly value={transcript} />
          <div className="row btns">
            <Btn small onClick={() => navigator.clipboard.writeText(transcript)}>Copy</Btn>
            <Btn small onClick={async () => { const r = await summarizeText(transcript); if (r) setOut('Summary / description:\n' + r); }}>AI summarize → description</Btn>
          </div>
        </Section>
      )}

      <Section title="✂️ Smart cut">
        <b className="sub">Remove silences / jump-cut</b>
        <Slider label="Threshold dB" value={sil.thresholdDb} min={-70} max={-10} step={1} onChange={(v) => setSil({ ...sil, thresholdDb: v })} />
        <Slider label="Min silence s" value={sil.minSilence} min={0.1} max={3} onChange={(v) => setSil({ ...sil, minSilence: v })} />
        <Slider label="Padding s" value={sil.padding} min={0} max={0.5} onChange={(v) => setSil({ ...sil, padding: v })} />
        <Btn disabled={!media} onClick={() => sel && removeSilence(sel.id, sil)}>Remove silences</Btn>
        <b className="sub">Scene detection</b>
        <Slider label="Sensitivity" value={1 - scene} min={0.3} max={0.95} onChange={(v) => setScene(1 - v)} />
        <Btn disabled={!video} onClick={() => sel && splitScenes(sel.id, scene)}>Split at scene changes</Btn>
        <b className="sub">Music beats</b>
        <Slider label="Sensitivity" value={beatSens} min={0} max={1} onChange={setBeatSens} />
        <div className="row btns">
          <Btn small disabled={!media} onClick={() => sel && beatMarkers(sel.id, beatSens)}>Detect beats → markers</Btn>
          <Btn small disabled={!sel || sel.type === 'audio'} onClick={() => sel && cutToBeats(sel.id)}>Cut clip to beats</Btn>
        </div>
        {need(media, 'video/audio')}
      </Section>

      <Section title="👁️ Vision AI">
        <b className="sub">Background removal (MediaPipe)</b>
        <div className="row btns">
          {(['remove', 'blur', 'color'] as const).map((m) => <Btn small key={m} disabled={!sel || (sel.type !== 'video' && sel.type !== 'image')} active={sel?.bgMode === m}
            onClick={() => { loadSegmenter(); S().updateClip(sel!.id, (c) => { c.bgMode = c.bgMode === m ? 'none' : m; }); }}>{m === 'remove' ? 'Remove bg' : m === 'blur' ? 'Blur bg' : 'Color bg'}</Btn>)}
        </div>
        <b className="sub">Auto-reframe (subject tracking)</b>
        <div className="row btns">
          <Btn small onClick={() => S().commit((d) => { d.width = 1080; d.height = 1920; })}>Canvas → 9:16</Btn>
          <Btn small disabled={!video} onClick={() => sel && autoReframe(sel.id, 'face')}>Track face</Btn>
          <Btn small disabled={!video} onClick={() => sel && autoReframe(sel.id, 'object')}>Track object</Btn>
        </div>
        <b className="sub">Colour & understanding</b>
        <div className="row btns">
          <Btn small disabled={!video} onClick={() => sel && autoColor(sel.id)}>Auto colour-correct</Btn>
          <Btn small onClick={async () => { const r = await describeFrame(); if (r) setOut('Frame description: ' + r); }}>Describe current frame</Btn>
        </div>
      </Section>

      <Section title="🎙️ AI voiceover (Kokoro TTS)">
        <textarea className="ta" rows={4} value={tts.text} onChange={(e) => setTts({ ...tts, text: e.target.value })} />
        <Select label="Voice" value={tts.voice} options={VOICES} onChange={(v) => setTts({ ...tts, voice: v })} />
        {!tts.voice.startsWith('mms:') && <Slider label="Speed" value={tts.speed} min={0.5} max={2} onChange={(v) => setTts({ ...tts, speed: v })} />}
        <Btn primary onClick={() => textToSpeech(tts.text, tts.voice, tts.speed)}><Mic size={13} /> Generate voice at playhead</Btn>
      </Section>

      <Section title="🎨 AI image / B-roll (Pollinations, free)">
        <textarea className="ta" rows={3} value={img.prompt} onChange={(e) => setImg({ ...img, prompt: e.target.value })} />
        <Select label="Size" value={img.ar} options={[['project', 'Match project'], ['sq', 'Square']]} onChange={(v) => setImg({ ...img, ar: v })} />
        <Btn primary onClick={() => {
          const w = img.ar === 'sq' ? 1024 : p.width >= p.height ? 1280 : 720;
          const h = img.ar === 'sq' ? 1024 : Math.round((w * p.height) / p.width);
          generateImage(img.prompt, w, h);
        }}><ImageIcon size={13} /> Generate image</Btn>
        <div className="hint">Tip: add the image to the timeline and apply a Ken Burns motion preset for instant B-roll.</div>
      </Section>

      {out && <div className="ai-out"><pre>{out}</pre><Btn small onClick={() => navigator.clipboard.writeText(out)}>Copy</Btn> <Btn small onClick={() => S().addTextClip(out.split(':').slice(1).join(':').trim().slice(0, 120))}>Add as text</Btn></div>}
    </div>
  );
}

function ToolsTab() {
  const sel = useStore((s) => s.project.clips.find((c) => c.id === s.selectedId));
  const asset = useStore((s) => (sel?.assetId ? s.assets[sel.assetId] : undefined));
  const S = useStore.getState;
  const tools = asset ? FF_TOOLS.filter((t) => t.kinds.includes(asset.kind)) : [];
  return (
    <div className="pane">
      <Section title="Clip tools">
        <div className="row btns">
          <Btn small disabled={sel?.type !== 'video'} onClick={() => sel && freezeFrame(sel.id, S().time)}>Freeze frame (2s)</Btn>
          <Btn small disabled={sel?.type !== 'video'} onClick={() => sel && S().detachAudio(sel.id)}>Detach audio</Btn>
          <Btn small disabled={!sel} onClick={() => sel && S().deleteClip(sel.id, true)}>Ripple delete</Btn>
        </div>
      </Section>
      <Section title="FFmpeg processing (WebAssembly)">
        {!asset && <div className="need">Select a media clip to see available processors</div>}
        {tools.map((t) => (
          <div key={t.id} className="tool">
            <div><b>{t.label}</b><span>{t.desc}</span></div>
            <Btn small onClick={() => sel && applyFFTool(sel.id, t)}>Run</Btn>
          </div>
        ))}
        <div className="hint">Runs real FFmpeg compiled to WebAssembly in your browser (~30MB, loaded on first use). Results become new media and replace the clip's source.</div>
      </Section>
    </div>
  );
}
