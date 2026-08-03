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
