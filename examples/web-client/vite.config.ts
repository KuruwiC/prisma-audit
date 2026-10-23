import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // The API's source, imported as text where the demo shows it
      '@api': path.resolve(__dirname, '../hono-api/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // DEMO_API_URL points the proxy at an API started on another port (PORT=3001 pnpm dev:api)
      '/api': process.env.DEMO_API_URL ?? 'http://localhost:3000',
    },
  },
});
