import { describe, expect, it } from 'vitest';
import {
  effectiveMuxKind,
  initialMuxKind,
  isMuxKindUnavailable,
  muxCreateFailureText,
  muxKindAvailability,
  muxKindReason,
  muxKindSelectModel,
  type MuxAvailabilityState,
} from './muxKindChoice';

const ready = (unavailable: Array<{ kind: 'tmux' | 'misao'; reason: string }> = []): MuxAvailabilityState => ({ status: 'ready', unavailable });
const local = { type: 'local', defaultMux: 'tmux' as const };
const localMisao = { type: 'local', defaultMux: 'misao' as const };
const agent = { type: 'agent', defaultMux: 'tmux' as const };

describe('muxKindReason', () => {
  it('names why misao is down and says tmux is missing for any tmux failure', () => {
    expect(muxKindReason('misao', 'daemon_unreachable')).toBe('misaoUnreachable');
    expect(muxKindReason('misao', 'protocol_incompatible')).toBe('misaoIncompatible');
    expect(muxKindReason('misao', 'driver_not_registered')).toBe('misaoNotRegistered');
    expect(muxKindReason('misao', 'driver_error')).toBe('unavailable');
    expect(muxKindReason('tmux', 'binary_missing')).toBe('tmuxMissing');
    expect(muxKindReason('tmux', 'driver_error')).toBe('unavailable');
  });
});

describe('muxKindAvailability', () => {
  it('rules nothing out while loading or when the check failed', () => {
    for (const state of [{ status: 'loading' }, { status: 'error' }] as const) {
      expect(muxKindAvailability(state)).toEqual({ tmux: { ok: true }, misao: { ok: true } });
    }
  });

  it('marks the kinds the listing reports as unavailable, with their reason', () => {
    expect(muxKindAvailability(ready([{ kind: 'misao', reason: 'daemon_unreachable' }]))).toEqual({
      tmux: { ok: true },
      misao: { ok: false, reason: 'misaoUnreachable' },
    });
  });
});

describe('initial and effective kind', () => {
  const kinds = ['misao', 'tmux'] as const;
  const misaoDown = muxKindAvailability(ready([{ kind: 'misao', reason: 'daemon_unreachable' }]));
  const allOk = muxKindAvailability(ready());

  it('starts on the server default', () => {
    expect(initialMuxKind('tmux', allOk, kinds)).toBe('tmux');
    expect(initialMuxKind('misao', allOk, kinds)).toBe('misao');
  });

  it('starts on the other kind when the default is down, and stays on the default when nothing is usable', () => {
    expect(initialMuxKind('misao', misaoDown, kinds)).toBe('tmux');
    const bothDown = muxKindAvailability(ready([{ kind: 'misao', reason: 'daemon_unreachable' }, { kind: 'tmux', reason: 'driver_error' }]));
    expect(initialMuxKind('misao', bothDown, kinds)).toBe('misao');
  });

  it('keeps the user pick while it is usable, and falls back to the initial kind once it goes down', () => {
    expect(effectiveMuxKind('misao', 'tmux', allOk, kinds)).toBe('misao');
    expect(effectiveMuxKind('misao', 'tmux', misaoDown, kinds)).toBe('tmux');
    expect(effectiveMuxKind(null, 'misao', allOk, kinds)).toBe('misao');
  });

  it('ignores a pick the server does not offer', () => {
    expect(effectiveMuxKind('misao', 'tmux', allOk, ['tmux'])).toBe('tmux');
  });
});

describe('muxKindSelectModel', () => {
  it('is hidden on a server that offers tmux only', () => {
    const model = muxKindSelectModel(agent, ready(), null);
    expect(model.visible).toBe(false);
    expect(model.value).toBe('tmux');
  });

  it('offers both kinds on a local server, starting on its default', () => {
    expect(muxKindSelectModel(local, ready(), null)).toMatchObject({ visible: true, kinds: ['misao', 'tmux'], value: 'tmux' });
    expect(muxKindSelectModel(localMisao, ready(), null).value).toBe('misao');
  });

  it('reports loading and a failed check', () => {
    expect(muxKindSelectModel(local, { status: 'loading' }, null)).toMatchObject({ loading: true, checkFailed: false });
    expect(muxKindSelectModel(local, { status: 'error' }, null)).toMatchObject({ loading: false, checkFailed: true });
  });

  it('carries the disabled reason of the down kind', () => {
    const model = muxKindSelectModel(localMisao, ready([{ kind: 'misao', reason: 'protocol_incompatible' }]), null);
    expect(model.availability.misao).toEqual({ ok: false, reason: 'misaoIncompatible' });
    expect(model.value).toBe('tmux');
  });
});

describe('isMuxKindUnavailable', () => {
  it('recognises the 409 body only', () => {
    expect(isMuxKindUnavailable({ error: 'mux_kind_unavailable', kind: 'misao', reason: 'daemon_unreachable' })).toBe(true);
    expect(isMuxKindUnavailable({ error: 'window_exists', windowName: 'x' })).toBe(false);
    expect(isMuxKindUnavailable({ error: 'mux_kind_unavailable', kind: 'zellij', reason: 'x' })).toBe(false);
    expect(isMuxKindUnavailable(null)).toBe(false);
  });
});

describe('muxCreateFailureText', () => {
  const t = (key: string, options?: Record<string, string>): string => `${key}${options ? JSON.stringify(options) : ''}`;

  it('words the 409 for an unusable kind with the kind and the reason', () => {
    const text = muxCreateFailureText({ error: 'mux_kind_unavailable', kind: 'tmux', reason: 'binary_missing' }, t);
    expect(text).toContain('addWindow.muxKindUnavailable');
    expect(text).toContain('muxKind.reason.tmuxMissing');
    expect(text).not.toContain('mux_kind_unavailable');
  });

  it('shows another error as its own message and returns null for a success body', () => {
    expect(muxCreateFailureText({ error: 'create failed: duplicate session' }, t)).toBe('create failed: duplicate session');
    expect(muxCreateFailureText({ ok: true, ref: 'x' }, t)).toBeNull();
  });
});
