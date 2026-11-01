import { describe, expect, it } from 'vitest';
import { muxSwitchErrorKey, describeWakeError, isMuxSwitchError } from './muxSwitchError';

describe('mux switch errors', () => {
  it.each([
    ['misao_unavailable', 'daemon_unreachable', 'terminal.muxErrorDaemon'],
    ['misao_unavailable', 'not_installed', 'terminal.muxErrorNotInstalled'],
    ['misao_unavailable', 'protocol_incompatible', 'terminal.muxErrorProtocol'],
    ['misao_unavailable', 'driver_not_registered', 'terminal.muxErrorDriver'],
    ['misao_unavailable', 'unsupported_os', 'terminal.muxErrorOs'],
    ['misao_unavailable', 'other', 'terminal.muxErrorUnknown'],
    ['window_busy', undefined, 'terminal.muxErrorBusy'],
    ['unsupported_switch', undefined, 'terminal.muxErrorUnsupported'],
  ])('maps %s %s', (error, reason, expected) => expect(muxSwitchErrorKey(error, reason)).toBe(expected));
});

describe('wake error presentation', () => {
  const translate = (key: string) => ({
    'terminal.muxErrorDaemon': 'Cannot connect to misao.',
    'terminal.muxErrorGuide': 'Check Settings › System.',
    'terminal.muxErrorUnknown': 'Could not reopen.',
  }[key] ?? key);
  it.each(['conversation_unverifiable', 'unsupported_os', 'session_already_running'])('preserves server error %s', (error) => {
    expect(describeWakeError({ error }, translate)).toBe(error);
    expect(describeWakeError({ error, message: 'server explanation' }, translate)).toBe('server explanation');
    expect(isMuxSwitchError(error)).toBe(false);
  });
  it('translates misao unavailability and includes the system guidance', () => {
    expect(describeWakeError({ error: 'misao_unavailable', reason: 'daemon_unreachable' }, translate)).toBe('Cannot connect to misao. Check Settings › System.');
  });
  it('does not add misao guidance to a busy window', () => {
    expect(describeWakeError({ error: 'window_busy' }, translate)).toBe('terminal.muxErrorBusy');
  });
});
