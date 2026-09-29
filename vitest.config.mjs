import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    mockReset: true,
    setupFiles: [],
    // First test issues the server's first real HTTP request after a cold
    // import; on CI (fresh transform, no warm caches) that can exceed the 5s
    // default. Generous ceiling keeps the suite reliable on GitHub runners.
    testTimeout: 20000,
  },
});
