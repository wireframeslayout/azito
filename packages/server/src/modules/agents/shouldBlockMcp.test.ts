import { describe, it, expect } from 'vitest';
import { shouldBlockMcp, ensureClaudeMcpBlock, ensureCodexMcpBlock } from './shouldBlockMcp';

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
      .toBe('codex --dangerously-bypass-approvals-and-sandbox -c mcp_servers.azt-mcp.enabled=false');
  });

  it('does not duplicate when already present', () => {
    const cmd = 'codex --dangerously-bypass-approvals-and-sandbox -c mcp_servers.azt-mcp.enabled=false';
    expect(ensureCodexMcpBlock(cmd)).toBe(cmd);
  });

  it('handles empty string', () => {
    expect(ensureCodexMcpBlock('')).toBe(' -c mcp_servers.azt-mcp.enabled=false');
  });
});
