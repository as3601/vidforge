import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { engine } from './engine/player';
import { LeftPanel, importFiles } from './components/LeftPanel';
import { Preview } from './components/Preview';
import { Inspector } from './components/Inspector';
import { Timeline } from './components/Timeline';
import { ExportDialog } from './components/ExportDialog';
import { restore, startAutosave, clearSaved, projectToJson } from './lib/persist';
import { download } from './lib/media';
import { Download, FilePlus2, Save, Sparkles, Loader2, FolderOpen } from 'lucide-react';
import type { Clip } from './types';

let clipboard: Clip | null = null;

export default function App() {
  const [exporting, setExporting] = useState(false);
  const [drag, setDrag] = useState(false);
  const [ready, setReady] = useState(false);
  const jobs = useStore((s) => s.jobs);
  const toasts = useStore((s) => s.toasts);
  const name = useStore((s) => s.project.name);
  const openRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    restore().then((ok) => { setReady(true); startAutosave(); if (ok) useStore.getState().toast('Restored your last session', 'info'); });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement;
      if (tg.tagName === 'INPUT' && (tg as HTMLInputElement).type !== 'range' && (tg as HTMLInputElement).type !== 'checkbox' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT') return;
      const s = useStore.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const sel = s.selectedId;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); engine.toggle(); }
      else if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); s.undo(); }
      else if ((ctrl && k === 'y') || (ctrl && e.shiftKey && k === 'z')) { e.preventDefault(); s.redo(); }
      else if (ctrl && k === 'd' && sel) { e.preventDefault(); s.duplicateClip(sel); }
      else if (ctrl && k === 'c' && sel) { clipboard = structuredClone(s.project.clips.find((c) => c.id === sel) || null); }
      else if (ctrl && k === 'v' && clipboard) { e.preventDefault(); const c = { ...structuredClone(clipboard), id: 'c_' + Math.random().toString(36).slice(2), start: s.time }; const p = s.project; const free = p.tracks.find((t) => t.kind === p.tracks.find((x) => x.id === c.trackId)?.kind && !p.clips.some((o) => o.trackId === t.id && c.start < o.start + o.duration && c.start + c.duration > o.start)); c.trackId = free ? free.id : s.addTrack(p.tracks.find((x) => x.id === c.trackId)?.kind || 'visual', true); s.addClip(c); }
      else if (ctrl && k === 's') { e.preventDefault(); download(projectToJson(), (s.project.name || 'project') + '.vidforge.json'); }
      else if (ctrl) return;
      else if (k === 's') { if (e.shiftKey || !sel) s.splitAll(s.time); else s.splitClip(sel, s.time); }
      else if ((k === 'delete' || k === 'backspace') && sel) { s.deleteClip(sel, e.shiftKey); }
      else if (k === 'm') s.addMarker(s.time);
      else if (k === 'arrowleft') { e.preventDefault(); engine.seek(Math.max(0, s.time - (e.shiftKey ? 1 : 1 / s.project.fps))); }
      else if (k === 'arrowright') { e.preventDefault(); engine.seek(s.time + (e.shiftKey ? 1 : 1 / s.project.fps)); }
      else if (k === 'home') engine.seek(0);
      else if (k === 'end') engine.seek(s.project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0));
      else if (k === '=' || k === '+') s.set({ zoom: Math.min(600, s.zoom * 1.3) });
      else if (k === '-') s.set({ zoom: Math.max(4, s.zoom / 1.3) });
      else if (k === 'escape') s.set({ selectedId: null });
      else if (k === 'j') engine.seek(Math.max(0, s.time - 5));
      else if (k === 'l') engine.seek(s.time + 5);
      else if (k === 'k') engine.pause();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openProject = async (f: File) => {
    try {
      const j = JSON.parse(await f.text());
      const s = useStore.getState();
      // re-link media by name to what is already in the library
      const byName = new Map(Object.values(s.assets).map((a) => [a.name, a.id]));
      const map = new Map<string, string>();
      for (const a of j.assets || []) { const id = byName.get(a.name); if (id) map.set(a.id, id); }
      const p = j.project;
      p.clips = p.clips.map((c: Clip) => (c.assetId ? { ...c, assetId: map.get(c.assetId) || c.assetId } : c));
      s.loadProject(p, s.assets);
      const missing = (j.assets || []).filter((a: any) => !map.has(a.id)).map((a: any) => a.name);
      s.toast(missing.length ? `Project opened. Import these files to relink: ${missing.join(', ')}` : 'Project opened', missing.length ? 'error' : 'success');
    } catch (e) { useStore.getState().toast('Invalid project file', 'error'); }
  };

  return (
    <div className={'app' + (drag ? ' dragging' : '')}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.relatedTarget === null) setDrag(false); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDrag(false); importFiles(e.dataTransfer.files); } }}>
      <header className="top">
        <div className="logo"><Sparkles size={18} /> VidForge <span>Studio</span></div>
        <input className="pname" value={name} onChange={(e) => useStore.getState().commit((d) => { d.name = e.target.value; }, false)} />
        <div style={{ flex: 1 }} />
        <input ref={openRef} type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) openProject(f); e.target.value = ''; }} />
        <button className="tb" title="New project" onClick={async () => { if (confirm('Start a new project? Unsaved work in this browser will be cleared.')) { await clearSaved(); useStore.getState().newProject(); useStore.getState().set({ assets: {} }); } }}><FilePlus2 size={15} /> New</button>
        <button className="tb" title="Open project file" onClick={() => openRef.current?.click()}><FolderOpen size={15} /> Open</button>
        <button className="tb" title="Save project file (Ctrl+S)" onClick={() => download(projectToJson(), (name || 'project') + '.vidforge.json')}><Save size={15} /> Save</button>
        <button className="tb export" onClick={() => setExporting(true)}><Download size={15} /> Export</button>
      </header>
      {ready && (
        <main className="main">
          <LeftPanel />
          <Preview />
          <aside className="right"><Inspector /></aside>
        </main>
      )}
      {ready && <Timeline />}
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {drag && <div className="drop-overlay">Drop to import media</div>}
      <div className="jobs">
        {jobs.map((j) => (
          <div key={j.id} className="job">
            <Loader2 size={14} className="spin" />
            <div><b>{j.label}</b><span>{j.detail || ''}</span><div className="bar"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div></div>
          </div>
        ))}
        {toasts.map((t) => <div key={t.id} className={'toast ' + t.kind}>{t.msg}</div>)}
      </div>
    </div>
  );
}
