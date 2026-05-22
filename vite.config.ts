/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: { output: { inlineDynamicImports: true } }
  },
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts']
  }
});
