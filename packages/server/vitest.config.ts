import { defineConfig } from 'vitest/config';
import { WINDOWS_EXCLUDED_UNIT_TESTS } from './vitest.windowsExclude';

// Windows の CI だけ、まだ通らないファイルを unit から外す（理由は vitest.windowsExclude.ts）。他の OS の挙動は変えない。
const isWindows = process.platform === 'win32';
const windowsOnlyExcludes = isWindows ? WINDOWS_EXCLUDED_UNIT_TESTS.map((e) => e.file) : [];
// 実 git を起動するテストは Windows の CI では既定の 5 秒を超えることがある（Linux / macOS は既定のまま）。
const unitTestTimeout = isWindows ? { testTimeout: 30000 } : {};

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
          ...unitTestTimeout,
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.tmuxIntegration.test.ts', 'src/**/*.misaoIntegration.test.ts', ...windowsOnlyExcludes],
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
      {
        // Same shape as tmux-integration: these files start a real misao daemon, so they run one at a time.
        extends: true,
        test: {
          name: 'misao-integration',
          include: ['src/**/*.misaoIntegration.test.ts'],
          fileParallelism: false,
          testTimeout: 30000,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
