import { fixture } from '../tasks/execution/runtime/fixtures/readFixture';
import { describe, expect, it, vi } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { ServerConfig } from '../servers/Server';
import { guardChatInput } from './chatInputGuard';

const server = {} as ServerConfig;
const pane = asPaneHandle('%1');
const ready = '● ready\n──────────────\n❯\n──────────────\nbypass permissions on';
function driver(command: string | null, screen: string, code = 0): IMuxClient {
  return { paneCommandByHandle: vi.fn().mockResolvedValue(command), captureScreen: vi.fn().mockResolvedValue({ stdout: screen, stderr: '', code }) } as unknown as IMuxClient;
}
describe('guardChatInput', () => {
  it('accepts an empty Claude input', async () => {
    expect(await guardChatInput(driver('node', ready), server, pane, 'claude', 'hello')).toBeNull();
  });
  it('accepts the captured named input and rejects a modified draft', async () => {
    const screen = fixture('claude-2.1.317-named-empty.txt');
    expect(await guardChatInput(driver('node', screen), server, pane, 'claude', 'hello')).toBeNull();
    expect(await guardChatInput(driver('node', screen.replace('❯ \n', '❯ draft\n')), server, pane, 'claude', 'hello')).toMatchObject({ code: 'input_not_empty' });
  });
  it('accepts an empty Codex input', async () => {
    const screen = '› Ask Codex to do anything\n\n? for shortcuts';
    expect(await guardChatInput(driver('codex', screen), server, pane, 'codex', 'hello')).toBeNull();
  });
  it('accepts a tab', async () => {
    expect(await guardChatInput(driver('node', ready), server, pane, 'claude', 'a\tb')).toBeNull();
  });
  it.each([
    ['shell', driver('bash', ready), 'claude', 'hello', 'worker_exited_to_shell'],
    ['dialog', driver('node', 'Do you trust this folder?'), 'claude', 'hello', 'trust_dialog'],
    ['codex update', driver('codex', 'Update available Update now Skip until next version'), 'codex', 'hello', 'codex_update_prompt'],
    ['codex trust', driver('codex', 'Trust this folder? Trust and continue Quit'), 'codex', 'hello', 'codex_trust_prompt'],
    ['bypass', driver('node', 'WARNING: Claude Code running in Bypass Permissions mode Yes, I accept No, exit'), 'claude', 'hello', 'bypass_permissions_dialog'],
    ['capture failure', driver('node', ready, 1), 'claude', 'hello', 'screen_unavailable'],
    ['unknown worker', driver('node', ready), 'generic', 'hello', 'unsupported_worker'],
    ['not ready', driver('node', 'loading'), 'claude', 'hello', 'not_ready'],
    ['draft', driver('node', ready.replace('❯', '❯ draft')), 'claude', 'hello', 'input_not_empty'],
    ['escape', driver('node', ready), 'claude', 'hello\x1b[201~', 'invalid_control_character'],
  ])('rejects %s', async (_name, mux, kind, text, code) => {
    expect(await guardChatInput(mux, server, pane, kind, text)).toMatchObject({ code });
  });
  it('propagates capture errors', async () => {
    const mux = driver('node', ready);
    vi.mocked(mux.captureScreen).mockRejectedValue(new Error('capture failed'));
    await expect(guardChatInput(mux, server, pane, 'claude', 'hello')).rejects.toThrow('capture failed');
  });

});
