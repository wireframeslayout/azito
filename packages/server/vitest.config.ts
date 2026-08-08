import { defineConfig } from 'vitest/config';

// Test-stabilization fix (third-party review): `*.tmuxIntegration.test.ts`
// files drive REAL tmux (spawn a session, wait for a real shell prompt,
// capture-pane in a poll loop) rather than mocking it — under full-suite
// parallel execution, every other test file's worker competing for CPU can
// push a real tmux round trip past what used to be a comfortable timeout,
// and TaskPaneEnvironmentService.tmuxIntegration.test.ts in particular was
// observed timing out only when run alongside the rest of the suite, never
// in isolation. Splitting into two projects serializes the tmux-integration
// files against EACH OTHER (`fileParallelism: false`, a single fork) so they
// never contend for the same real tmux server concurrently, on top of the
// per-file timeout increases in those files themselves.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.tmuxIntegration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'tmux-integration',
          include: ['src/**/*.tmuxIntegration.test.ts'],
          fileParallelism: false,
          testTimeout: 30000,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
