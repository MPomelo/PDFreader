import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], clearScreen: false, server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/target/**', '**/.local/**', '**/dist/**'] } },
  build: { rollupOptions: { output: { manualChunks(id) {
    if (id.includes('/node_modules/katex/')) return 'katex';
    if (/\/node_modules\/(@codemirror|@lezer)\//.test(id)) return 'codemirror';
    if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
    if (/\/node_modules\/(react-markdown|remark-|rehype-|micromark|mdast-|hast-|unist-|unified|vfile)/.test(id)) return 'markdown';
  } } } } });
