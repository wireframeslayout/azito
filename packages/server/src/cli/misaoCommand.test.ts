import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/releaseInfo', () => ({ getBundleRoot: () => null }));

import { misaoCommand } from './misaoCommand';

describe('azito misao', () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('prints the usage without a command', async () => {
    await misaoCommand([]);
    expect(out.join('\n')).toContain('Usage: azito misao');
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects an unknown option as a usage error, not a crash', async () => {
    await misaoCommand(['install', '--bogus']);
    expect(err.join('\n')).toContain('Unknown option: --bogus');
    expect(process.exitCode).toBe(1);
  });

  it('reports a source checkout as unmanaged in status and refuses to install', async () => {
    await misaoCommand(['status']);
    expect(out.join('\n')).toContain('source_install');

    await misaoCommand(['install']);
    expect(err.join('\n')).toContain('source checkout');
    expect(process.exitCode).toBe(1);
  });

  it('does not update without confirmation when there is no terminal to ask on', async () => {
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await misaoCommand(['update']);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
    }
    expect(err.join('\n')).toContain('confirmation is required');
    expect(process.exitCode).toBe(1);
  });
});
