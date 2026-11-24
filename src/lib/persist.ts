import { get, set, del, keys } from 'idb-keyval';
import { useStore } from '../store';
import type { MediaAsset, Project } from '../types';

type StoredAsset = Omit<MediaAsset, 'url'>;

let timer = 0;
let lastProject: Project | null = null;
const savedAssets = new Set<string>();

export function startAutosave() {
  useStore.subscribe((s) => {
    if (s.project === lastProject && [...Object.keys(s.assets)].every((k) => savedAssets.has(k))) return;
    clearTimeout(timer);
    timer = window.setTimeout(save, 800);
  });
}

async function save() {
  const s = useStore.getState();
  lastProject = s.project;
  try {
    for (const a of Object.values(s.assets)) {
      if (savedAssets.has(a.id)) continue;
      const { url: _u, ...rest } = a;
      await set('asset:' + a.id, rest as StoredAsset);
      savedAssets.add(a.id);
    }
    for (const k of await keys()) {
      const ks = String(k);
      if (ks.startsWith('asset:') && !s.assets[ks.slice(6)]) { await del(k); savedAssets.delete(ks.slice(6)); }
    }
    await set('project', s.project);
  } catch (e) {
    console.warn('autosave failed', e);
  }
}

export async function restore(): Promise<boolean> {
  try {
    const p = (await get('project')) as Project | undefined;
    if (!p) return false;
    const assets: Record<string, MediaAsset> = {};
    for (const k of await keys()) {
      const ks = String(k);
      if (!ks.startsWith('asset:')) continue;
      const a = (await get(k)) as StoredAsset;
      if (!a?.blob) continue;
      assets[a.id] = { ...a, url: URL.createObjectURL(a.blob) };
      savedAssets.add(a.id);
    }
    lastProject = p;
    useStore.getState().loadProject(p, assets);
    return true;
  } catch (e) {
    console.warn('restore failed', e);
    return false;
  }
}

export async function clearSaved() {
  for (const k of await keys()) await del(k);
  savedAssets.clear();
}

/** Export project JSON (media referenced by name) */
export function projectToJson() {
  const s = useStore.getState();
  const assetMeta = Object.values(s.assets).map(({ id, name, kind, duration, width, height }) => ({ id, name, kind, duration, width, height }));
  return new Blob([JSON.stringify({ version: 1, project: s.project, assets: assetMeta }, null, 2)], { type: 'application/json' });
}
