import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    // CloudBase is already loaded through a dynamic import in vision.js.
    // Keep the deferred SDK chunk separate from the interactive app shell.
    chunkSizeWarningLimit: 800
  }
});
