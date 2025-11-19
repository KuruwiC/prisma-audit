import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:3000',
      '/feed': 'http://localhost:3000',
      '/users': 'http://localhost:3000',
      '/posts': 'http://localhost:3000',
      '/posts-with-tags': 'http://localhost:3000',
      '/profiles': 'http://localhost:3000',
      '/comments': 'http://localhost:3000',
      '/attachments': 'http://localhost:3000',
      '/avatar-images': 'http://localhost:3000',
      '/audit-logs': 'http://localhost:3000',
      '/tags': 'http://localhost:3000',
    },
  },
});
