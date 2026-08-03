import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolvePublicUrl } from './resolvePublicUrl';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFileMock(...args) }));

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  delete process.env.AZITO_PUBLIC_URL;
  execFileMock.mockReset();
  warnSpy.mockClear();
});

afterEach(() => {
  delete process.env.AZITO_PUBLIC_URL;
});

describe('resolvePublicUrl', () => {
  it('returns AZITO_PUBLIC_URL when set', async () => {
    process.env.AZITO_PUBLIC_URL = 'https://my-hub.example.com';
    const url = await resolvePublicUrl(3001, '127.0.0.1');
    expect(url).toBe('https://my-hub.example.com');
    expect(execFileMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns tailscale IP when available', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, '100.64.1.42\n');
    });
    const url = await resolvePublicUrl(3001, '100.64.1.42');
    expect(url).toBe('http://100.64.1.42:3001');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to localhost when tailscale is not available', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(new Error('command not found'));
    });
    const url = await resolvePublicUrl(4000, '127.0.0.1');
    expect(url).toBe('http://localhost:4000');
  });

  it('falls back to localhost when tailscale returns invalid output', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, 'not-an-ip\n');
    });
    const url = await resolvePublicUrl(3001, '127.0.0.1');
    expect(url).toBe('http://localhost:3001');
  });

  it('warns when bind is 127.0.0.1 and tailscale IP is used', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, '100.64.1.42\n');
    });
    const url = await resolvePublicUrl(3001, '127.0.0.1');
    expect(url).toBe('http://100.64.1.42:3001');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unreachable while AZITO_BIND=127.0.0.1'),
    );
  });

  it('does not warn when bind matches a non-localhost address', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, '100.64.1.42\n');
    });
    const url = await resolvePublicUrl(3001, '100.64.1.42');
    expect(url).toBe('http://100.64.1.42:3001');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when AZITO_PUBLIC_URL is set even with localhost bind', async () => {
    process.env.AZITO_PUBLIC_URL = 'https://myhost.ts.net';
    const url = await resolvePublicUrl(3001, '127.0.0.1');
    expect(url).toBe('https://myhost.ts.net');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
