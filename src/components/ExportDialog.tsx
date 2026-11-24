import { useState } from 'react';
import { useStore, projectDuration } from '../store';
import { exportMp4, exportWav } from '../engine/exporter';
import { download, fmtTime } from '../lib/media';
import { runFFmpeg } from '../lib/ffmpeg';
import { Select, Slider, Toggle, Btn } from './ui';
import { X, Download } from 'lucide-react';

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const p = useStore((s) => s.project);
  const dur = projectDuration(p);
  const [res, setRes] = useState('1');
  const [fps, setFps] = useState(String(p.fps));
  const [quality, setQuality] = useState('high');
  const [format, setFormat] = useState<'mp4' | 'gif' | 'wav'>('mp4');
  const [range, setRange] = useState<'all' | 'custom'>('all');
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(dur);
  const [audio, setAudio] = useState(true);
  const [gifW, setGifW] = useState(480);
  const [state, setState] = useState<{ p: number; d: string } | null>(null);
  const [cancel] = useState({ cancel: false });
  const [result, setResult] = useState<{ url: string; name: string; size: number } | null>(null);

  const k = +res;
  const W = Math.round((p.width * k) / 2) * 2, H = Math.round((p.height * k) / 2) * 2;
  const bitrate = { low: 0.07, medium: 0.12, high: 0.2, max: 0.35 }[quality]! * W * H * +fps;
  const safeName = (p.name || 'video').replace(/[^\w\- ]+/g, '').trim() || 'video';

  const go = async () => {
    if (dur <= 0) return useStore.getState().toast('Timeline is empty', 'error');
    cancel.cancel = false;
    setResult(null);
    setState({ p: 0, d: 'Preparing…' });
    useStore.getState().set({ playing: false });
    try {
      const s = useStore.getState();
      const f = range === 'all' ? 0 : from, t = range === 'all' ? dur : Math.max(from + 0.1, to);
      let blob: Blob, name: string;
      if (format === 'wav') {
        blob = await exportWav(s.project, s.assets); name = safeName + '.wav';
      } else {
        const mp4 = await exportMp4(s.project, s.assets, { width: format === 'gif' ? Math.round(gifW / 2) * 2 : W, height: format === 'gif' ? Math.round((gifW * p.height) / p.width / 2) * 2 : H, fps: format === 'gif' ? 15 : +fps, bitrate: format === 'gif' ? 8e6 : bitrate, from: f, to: t, audio: format === 'mp4' && audio }, (q, d) => setState({ p: format === 'gif' ? q * 0.6 : q, d }), cancel);
        if (format === 'gif') {
          setState({ p: 0.6, d: 'Encoding GIF with FFmpeg (palette)…' });
          blob = await runFFmpeg(mp4, 'v.mp4', ['-i', '{in}', '-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', '{out}'], 'out.gif', 'image/gif', (q) => setState({ p: 0.6 + q * 0.4, d: 'Encoding GIF…' }));
          name = safeName + '.gif';
        } else { blob = mp4; name = safeName + '.mp4'; }
      }
      setResult({ url: URL.createObjectURL(blob), name, size: blob.size });
      download(blob, name);
      useStore.getState().toast(`Exported ${name}`, 'success');
    } catch (e) {
      useStore.getState().toast('Export failed: ' + (e as Error).message, 'error');
      console.error(e);
    } finally {
      setState(null);
    }
  };

  return (
    <div className="modal-bg" onClick={() => !state && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h"><b>Export</b><button onClick={() => { cancel.cancel = true; onClose(); }}><X size={16} /></button></div>
        <div className="modal-b">
          <div className="seg">
            {(['mp4', 'gif', 'wav'] as const).map((f) => <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>{f === 'mp4' ? 'Video MP4' : f === 'gif' ? 'Animated GIF' : 'Audio WAV'}</button>)}
          </div>
          {format === 'mp4' && <>
            <Select label="Resolution" value={res} options={[['0.5', `${Math.round(p.width / 2)}×${Math.round(p.height / 2)} (half)`], ['0.6667', `${Math.round(p.width * 2 / 3)}×${Math.round(p.height * 2 / 3)}`], ['1', `${p.width}×${p.height} (project)`], ['2', `${p.width * 2}×${p.height * 2} (2× upscale)`]]} onChange={setRes} />
            <Select label="Frame rate" value={fps} options={[['24', '24'], ['25', '25'], ['30', '30'], ['50', '50'], ['60', '60']]} onChange={setFps} />
            <Select label="Quality" value={quality} options={[['low', 'Small file'], ['medium', 'Standard'], ['high', 'High'], ['max', 'Maximum']]} onChange={setQuality} />
            <Toggle label="Include audio" value={audio} onChange={setAudio} />
          </>}
          {format === 'gif' && <Slider label="Width px" value={gifW} min={160} max={1080} step={10} onChange={setGifW} />}
          {format !== 'wav' && <>
            <Select label="Range" value={range} options={[['all', `Whole timeline (${fmtTime(dur, p.fps)})`], ['custom', 'Custom range']]} onChange={(v) => setRange(v)} />
            {range === 'custom' && <>
              <Slider label="From" value={from} min={0} max={dur} onChange={setFrom} fmt={(v) => fmtTime(v, p.fps)} />
              <Slider label="To" value={to} min={0} max={dur} onChange={setTo} fmt={(v) => fmtTime(v, p.fps)} />
            </>}
          </>}
          {format === 'mp4' && <div className="hint">H.264 · {(bitrate / 1e6).toFixed(1)} Mbps · ≈ {((bitrate * dur) / 8 / 1e6 + (audio ? dur * 0.024 : 0)).toFixed(0)} MB. Hardware-accelerated WebCodecs encoder — nothing leaves your computer.</div>}
          {state && (
            <div className="progress">
              <div className="bar"><i style={{ width: `${state.p * 100}%` }} /></div>
              <span>{state.d}</span>
            </div>
          )}
          {result && <div className="result">✅ {result.name} · {(result.size / 1e6).toFixed(1)} MB · <a href={result.url} download={result.name}>download again</a></div>}
        </div>
        <div className="modal-f">
          {state ? <Btn onClick={() => { cancel.cancel = true; }}>Cancel</Btn> : <Btn primary onClick={go}><Download size={14} /> Export {format.toUpperCase()}</Btn>}
        </div>
      </div>
    </div>
  );
}
