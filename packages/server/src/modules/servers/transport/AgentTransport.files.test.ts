import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTransport } from './AgentTransport';
import { ShellFileOps } from './ShellFileOps';
import { RemoteFileOps } from '../../../shared/fs/fileOpsWire';
import { FileOpsError } from '../../../shared/fs/fileOps';
import { AgentFileOpOutdatedError } from './agentFileOpsProtocol';
import { AgentUnreachableError } from './AgentUnreachableError';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('AgentTransport.files: the route is chosen by whether the agent host is recorded', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('an agent with a recorded host (it has POST /api/fileops)', () => {
    const make = (platform: 'linux' | 'win32' = 'linux') => new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform, arch: 'x64' });

    it('posts the operation to /api/fileops with the token, and never touches /api/exec', async () => {
      fetchSpy.mockResolvedValue(json({ ok: true, result: [{ name: 'a.txt', kind: 'file', size: 3 }] }));
      const entries = await make().files().list('/work');

      expect(entries).toEqual([{ name: 'a.txt', kind: 'file', size: 3 }]);
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:4021/api/fileops');
      expect(init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer tok' } });
      expect(JSON.parse(init!.body as string)).toEqual({ op: 'list', path: '/work' });
    });

    it('is a RemoteFileOps with the agent\'s own path rules, the same object each time', () => {
      const transport = make('win32');
      expect(transport.files()).toBeInstanceOf(RemoteFileOps);
      expect(transport.files().platform).toBe('win32');
      expect(transport.files()).toBe(transport.files());
    });

    it('turns a refusal of the agent into a FileOpsError', async () => {
      fetchSpy.mockResolvedValue(json({ ok: false, code: 'CONFLICT', message: 'changed', details: { currentMtimeMs: 7 } }));
      const err = await make().files().write('/work/a.txt', Buffer.from('x'), { expect: { mtimeMs: 1 } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FileOpsError);
      expect(err).toMatchObject({ code: 'CONFLICT', details: { currentMtimeMs: 7 } });
    });

    describe('searchContent against an agent that may not know the operation', () => {
      const options = { query: 'x', caseSensitive: false, wholeWord: false, regex: false, include: [], exclude: [], maxHits: 10, timeBudgetMs: 1000 };
      const issues = (path: string[], message: string) => JSON.stringify([{ code: 'x', path, message }]);

      it('says agent_outdated when the agent\'s schema does not know the operation', async () => {
        fetchSpy.mockResolvedValue(json({ error: 'invalid_file_op', message: issues(['op'], 'Invalid discriminator value') }, 400));
        await expect(make().files().searchContent('/work', options)).rejects.toBeInstanceOf(AgentFileOpOutdatedError);
      });

      it('does not blame the agent\'s age when it refused a field of the operation it knows', async () => {
        fetchSpy.mockResolvedValue(json({ error: 'invalid_file_op', message: issues(['exclude'], 'Too big') }, 400));
        const err = await make().files().searchContent('/work', options).catch((e: unknown) => e);
        expect(err).not.toBeInstanceOf(AgentFileOpOutdatedError);
        expect((err as Error).message).toMatch(/failed \(400\)/);
      });
    });

    it('does not retry through the shell when /api/fileops fails', async () => {
      fetchSpy.mockResolvedValue(json({ error: 'nope' }, 404));
      await expect(make().files().list('/work')).rejects.toThrow(/\/api\/fileops failed \(404\)/);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0][0]).toBe('http://10.0.0.1:4021/api/fileops');
    });

    it('shares the circuit breaker: an unreachable agent fails fast on the next file operation', async () => {
      fetchSpy.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      const transport = make();
      await expect(transport.files().stat('/work')).rejects.toBeInstanceOf(AgentUnreachableError);
      await expect(transport.files().stat('/work')).rejects.toMatchObject({ reason: 'circuit_open' });
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });

  describe('an agent registered before the OS was recorded (a Unix one without /api/fileops)', () => {
    const legacy = () => new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);

    it('uses shell commands through /api/exec, never /api/fileops', async () => {
      fetchSpy.mockResolvedValue(json({ stdout: 'EXISTS\n', stderr: '', code: 0 }));
      const transport = legacy();
      expect(transport.files()).toBeInstanceOf(ShellFileOps);
      expect(transport.files().platform).toBe('linux');
      await transport.files().stat('/work/a.txt').catch(() => undefined);
      expect(fetchSpy).toHaveBeenCalled();
      for (const [url] of fetchSpy.mock.calls) expect(url).toBe('http://10.0.0.1:4021/api/exec');
    });
  });
});
