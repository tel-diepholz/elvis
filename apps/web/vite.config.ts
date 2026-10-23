import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.ELVIS_BACKEND ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api/live': { target: backend.replace(/^http/, 'ws'), ws: true },
      '/api': { target: backend },
    },
  },
});
