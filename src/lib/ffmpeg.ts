import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

let ff: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
let progressCb: ((p: number) => void) | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ff) return ff;
  if (loading) return loading;
  loading = (async () => {
    const f = new FFmpeg();
    const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
    f.on('progress', ({ progress }) => progressCb?.(Math.max(0, Math.min(1, progress))));
    f.on('log', ({ message }) => { if (/error/i.test(message)) console.warn('[ffmpeg]', message); });
    await f.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ff = f;
    return f;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

let queue: Promise<unknown> = Promise.resolve();

/** Run ffmpeg on one input, returning the output Blob. Use {in} and {out} placeholders in args. */
export function runFFmpeg(input: Blob, inName: string, args: string[], outName: string, mime: string, onP?: (p: number) => void): Promise<Blob> {
  const job = queue.then(async () => {
    const f = await getFFmpeg();
    const ext = inName.split('.').pop() || 'bin';
    const iN = 'in.' + ext;
    await f.writeFile(iN, await fetchFile(input));
    progressCb = onP || null;
    const full = args.map((a) => a.replace('{in}', iN).replace('{out}', outName));
    const code = await f.exec(full);
    progressCb = null;
    if (code !== 0) throw new Error('FFmpeg exited with code ' + code);
    const data = await f.readFile(outName);
    await f.deleteFile(iN).catch(() => {});
    await f.deleteFile(outName).catch(() => {});
    return new Blob([new Uint8Array(data as Uint8Array)], { type: mime });
  });
  queue = job.catch(() => {});
  return job;
}

export interface FFTool { id: string; label: string; desc: string; args: string[]; ext: string; mime: string; kinds: ('video' | 'audio' | 'image')[] }

export const FF_TOOLS: FFTool[] = [
  { id: 'convert', label: 'Convert to MP4 (H.264)', desc: 'Fix unsupported formats (MOV/HEVC/AVI/MKV/FLV)', args: ['-i', '{in}', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '{out}'], ext: 'mp4', mime: 'video/mp4', kinds: ['video'] },
  { id: 'reverse', label: 'Reverse', desc: 'Play the clip backwards (video + audio)', args: ['-i', '{in}', '-vf', 'reverse', '-af', 'areverse', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '{out}'], ext: 'mp4', mime: 'video/mp4', kinds: ['video'] },
  { id: 'stabilize', label: 'Stabilize (deshake)', desc: 'Remove camera shake', args: ['-i', '{in}', '-vf', 'deshake=rx=32:ry=32', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '{out}'], ext: 'mp4', mime: 'video/mp4', kinds: ['video'] },
  { id: 'denoiseV', label: 'Video denoise', desc: 'Clean grainy/low-light footage (hqdn3d)', args: ['-i', '{in}', '-vf', 'hqdn3d=4:3:6:4.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '{out}'], ext: 'mp4', mime: 'video/mp4', kinds: ['video'] },
  { id: 'slowmo', label: 'Smooth slow-motion (motion interpolation)', desc: 'Interpolates frames to 60fps then slows 2× – slow!', args: ['-i', '{in}', '-vf', "minterpolate=fps=60:mi_mode=mci,setpts=2*PTS", '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '{out}'], ext: 'mp4', mime: 'video/mp4', kinds: ['video'] },
  { id: 'interp', label: 'Frame interpolate to 60fps', desc: 'Smoother motion (optical-flow blending)', args: ['-i', '{in}', '-vf', 'minterpolate=fps=60:mi_mode=blend', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '{out}'], ext: 'mp4', mime: 'video/mp4', kinds: ['video'] },
  { id: 'denoiseA', label: 'AI audio denoise (FFT)', desc: 'Remove hiss, hum and background noise', args: ['-i', '{in}', '-af', 'highpass=f=70,afftdn=nf=-25:tn=1,lowpass=f=14000', '-c:v', 'copy', '{out}'], ext: 'mp4', mime: 'video/mp4', kinds: ['video'] },
  { id: 'denoiseA2', label: 'AI audio denoise (FFT)', desc: 'Remove hiss, hum and background noise', args: ['-i', '{in}', '-af', 'highpass=f=70,afftdn=nf=-25:tn=1,lowpass=f=14000', '{out}'], ext: 'wav', mime: 'audio/wav', kinds: ['audio'] },
  { id: 'loudnorm', label: 'Loudness normalize (-14 LUFS)', desc: 'Broadcast/YouTube-ready levels', args: ['-i', '{in}', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:v', 'copy', '{out}'], ext: 'mp4', mime: 'video/mp4', kinds: ['video'] },
  { id: 'loudnorm2', label: 'Loudness normalize (-14 LUFS)', desc: 'Broadcast/YouTube-ready levels', args: ['-i', '{in}', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '{out}'], ext: 'wav', mime: 'audio/wav', kinds: ['audio'] },
  { id: 'voice', label: 'Voice enhance (EQ + compressor)', desc: 'Podcast-style clear voice', args: ['-i', '{in}', '-af', 'highpass=f=80,equalizer=f=3000:t=q:w=1:g=4,equalizer=f=250:t=q:w=1:g=-3,acompressor=threshold=-18dB:ratio=3:attack=5:release=80,alimiter=limit=0.95', '-c:v', 'copy', '{out}'], ext: 'mp4', mime: 'video/mp4', kinds: ['video'] },
  { id: 'pitchUp', label: 'Voice changer: chipmunk', desc: 'Pitch up', args: ['-i', '{in}', '-af', 'asetrate=48000*1.35,aresample=48000,atempo=0.74', '{out}'], ext: 'wav', mime: 'audio/wav', kinds: ['audio'] },
  { id: 'pitchDown', label: 'Voice changer: deep', desc: 'Pitch down', args: ['-i', '{in}', '-af', 'asetrate=48000*0.75,aresample=48000,atempo=1.333', '{out}'], ext: 'wav', mime: 'audio/wav', kinds: ['audio'] },
  { id: 'robot', label: 'Voice changer: robot', desc: 'Metallic robot voice', args: ['-i', '{in}', '-af', "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75", '{out}'], ext: 'wav', mime: 'audio/wav', kinds: ['audio'] },
  { id: 'echo', label: 'Echo / reverb', desc: 'Hall reverb', args: ['-i', '{in}', '-af', 'aecho=0.8:0.85:60|120:0.4|0.25', '{out}'], ext: 'wav', mime: 'audio/wav', kinds: ['audio'] },
  { id: 'extract', label: 'Extract audio (WAV)', desc: 'Pull the soundtrack out as a new asset', args: ['-i', '{in}', '-vn', '-ac', '2', '-ar', '48000', '{out}'], ext: 'wav', mime: 'audio/wav', kinds: ['video'] },
  { id: 'gray', label: 'Black & white (film)', desc: 'High-contrast monochrome', args: ['-i', '{in}', '-vf', 'hue=s=0,eq=contrast=1.25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '{out}'], ext: 'mp4', mime: 'video/mp4', kinds: ['video'] },
];
