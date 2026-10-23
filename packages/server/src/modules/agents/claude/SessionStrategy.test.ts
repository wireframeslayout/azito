import { describe, it, expect } from 'vitest';
import { ClaudeSessionStrategy } from './SessionStrategy';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { posixDialect } from '../../../shared/os/shellDialect';

const SESSION_ID = '71f25140-240d-4720-a01c-3888b3732806';

describe('ClaudeSessionStrategy', () => {
  const strategy = new ClaudeSessionStrategy({} as TransportFactory);

  it('starts a new session with --session-id', () => {
    expect(strategy.buildNewSessionFlags(SESSION_ID)).toBe(`--session-id ${SESSION_ID}`);
  });

  it('resumes with --resume <id> and never combines --session-id with --resume', () => {
    const flags = strategy.buildResumeFlags(SESSION_ID);
    expect(flags).toBe(`--resume ${SESSION_ID}`);
    // Claude Code rejects `--session-id` together with `--resume` unless
    // `--fork-session` is also given, so the follow-up relaunch would exit.
    expect(flags).not.toContain('--session-id');
  });

  it('builds the respawn command with --resume <id>', () => {
    const cmd = strategy.buildRespawnCommand(SESSION_ID, 'claude-opus-4-6[1m]', null, posixDialect);
    expect(cmd).toContain(`--resume ${SESSION_ID}`);
    expect(cmd).not.toContain('--session-id');
  });

  it('includes --strict-mcp-config by default', () => {
    const cmd = strategy.buildRespawnCommand(SESSION_ID, null, null, posixDialect);
    expect(cmd).toContain('--strict-mcp-config');
  });

  it('omits --strict-mcp-config when blockMcp is false (Issue #471)', () => {
    const cmd = strategy.buildRespawnCommand(SESSION_ID, null, null, posixDialect, false);
    expect(cmd).not.toContain('--strict-mcp-config');
    expect(cmd).toContain(`--resume ${SESSION_ID}`);
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  it('omits --strict-mcp-config for fresh launch when blockMcp is false', () => {
    const cmd = strategy.buildRespawnCommand(null, null, null, posixDialect, false);
    expect(cmd).not.toContain('--strict-mcp-config');
    expect(cmd).toBe('claude --dangerously-skip-permissions');
  });
});
