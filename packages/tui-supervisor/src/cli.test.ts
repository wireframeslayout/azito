import { describe, expect, it } from 'vitest';
import { parseArgs, resolveLaunchBinding } from './cli';

describe('parseArgs', () => {
  it('parses server/target/task-id/unit-id and joins the command after --', () => {
    const args = parseArgs([
      '--server',
      'local-server',
      '--target',
      'azito:task-1.1',
      '--task-id',
      '7',
      '--unit-id',
      '3',
      '--',
      'claude',
      '--dangerously-skip-permissions',
    ]);

    expect(args).toEqual({
      server: 'local-server',
      target: 'azito:task-1.1',
      taskId: 7,
      unitId: 3,
      command: 'claude --dangerously-skip-permissions',
      launchId: null,
      bootstrapToken: null,
    });
  });

  it('still accepts the legacy --launch-id/--bootstrap-token flags (backward compat)', () => {
    const args = parseArgs([
      '--server',
      'local-server',
      '--target',
      'azito:task-1.1',
      '--launch-id',
      'launch-abc',
      '--bootstrap-token',
      'secret-xyz',
      '--',
      'claude',
    ]);

    expect(args.launchId).toBe('launch-abc');
    expect(args.bootstrapToken).toBe('secret-xyz');
  });

  it('dies on an unrecognized flag (still strict — only the launch binding transport changed)', () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('process.exit called');
    }) as any;

    try {
      expect(() =>
        parseArgs(['--server', 'x', '--target', 'y', '--totally-unknown', 'z', '--', 'cmd']),
      ).toThrow('process.exit called');
      expect(exitCode).toBe(2);
    } finally {
      process.exit = originalExit;
    }
  });
});

describe('resolveLaunchBinding', () => {
  const noBinding = { launchId: null, bootstrapToken: null };

  it('prefers AZITO_SUPERVISOR_LAUNCH_ID/AZITO_SUPERVISOR_BOOTSTRAP env vars over argv flags', () => {
    const binding = resolveLaunchBinding(
      { launchId: 'from-flag', bootstrapToken: 'from-flag-token' },
      { AZITO_SUPERVISOR_LAUNCH_ID: 'from-env', AZITO_SUPERVISOR_BOOTSTRAP: 'from-env-token' },
    );

    expect(binding).toEqual({ launchId: 'from-env', bootstrapToken: 'from-env-token' });
  });

  it('falls back to argv flags when the env vars are absent (old hub -> new supervisor)', () => {
    const binding = resolveLaunchBinding(
      { launchId: 'from-flag', bootstrapToken: 'from-flag-token' },
      {},
    );

    expect(binding).toEqual({ launchId: 'from-flag', bootstrapToken: 'from-flag-token' });
  });

  it('falls back to argv flags when only one of the two env vars is set', () => {
    const binding = resolveLaunchBinding(
      { launchId: 'from-flag', bootstrapToken: 'from-flag-token' },
      { AZITO_SUPERVISOR_LAUNCH_ID: 'from-env' },
    );

    expect(binding).toEqual({ launchId: 'from-flag', bootstrapToken: 'from-flag-token' });
  });

  it('returns nulls when neither env vars nor flags are present (manual azs invocation)', () => {
    expect(resolveLaunchBinding(noBinding, {})).toEqual(noBinding);
  });
});
