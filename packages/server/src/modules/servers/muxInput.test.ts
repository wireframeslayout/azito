import { describe, it, expect } from 'vitest';
import { parseMuxInput } from './muxInput';

describe('parseMuxInput', () => {
  it('accepts an empty body', () => {
    expect(parseMuxInput({})).toEqual({ ok: true, defaultMux: undefined, muxRuntime: undefined });
  });

  it('treats empty strings as not given', () => {
    expect(parseMuxInput({ defaultMux: '', muxRuntime: '' })).toEqual({ ok: true, defaultMux: undefined, muxRuntime: undefined });
  });

  it('accepts defaultMux and muxRuntime independently', () => {
    expect(parseMuxInput({ defaultMux: 'misao' as const, muxRuntime: 'managed' })).toEqual({ ok: true, defaultMux: 'misao' as const, muxRuntime: 'managed' });
    expect(parseMuxInput({ defaultMux: 'tmux' as const, muxRuntime: 'system' })).toEqual({ ok: true, defaultMux: 'tmux' as const, muxRuntime: 'system' });
  });

  it('reads the legacy muxRuntime "misao" as defaultMux "misao"', () => {
    expect(parseMuxInput({ muxRuntime: 'misao' })).toEqual({ ok: true, defaultMux: 'misao' as const, muxRuntime: undefined });
  });

  it('accepts the legacy muxRuntime "misao" together with defaultMux "misao"', () => {
    expect(parseMuxInput({ muxRuntime: 'misao', defaultMux: 'misao' })).toEqual({ ok: true, defaultMux: 'misao' as const, muxRuntime: undefined });
  });

  it('rejects the legacy muxRuntime "misao" combined with defaultMux "tmux"', () => {
    expect(parseMuxInput({ muxRuntime: 'misao', defaultMux: 'tmux' })).toMatchObject({ ok: false });
  });

  it('rejects unknown values', () => {
    expect(parseMuxInput({ defaultMux: 'zellij' })).toEqual({ ok: false, error: 'defaultMux must be "tmux" or "misao"' });
    expect(parseMuxInput({ muxRuntime: 'herdr' })).toEqual({ ok: false, error: 'muxRuntime must be "system" or "managed"' });
    expect(parseMuxInput({ defaultMux: 1 })).toMatchObject({ ok: false });
  });
});
