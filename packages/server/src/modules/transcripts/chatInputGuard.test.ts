import { describe, expect, it, vi } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { ServerConfig } from '../servers/Server';
import { guardChatInput } from './chatInputGuard';

const server = {} as ServerConfig;
const pane = asPaneHandle('%1');
const ready = '──────────────\n❯\n──────────────\nbypass permissions on';
function driver(command: string | null, screen: string, code = 0): IMuxClient {
  return { paneCommandByHandle: vi.fn().mockResolvedValue(command), captureScreen: vi.fn().mockResolvedValue({ stdout: screen, stderr: '', code }) } as unknown as IMuxClient;
}
describe('guardChatInput', () => {
  it('accepts an empty Claude input', async () => {
    expect(await guardChatInput(driver('node', ready), server, pane, 'claude', 'hello')).toBeNull();
  });
  it('accepts an empty Codex input', async () => {
    const screen = '› Ask Codex to do anything\n\n? for shortcuts';
    expect(await guardChatInput(driver('codex', screen), server, pane, 'codex', 'hello')).toBeNull();
  });
  it.each([
    ['shell', driver('bash', ready), 'claude', 'hello'],
    ['dialog', driver('node', 'Do you trust this folder?'), 'claude', 'hello'],
    ['codex update', driver('codex', 'Update available Update now Skip until next version'), 'codex', 'hello'],
    ['codex trust', driver('codex', 'Trust this folder? Trust and continue Quit'), 'codex', 'hello'],
    ['bypass', driver('node', 'WARNING: Claude Code running in Bypass Permissions mode Yes, I accept No, exit'), 'claude', 'hello'],
    ['capture failure', driver('node', ready, 1), 'claude', 'hello'],
    ['unknown worker', driver('node', ready), 'generic', 'hello'],
    ['draft', driver('node', ready.replace('❯', '❯ draft')), 'claude', 'hello'],
    ['escape', driver('node', ready), 'claude', 'hello\x1b[201~'],
  ])('rejects %s', async (_name, mux, kind, text) => {
    expect(await guardChatInput(mux, server, pane, kind, text)).not.toBeNull();
  });
});
