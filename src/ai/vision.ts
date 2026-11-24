// In-browser computer vision via Google MediaPipe (free, runs locally on GPU/CPU)
import { FilesetResolver, ImageSegmenter, FaceDetector, ObjectDetector } from '@mediapipe/tasks-vision';

const WASM = '/mediapipe';
const MODELS = {
  selfie: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  face: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
  object: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite',
};

let filesetP: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;
const fileset = () => (filesetP ||= FilesetResolver.forVisionTasks(WASM));

let segmenter: ImageSegmenter | null = null;
let segP: Promise<ImageSegmenter> | null = null;
let lastTs = 0;

export function loadSegmenter(): Promise<ImageSegmenter> {
  if (segP) return segP;
  segP = (async () => {
    const fs = await fileset();
    const mk = (delegate: 'GPU' | 'CPU') => ImageSegmenter.createFromOptions(fs, {
      baseOptions: { modelAssetPath: MODELS.selfie, delegate },
      runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    try { segmenter = await mk('GPU'); } catch { segmenter = await mk('CPU'); }
    return segmenter;
  })();
  segP.catch(() => { segP = null; });
  return segP;
}

const SEG_W = 384;
let segIn: HTMLCanvasElement | null = null;
let maskCv: HTMLCanvasElement | null = null;

/** Returns a canvas whose alpha = person probability, or null if model still loading. */
export function segmentPerson(frame: HTMLCanvasElement, invert = false): HTMLCanvasElement | null {
  if (!segmenter) { loadSegmenter(); return null; }
  const h = Math.max(2, Math.round((SEG_W * frame.height) / frame.width));
  segIn ||= document.createElement('canvas');
  if (segIn.width !== SEG_W || segIn.height !== h) { segIn.width = SEG_W; segIn.height = h; }
  segIn.getContext('2d')!.drawImage(frame, 0, 0, SEG_W, h);
  lastTs = Math.max(lastTs + 1, performance.now());
  const res = segmenter.segmentForVideo(segIn, lastTs);
  const m = res.confidenceMasks?.[0];
  if (!m) { res.close(); return null; }
  const data = m.getAsFloat32Array();
  maskCv ||= document.createElement('canvas');
  if (maskCv.width !== m.width || maskCv.height !== m.height) { maskCv.width = m.width; maskCv.height = m.height; }
  const mx = maskCv.getContext('2d')!;
  const img = mx.createImageData(m.width, m.height);
  for (let i = 0; i < data.length; i++) {
    let v = invert ? 1 - data[i] : data[i];
    v = Math.min(1, Math.max(0, (v - 0.25) / 0.5)); // tighten edges
    img.data[i * 4 + 3] = v * 255;
  }
  mx.putImageData(img, 0, 0);
  res.close();
  return maskCv;
}

let faceP: Promise<FaceDetector> | null = null;
export function loadFaceDetector() {
  return (faceP ||= (async () => FaceDetector.createFromOptions(await fileset(), {
    baseOptions: { modelAssetPath: MODELS.face, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.5,
  }))());
}

let objP: Promise<ObjectDetector> | null = null;
export function loadObjectDetector() {
  return (objP ||= (async () => ObjectDetector.createFromOptions(await fileset(), {
    baseOptions: { modelAssetPath: MODELS.object, delegate: 'CPU' }, runningMode: 'IMAGE', scoreThreshold: 0.4, maxResults: 5,
  }))());
}

export interface Box { x: number; y: number; w: number; h: number; label?: string; score: number }

/** Find the main subject (face first, else any object) in a frame. Coords in source px. */
export async function detectSubject(frame: HTMLCanvasElement, mode: 'face' | 'object'): Promise<Box | null> {
  if (mode === 'face') {
    const fd = await loadFaceDetector();
    const r = fd.detect(frame);
    const best = r.detections.filter((d) => d.boundingBox).sort((a, b) => b.boundingBox!.width * b.boundingBox!.height - a.boundingBox!.width * a.boundingBox!.height)[0];
    if (!best) return null;
    const b = best.boundingBox!;
    return { x: b.originX, y: b.originY, w: b.width, h: b.height, score: best.categories[0]?.score ?? 1 };
  }
  const od = await loadObjectDetector();
  const r = od.detect(frame);
  const best = r.detections.filter((d) => d.boundingBox).sort((a, b) => (b.categories[0]?.score ?? 0) - (a.categories[0]?.score ?? 0))[0];
  if (!best) return null;
  const b = best.boundingBox!;
  return { x: b.originX, y: b.originY, w: b.width, h: b.height, label: best.categories[0]?.categoryName, score: best.categories[0]?.score ?? 0 };
}

/** Label what's in a frame (for auto-tagging / smart naming) */
export async function detectObjects(frame: HTMLCanvasElement): Promise<string[]> {
  const od = await loadObjectDetector();
  const r = od.detect(frame);
  return [...new Set(r.detections.map((d) => d.categories[0]?.categoryName).filter(Boolean) as string[])];
}
