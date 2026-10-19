import { describe, it, expect } from 'vitest';
import { buildHeadlessLaunchCommand, buildWorkerLaunchCommand } from './LaunchCommand';

describe('buildWorkerLaunchCommand', () => {
  it('builds claude command with no model or extra args', () => {
    expect(buildWorkerLaunchCommand('claude', null, null)).toBe(
      'claude --dangerously-skip-permissions --strict-mcp-config',
    );
  });

  it('builds claude command with model', () => {
    expect(buildWorkerLaunchCommand('claude', 'claude-opus-4-5', null)).toBe(
      "claude --dangerously-skip-permissions --strict-mcp-config --model 'claude-opus-4-5'",
    );
  });

  it('single-quotes Claude 1M context model suffix to avoid shell glob expansion', () => {
    const result = buildWorkerLaunchCommand('claude', 'claude-opus-4-6[1m]', null);
    expect(result).toBe(
      "claude --dangerously-skip-permissions --strict-mcp-config --model 'claude-opus-4-6[1m]'",
    );
  });

  it('appends extraArgs after model flag (shell-quoted)', () => {
    const result = buildWorkerLaunchCommand('claude', 'claude-sonnet-4-6', '--verbose');
    expect(result).toBe(
      "claude --dangerously-skip-permissions --strict-mcp-config --model 'claude-sonnet-4-6' '--verbose'",
    );
  });

  it('trims whitespace from extraArgs', () => {
    const result = buildWorkerLaunchCommand('claude', null, '  --verbose  ');
    expect(result).toBe("claude --dangerously-skip-permissions --strict-mcp-config '--verbose'");
  });

  it('builds codex command with model', () => {
    expect(buildWorkerLaunchCommand('codex', 'gpt-5.6-sol', null)).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox -c mcp_servers.azt-mcp.enabled=false --model 'gpt-5.6-sol'",
    );
  });

  it('builds codex command with no model', () => {
    expect(buildWorkerLaunchCommand('codex', null, null)).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox -c mcp_servers.azt-mcp.enabled=false',
    );
  });

  it('returns extraArgs as-is for generic type', () => {
    expect(buildWorkerLaunchCommand('generic', null, 'my-custom-tool --flag')).toBe(
      'my-custom-tool --flag',
    );
  });

  it('returns null for generic type with no extraArgs', () => {
    expect(buildWorkerLaunchCommand('generic', null, null)).toBeNull();
  });

  it('returns null for null type with no extraArgs', () => {
    expect(buildWorkerLaunchCommand(null, null, null)).toBeNull();
  });

  it('returns extraArgs for unknown type', () => {
    expect(buildWorkerLaunchCommand('unknown-tool', null, 'some-cmd')).toBe('some-cmd');
  });

  it('returns null for unknown type with empty extraArgs', () => {
    expect(buildWorkerLaunchCommand('unknown-tool', null, '   ')).toBeNull();
  });
});

describe('buildHeadlessLaunchCommand', () => {
  it('builds claude -p command with model', () => {
    expect(buildHeadlessLaunchCommand('claude', 'claude-opus-4-5')).toBe(
      "claude -p --model 'claude-opus-4-5'",
    );
  });

  it('builds codex exec command with model', () => {
    expect(buildHeadlessLaunchCommand('codex', 'gpt-5.6-sol')).toBe(
      "codex exec --ignore-user-config --model 'gpt-5.6-sol'",
    );
  });

  it('returns null for unknown provider', () => {
    expect(buildHeadlessLaunchCommand('generic', 'some-model')).toBeNull();
  });

  it('escapes single quotes in model name', () => {
    expect(buildHeadlessLaunchCommand('claude', "model'inject")).toBe(
      "claude -p --model 'model'\\''inject'",
    );
  });
});
