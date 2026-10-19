import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTransport } from './AgentTransport';
import { buildCommandSpec, CommandOutputLimitError, CommandSpawnError, CommandTimeoutError } from '../../../shared/exec/commandSpec';
import { AgentUnreachableError } from './AgentUnreachableError';

const spec = buildCommandSpec('git', ['-C', "it's here", 'status'], { cwd: '/repo', timeoutMs: 2000 });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('AgentTransport.run: the route is chosen by whether the agent host is recorded', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('an agent with a recorded host (it has POST /api/run)', () => {
    const make = (platform: 'linux' | 'win32' = 'linux') => new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform, arch: 'x64' });

    it('posts the spec to /api/run with the token, and never touches /api/exec', async () => {
      fetchSpy.mockResolvedValue(json({ outcome: 'result', exitCode: 0, signal: null, stdout: 'ok', stderr: '' }));
      const result = await make().run(spec);

      expect(result).toEqual({ exitCode: 0, signal: null, stdout: 'ok', stderr: '' });
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:4021/api/run');
      expect(init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer tok' } });
      expect(JSON.parse(init!.body as string)).toEqual(spec);
    });

    it('works for a Windows agent too (no shell involved)', async () => {
      fetchSpy.mockResolvedValue(json({ outcome: 'result', exitCode: 1, signal: null, stdout: '', stderr: 'e' }));
      expect(await make('win32').run(spec)).toMatchObject({ exitCode: 1, stderr: 'e' });
    });

    it('returns a non-zero exit code as a result', async () => {
      fetchSpy.mockResolvedValue(json({ outcome: 'result', exitCode: 128, signal: null, stdout: '', stderr: 'fatal' }));
      expect((await make().run(spec)).exitCode).toBe(128);
    });

    it.each([
      ['spawn_failed', { outcome: 'spawn_failed', code: 'ENOENT', message: 'spawn git ENOENT', stdout: 'a', stderr: 'b' }, CommandSpawnError],
      ['timeout', { outcome: 'timeout', timeoutMs: 2000, stdout: 'a', stderr: 'b' }, CommandTimeoutError],
      ['output_limit', { outcome: 'output_limit', maxOutputBytes: 10, stdout: 'a', stderr: 'b' }, CommandOutputLimitError],
    ])('turns a %s outcome into its own error, keeping the output so far', async (_name, body, errorClass) => {
      fetchSpy.mockResolvedValue(json(body));
      const err = await make().run(spec).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(errorClass);
      expect(err).toMatchObject({ stdout: 'a', stderr: 'b' });
    });

    it('does not retry through /api/exec when /api/run fails', async () => {
      fetchSpy.mockResolvedValue(json({ error: 'nope' }, 404));
      await expect(make().run(spec)).rejects.toThrow(/\/api\/run failed \(404\)/);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('rejects a body of another shape', async () => {
      fetchSpy.mockResolvedValue(json({ stdout: '', stderr: '', code: 0 }));
      await expect(make().run(spec)).rejects.toThrow();
    });

    it('reports an unreachable agent as AgentUnreachableError', async () => {
      fetchSpy.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      await expect(make().run(spec)).rejects.toBeInstanceOf(AgentUnreachableError);
    });
  });

  describe('an agent without a recorded host (before /api/run): the quoted command line through /api/exec', () => {
    const make = () => new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);

    it('posts one quoted sh line to /api/exec, never to /api/run', async () => {
      fetchSpy.mockResolvedValue(json({ stdout: 'out', stderr: '', code: 0 }));
      const result = await make().run(spec);

      expect(result).toEqual({ exitCode: 0, signal: null, stdout: 'out', stderr: '' });
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:4021/api/exec');
      expect(JSON.parse(init!.body as string)).toEqual({
        command: "cd -- '/repo' && 'git' '-C' 'it'\\''s here' 'status' </dev/null",
        timeoutMs: 2000,
      });
    });

    it('returns the real exit code', async () => {
      fetchSpy.mockResolvedValue(json({ stdout: '', stderr: 'x', code: 2 }));
      expect((await make().run(spec)).exitCode).toBe(2);
    });

    it('reads sh\'s "command not found" as a program that could not start', async () => {
      fetchSpy.mockResolvedValue(json({ stdout: '', stderr: "sh: 1: 'git': not found", code: 127 }));
      await expect(make().run(spec)).rejects.toBeInstanceOf(CommandSpawnError);
    });

    it('leaves an exit code 127 the program chose itself as a result', async () => {
      fetchSpy.mockResolvedValue(json({ stdout: '', stderr: 'custom failure', code: 127 }));
      expect((await make().run(spec)).exitCode).toBe(127);
    });

    it('counts the output cap in bytes and cuts at a character boundary (Japanese, emoji)', async () => {
      // 'あ' is 3 bytes: 4 of them are 12 bytes, over a 10 byte cap although only 4 characters long.
      fetchSpy.mockResolvedValue(json({ stdout: 'ああああ', stderr: '', code: 0 }));
      const japanese = await make().run({ ...spec, maxOutputBytes: 10 }).catch((e: unknown) => e);
      expect(japanese).toBeInstanceOf(CommandOutputLimitError);
      expect((japanese as CommandOutputLimitError).stdout).toBe('あああ');

      fetchSpy.mockResolvedValue(json({ stdout: '', stderr: '😀😀😀', code: 0 }));
      const emoji = await make().run({ ...spec, maxOutputBytes: 10 }).catch((e: unknown) => e);
      expect((emoji as CommandOutputLimitError).stderr).toBe('😀😀');
    });

    it('accepts output of exactly the cap in bytes', async () => {
      fetchSpy.mockResolvedValue(json({ stdout: 'あああ', stderr: '', code: 0 }));
      expect((await make().run({ ...spec, maxOutputBytes: 9 })).stdout).toBe('あああ');
    });

    it('keeps the output cap', async () => {
      fetchSpy.mockResolvedValue(json({ stdout: 'x'.repeat(50), stderr: '', code: 0 }));
      const err = await make().run({ ...spec, maxOutputBytes: 10 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommandOutputLimitError);
      expect((err as CommandOutputLimitError).stdout).toBe('x'.repeat(10));
    });
  });
});
