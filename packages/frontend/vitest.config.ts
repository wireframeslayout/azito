import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'node', environment: 'node', include: ['src/**/*.test.ts'], exclude: ['src/**/editable.test.ts'] } },
      { test: { name: 'dom', environment: 'jsdom', include: ['src/**/*.test.tsx', 'src/**/editable.test.ts'], setupFiles: ['src/test/setup.ts'] } },
    ],
  },
});
