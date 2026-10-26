import { describe, it, expect } from 'vitest';
import { shouldBlockMcp, ensureClaudeMcpBlock, ensureCodexMcpBlock, ensureMcpBlockByCommand } from './shouldBlockMcp';

describe('shouldBlockMcp', () => {
  it('blocks when isPrimary is undefined (fail-closed)', () => {
    expect(shouldBlockMcp({ isPrimary: undefined, linkedTask: null })).toBe(true);
  });

  it('blocks when isPrimary is true (worker pane)', () => {
    expect(shouldBlockMcp({ isPrimary: true, linkedTask: null })).toBe(true);
  });

  it('blocks when isPrimary is true even with executionAllowed', () => {
    expect(shouldBlockMcp({ isPrimary: true, linkedTask: { executionAllowed: true } })).toBe(true);
  });

  it('does not block user-added window with no linked task', () => {
    expect(shouldBlockMcp({ isPrimary: false, linkedTask: null })).toBe(false);
  });

  it('blocks user-added window when task lookup failed (unknown)', () => {
    expect(shouldBlockMcp({ isPrimary: false, linkedTask: 'unknown' })).toBe(true);
  });

  it('does not block user-added window when task execution is allowed', () => {
    expect(shouldBlockMcp({ isPrimary: false, linkedTask: { executionAllowed: true } })).toBe(false);
  });

  it('blocks user-added window when task execution is not allowed', () => {
    expect(shouldBlockMcp({ isPrimary: false, linkedTask: { executionAllowed: false } })).toBe(true);
  });
});

describe('ensureClaudeMcpBlock', () => {
  it('appends --strict-mcp-config when absent', () => {
    expect(ensureClaudeMcpBlock('claude --dangerously-skip-permissions'))
      .toBe('claude --dangerously-skip-permissions --strict-mcp-config');
  });

  it('does not duplicate when already present', () => {
    const cmd = 'claude --dangerously-skip-permissions --strict-mcp-config';
    expect(ensureClaudeMcpBlock(cmd)).toBe(cmd);
  });

  it('handles empty string', () => {
    expect(ensureClaudeMcpBlock('')).toBe(' --strict-mcp-config');
  });
});

describe('ensureCodexMcpBlock', () => {
  it('appends codex MCP disable flag when absent', () => {
    expect(ensureCodexMcpBlock('codex --dangerously-bypass-approvals-and-sandbox'))
      .toBe('codex --dangerously-bypass-approvals-and-sandbox -c mcp_servers.azt-mcp.enabled=false -c mcp_servers.azt-mcp.command=azt-mcp-disabled');
  });

  it('does not duplicate when already present', () => {
    const cmd = 'codex --dangerously-bypass-approvals-and-sandbox -c mcp_servers.azt-mcp.enabled=false -c mcp_servers.azt-mcp.command=azt-mcp-disabled';
    expect(ensureCodexMcpBlock(cmd)).toBe(cmd);
  });

  it('adds only the missing command override to a line that already disables azt-mcp (#522)', () => {
    expect(ensureCodexMcpBlock('codex -c mcp_servers.azt-mcp.enabled=false'))
      .toBe('codex -c mcp_servers.azt-mcp.enabled=false -c mcp_servers.azt-mcp.command=azt-mcp-disabled');
  });

  it('handles empty string', () => {
    expect(ensureCodexMcpBlock('')).toBe(' -c mcp_servers.azt-mcp.enabled=false -c mcp_servers.azt-mcp.command=azt-mcp-disabled');
  });
});

describe('ensureMcpBlockByCommand', () => {
  it('applies claude MCP block when command starts with claude', () => {
    expect(ensureMcpBlockByCommand('claude --dangerously-skip-permissions'))
      .toBe('claude --dangerously-skip-permissions --strict-mcp-config');
  });

  it('applies codex MCP block when command starts with codex', () => {
    expect(ensureMcpBlockByCommand('codex --dangerously-bypass-approvals-and-sandbox'))
      .toBe('codex --dangerously-bypass-approvals-and-sandbox -c mcp_servers.azt-mcp.enabled=false -c mcp_servers.azt-mcp.command=azt-mcp-disabled');
  });

  it('returns command unchanged for unrecognised CLI tool', () => {
    const cmd = '/usr/local/bin/my-agent --flag';
    expect(ensureMcpBlockByCommand(cmd)).toBe(cmd);
  });

  it('does not match claude/codex mid-string', () => {
    const cmd = '/opt/claude --flag';
    expect(ensureMcpBlockByCommand(cmd)).toBe(cmd);
  });

  it('does not duplicate existing flags', () => {
    const cmd = 'claude --strict-mcp-config';
    expect(ensureMcpBlockByCommand(cmd)).toBe(cmd);
  });
});
