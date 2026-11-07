import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Development only: Vite serves the UI and proxies the API and the server-rendered sign-in pages to the backend
// (`move-openlab serve`, port 8765). In production the backend serves the built UI on one origin.
// changeOrigin stays false: the backend's same-origin (CSRF) check compares the browser Origin with the Host header,
// so the proxy must forward the original Host (localhost:5180) rather than rewrite it to the backend address.
const backend = { target: 'http://127.0.0.1:8765', changeOrigin: false };
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true, proxy: { '/api': backend, '/login': backend, '/change-password': backend, '/auth.js': backend } },
});
