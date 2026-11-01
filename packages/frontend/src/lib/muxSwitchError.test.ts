import { describe, expect, it } from 'vitest';
import { muxSwitchErrorKey } from './muxSwitchError';

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
