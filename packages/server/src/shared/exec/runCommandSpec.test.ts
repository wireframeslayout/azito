import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import {
  CommandOutputLimitError,
  CommandSpawnError,
  CommandTimeoutError,
  buildCommandSpec,
  parseCommandSpec,
} from './commandSpec';
import { runCommandSpec } from './runCommandSpec';

/** `node -e <script> <args...>`: the one program every platform the tests run on has. */
function node(script: string, args: string[] = [], options: Parameters<typeof buildCommandSpec>[2] = {}) {
  return buildCommandSpec(process.execPath, ['-e', script, ...args], options);
}

describe('runCommandSpec', () => {
  it('returns stdout and stderr with exit code 0', async () => {
    const result = await runCommandSpec(node('process.stdout.write("out"); process.stderr.write("err")'));
    expect(result).toEqual({ exitCode: 0, signal: null, stdout: 'out', stderr: 'err' });
  });

  it('returns a non-zero exit code as a result, with the output', async () => {
    const result = await runCommandSpec(node('process.stderr.write("bad"); process.exit(3)'));
    expect(result).toEqual({ exitCode: 3, signal: null, stdout: '', stderr: 'bad' });
  });

  it('passes arguments as they are, with no shell splitting or expansion', async () => {
    const tricky = ['a b', '$HOME', '"q"', "it's", '*', '', ';echo pwned', '日本語'];
    const result = await runCommandSpec(node('process.stdout.write(JSON.stringify(process.argv.slice(1)))', tricky));
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  it('runs in cwd', async () => {
    const dir = os.tmpdir();
    const result = await runCommandSpec(node('process.stdout.write(process.cwd())', [], { cwd: dir }));
    expect(result.stdout.toLowerCase()).toBe(fs.realpathSync.native(dir).toLowerCase());
  });

  it('adds env to the process environment', async () => {
    const result = await runCommandSpec(node('process.stdout.write(process.env.AZITO_RUN_TEST + "|" + (process.env.PATH ? "path" : "nopath"))', [], { env: { AZITO_RUN_TEST: 'v 1' } }));
    expect(result.stdout).toBe('v 1|path');
  });

  it('feeds stdin and closes it', async () => {
    const result = await runCommandSpec(node('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))', [], { stdin: 'hello\nworld' }));
    expect(result.stdout).toBe('HELLO\nWORLD');
  });

  it('closes stdin when none is given, so a program that reads it does not hang', async () => {
    const result = await runCommandSpec(node('process.stdin.on("data",()=>{}).on("end",()=>process.stdout.write("eof"))', [], { timeoutMs: 10_000 }));
    expect(result.stdout).toBe('eof');
  });

  it('rejects with a spawn error for a program that does not exist', async () => {
    const err = await runCommandSpec(buildCommandSpec('azito-no-such-program-xyz', [])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandSpawnError);
    expect((err as CommandSpawnError).code).toBe('ENOENT');
  });

  it('rejects with a spawn error for a cwd that does not exist', async () => {
    const err = await runCommandSpec(node('', [], { cwd: os.tmpdir() + '/azito-no-such-dir-xyz' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandSpawnError);
  });

  it('rejects .cmd and .bat files with the reason, on every OS', async () => {
    for (const file of ['build.cmd', 'C:\\x\\RUN.BAT']) {
      const err = await runCommandSpec(buildCommandSpec(file, [])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommandSpawnError);
      expect((err as CommandSpawnError).code).toBe('UNSUPPORTED_FILE');
      expect((err as CommandSpawnError).message).toContain('without one');
    }
  });

  it('rejects with a timeout error that keeps the output so far', async () => {
    const err = await runCommandSpec(node('process.stdout.write("partial"); setInterval(()=>{}, 1000)', [], { timeoutMs: 400 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandTimeoutError);
    expect((err as CommandTimeoutError).stdout).toBe('partial');
    expect((err as CommandTimeoutError).timeoutMs).toBe(400);
  });

  it('rejects with an output-limit error that keeps the output so far', async () => {
    const err = await runCommandSpec(node('process.stdout.write("x".repeat(100000)); setInterval(()=>{}, 1000)', [], { maxOutputBytes: 1000, timeoutMs: 10_000 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandOutputLimitError);
    expect((err as CommandOutputLimitError).stdout.length).toBeGreaterThan(0);
    expect((err as CommandOutputLimitError).stdout.length).toBeLessThanOrEqual(1000);
  });
});

describe('parseCommandSpec', () => {
  const valid = { file: 'git', args: ['status'], timeoutMs: 1000, maxOutputBytes: 1000 };

  it('accepts a valid spec', () => {
    expect(parseCommandSpec(valid)).toEqual(valid);
  });

  it.each([
    ['an empty file', { ...valid, file: '' }],
    ['a NUL byte in an argument', { ...valid, args: ['a\0b'] }],
    ['args that are not strings', { ...valid, args: [1] }],
    ['a zero timeout', { ...valid, timeoutMs: 0 }],
    ['a timeout past the cap', { ...valid, timeoutMs: 10_000_000 }],
    ['an output cap past the cap', { ...valid, maxOutputBytes: 10 ** 10 }],
    ['a missing timeout', { file: 'git', args: [], maxOutputBytes: 1 }],
    ['a non-string env value', { ...valid, env: { A: 1 } }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseCommandSpec(input)).toThrow();
  });
});
