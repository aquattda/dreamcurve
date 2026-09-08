import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { hmr: { port: Number(process.env.VITE_HMR_PORT || 24678) } }, build: { sourcemap: true } });
