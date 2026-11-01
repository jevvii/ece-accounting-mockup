import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Hash routes keep one HTML entry; relative assets also work at /<repository>/.
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['tests/domain/**/*.test.ts', 'tests/app/**/*.test.ts'],
  },
});
