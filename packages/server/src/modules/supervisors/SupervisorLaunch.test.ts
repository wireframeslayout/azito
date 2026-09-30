import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterAll } from 'vitest';
import { shouldSupervise, wrapWithSupervisor } from './SupervisorLaunch';
import { resolveSupervisorCommand } from './SupervisorPath';

describe('shouldSupervise', () => {
  it('is true for agent windows on local servers', () => {
    expect(shouldSupervise('local', 'agent')).toBe(true);
  });

  it('is true for agent windows on agent servers', () => {
    expect(shouldSupervise('agent', 'agent')).toBe(true);
  });

  it('is false for terminal windows on local servers', () => {
    expect(shouldSupervise('local', 'terminal')).toBe(false);
  });

  it('is false for terminal windows on agent servers', () => {
    expect(shouldSupervise('agent', 'terminal')).toBe(false);
  });
});

describe('wrapWithSupervisor', () => {
  it('wraps a simple command with quoted --server/--target and -- <cmd>', () => {
    const wrapped = wrapWithSupervisor('claude --dangerously-skip-permissions', {
      server: { name: 'local-server', type: 'local' },
      target: 'azito:task-1.1',
    });

    // Should start with the resolved supervisor command (node <dist> or npx tsx <src>)
    expect(wrapped).toMatch(/^(node|npx tsx) .*supervisor/);
    expect(wrapped).toContain("--server 'local-server'");
    expect(wrapped).toContain("--target 'azito:task-1.1'");
    expect(wrapped).toContain("-- 'claude --dangerously-skip-permissions'");
    expect(wrapped).not.toContain('--task-id');
    expect(wrapped).not.toContain('--unit-id');
  });

  it('includes --task-id and --unit-id when provided', () => {
    const wrapped = wrapWithSupervisor('codex', {
      server: { name: 'local-server', type: 'local' },
      target: 'azito:task-2.1',
      taskId: 7,
      unitId: 3,
    });

    expect(wrapped).toContain('--task-id 7');
    expect(wrapped).toContain('--unit-id 3');
  });

  it('quotes a command containing spaces and single quotes so it survives a single space-joined shell argument', () => {
    const cmd = `echo "it's a test" && run --flag value`;
    const wrapped = wrapWithSupervisor(cmd, {
      server: { name: 'srv', type: 'local' },
      target: 'azito:task-3.1',
    });

    // shellQuote wraps in single quotes and escapes embedded single quotes as '\''
    expect(wrapped).toContain(`-- 'echo "it'\\''s a test" && run --flag value'`);
  });

  it('prefixes AZITO_SUPERVISOR_LAUNCH_ID/AZITO_SUPERVISOR_BOOTSTRAP env vars when both are provided (fix/supervisor-launch-flag-compat)', () => {
    const wrapped = wrapWithSupervisor('claude', {
      server: { name: 'local-server', type: 'local' },
      target: 'azito:task-9.1',
      launchId: 'launch-abc',
      bootstrapToken: 'secret-xyz',
    });

    expect(wrapped).toMatch(/^AZITO_SUPERVISOR_LAUNCH_ID='launch-abc' AZITO_SUPERVISOR_BOOTSTRAP='secret-xyz' /);
    expect(wrapped).not.toContain('--launch-id');
    expect(wrapped).not.toContain('--bootstrap-token');
  });

  it('omits the launch env prefix when only one of the pair is provided', () => {
    const wrapped = wrapWithSupervisor('claude', {
      server: { name: 'local-server', type: 'local' },
      target: 'azito:task-9.2',
      launchId: 'launch-abc',
    });

    expect(wrapped).not.toContain('AZITO_SUPERVISOR_LAUNCH_ID');
    expect(wrapped).not.toContain('AZITO_SUPERVISOR_BOOTSTRAP');
    expect(wrapped).not.toContain('--launch-id');
    expect(wrapped).not.toContain('--bootstrap-token');
  });

  it('regression: a command with launch binding parses cleanly on a pre-Issue-#28 supervisor argv parser (no unknown-flag death)', () => {
    // Minimal reproduction of packages/tui-supervisor/src/cli.ts's parseArgs
    // BEFORE Issue #28 Phase C added --launch-id/--bootstrap-token support —
    // any flag it doesn't recognize is fatal. This is the exact failure
    // reproduced on this host: "tui-supervisor: unknown flag: --launch-id".
    function legacyParseFlags(flagArgs: string[]): void {
      for (let i = 0; i < flagArgs.length; i += 1) {
        const flag = flagArgs[i];
        switch (flag) {
          case '--server':
          case '--target':
          case '--task-id':
          case '--unit-id':
            i += 1;
            break;
          default:
            throw new Error(`tui-supervisor: unknown flag: ${flag}`);
        }
      }
    }

    const wrapped = wrapWithSupervisor('claude', {
      server: { name: 'local-server', type: 'local' },
      target: 'azito:task-9.3',
      taskId: 1,
      unitId: 2,
      launchId: 'launch-abc',
      bootstrapToken: 'secret-xyz',
    });

    // The hub types `wrapped` into the pane's shell via tmux send-keys; the
    // shell consumes the leading NAME=value assignments itself and only
    // passes the remaining tokens as argv to the supervisor binary — mirror
    // that split here.
    const withoutEnvPrefix = wrapped.replace(/^(?:\S+='[^']*'\s+)*/, '');
    const argv = withoutEnvPrefix.split(' ');
    const sepIndex = argv.indexOf('--');
    const serverFlagIndex = argv.indexOf('--server'); // skips the (variable-length) binary invocation prefix
    const flagArgs = argv.slice(serverFlagIndex, sepIndex);

    expect(() => legacyParseFlags(flagArgs)).not.toThrow();
  });

  it('prefixes AZITO_PREFIX env var when harnessPrefix is provided', () => {
    const wrapped = wrapWithSupervisor('claude', {
      server: { name: 'local-server', type: 'local' },
      target: 'azito:task-10.1',
      harnessPrefix: 'dev',
    });

    expect(wrapped).toContain("AZITO_PREFIX='dev'");
  });

  it('omits AZITO_PREFIX when harnessPrefix is not provided', () => {
    const wrapped = wrapWithSupervisor('claude', {
      server: { name: 'local-server', type: 'local' },
      target: 'azito:task-10.2',
    });

    expect(wrapped).not.toContain('AZITO_PREFIX');
  });

  it('includes AZITO_PREFIX alongside launch binding env vars when both are provided', () => {
    const wrapped = wrapWithSupervisor('claude', {
      server: { name: 'local-server', type: 'local' },
      target: 'azito:task-10.3',
      harnessPrefix: 'dev',
      launchId: 'launch-abc',
      bootstrapToken: 'secret-xyz',
    });

    expect(wrapped).toContain("AZITO_PREFIX='dev'");
    expect(wrapped).toContain("AZITO_SUPERVISOR_LAUNCH_ID='launch-abc'");
    expect(wrapped).toContain("AZITO_SUPERVISOR_BOOTSTRAP='secret-xyz'");
    // AZITO_PREFIX comes before the launch binding vars
    const prefixIdx = wrapped.indexOf('AZITO_PREFIX');
    const launchIdx = wrapped.indexOf('AZITO_SUPERVISOR_LAUNCH_ID');
    expect(prefixIdx).toBeLessThan(launchIdx);
  });

  it('resolves an agent-server command using the ~/.azito/agent/current path', () => {
    const wrapped = wrapWithSupervisor('claude', {
      server: { name: 'agent-server', type: 'agent' },
      target: 'azito:task-5.1',
    });

    expect(wrapped).toMatch(/^node ~\/\.azito\/agent\/current\/azito-supervisor\.cjs /);
  });
});

describe('resolveSupervisorCommand — local path quoting', () => {
  // A real temp repo root whose path contains a space and a single quote, so
  // both local branches (dist present / dist missing) prove the supervisor
  // path is shell-quoted and would survive the pane's shell intact.
  const spacedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "azito repo's test-"));

  afterAll(() => {
    fs.rmSync(spacedRoot, { recursive: true, force: true });
  });

  it('shell-quotes the dist bundle path when it exists (space + single quote in repo root)', () => {
    const distDir = path.join(spacedRoot, 'packages', 'tui-supervisor', 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    const distPath = path.join(distDir, 'azito-supervisor.cjs');
    fs.writeFileSync(distPath, '// stub');

    const cmd = resolveSupervisorCommand({ type: 'local' }, spacedRoot);

    expect(cmd).toBe(`node '${distPath.replace(/'/g, "'\\''")}'`);
    // The raw (unquoted) path must not appear bare after `node `
    expect(cmd).not.toBe(`node ${distPath}`);
  });

  it('shell-quotes the tsx src path when the dist bundle is missing', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'azito empty-'));
    try {
      const srcPath = path.join(emptyRoot, 'packages', 'tui-supervisor', 'src', 'main.ts');

      const cmd = resolveSupervisorCommand({ type: 'local' }, emptyRoot);

      expect(cmd).toBe(`npx tsx '${srcPath}'`);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('uses the release bundle and its bundled node when both sit at the root', () => {
    // A release install has no packages/ tree at all — resolving to the dev
    // `npx tsx .../src/main.ts` there is what made supervised windows die with
    // ERR_MODULE_NOT_FOUND. The bundled node is used because a release install
    // does not require host Node.js.
    const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'azito release-'));
    try {
      const supervisorPath = path.join(releaseRoot, 'azito-supervisor.cjs');
      const nodePath = path.join(releaseRoot, 'node');
      fs.writeFileSync(supervisorPath, '// stub');
      fs.writeFileSync(nodePath, '// stub');

      expect(resolveSupervisorCommand({ type: 'local' }, releaseRoot)).toBe(`'${nodePath}' '${supervisorPath}'`);
    } finally {
      fs.rmSync(releaseRoot, { recursive: true, force: true });
    }
  });

  it('prefers the release bundle over a dev dist bundle when both are present', () => {
    const bothRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'azito both-'));
    try {
      fs.writeFileSync(path.join(bothRoot, 'azito-supervisor.cjs'), '// stub');
      fs.writeFileSync(path.join(bothRoot, 'node'), '// stub');
      fs.mkdirSync(path.join(bothRoot, 'packages', 'tui-supervisor', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(bothRoot, 'packages', 'tui-supervisor', 'dist', 'azito-supervisor.cjs'), '// stub');

      expect(resolveSupervisorCommand({ type: 'local' }, bothRoot)).toContain(path.join(bothRoot, 'azito-supervisor.cjs'));
    } finally {
      fs.rmSync(bothRoot, { recursive: true, force: true });
    }
  });

  it('does not quote the agent path (tilde must stay expandable by the remote shell)', () => {
    expect(resolveSupervisorCommand({ type: 'agent' })).toBe('node ~/.azito/agent/current/azito-supervisor.cjs');
  });
});
