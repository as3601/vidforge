import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

/** Dev-only: POST /__save?name=file.mp4 writes the body into ./exports */
function saveToDisk(): Plugin {
  return {
    name: 'vidforge-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        const url = new URL(req.url || '', 'http://x');
        const name = path.basename(url.searchParams.get('name') || 'export.bin').replace(/[^\w.\- ]+/g, '_');
        const dir = path.resolve(__dirname, 'exports');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        const out = fs.createWriteStream(file);
        req.pipe(out);
        out.on('finish', () => res.end(JSON.stringify({ ok: true, file })));
        out.on('error', (e) => { res.statusCode = 500; res.end(String(e)); });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), saveToDisk()],
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@huggingface/transformers', 'kokoro-js'] },
  worker: { format: 'es' },
  server: { port: 5190 },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
