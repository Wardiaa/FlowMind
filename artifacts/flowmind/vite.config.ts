import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const port = Number(process.env.PORT || 22473);
const localAuth = process.env.FLOWMIND_AUTH_MODE === 'local';
const apiPort = Number(process.env.API_PORT || 8080);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH || '/';

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: localAuth ? '127.0.0.1' : '0.0.0.0',
    allowedHosts: localAuth ? ['127.0.0.1', 'localhost'] : true,
    ...(localAuth
      ? { proxy: { '/api': `http://127.0.0.1:${apiPort}` } }
      : {}),
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: localAuth ? '127.0.0.1' : '0.0.0.0',
    allowedHosts: localAuth ? ['127.0.0.1', 'localhost'] : true,
  },
});
