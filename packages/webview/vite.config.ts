import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built as a VS Code webview bundle: relative base so resource URIs work.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
        },
      },
    },
  },
});
