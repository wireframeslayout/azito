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
import type { CommandSpec } from './commandSpec';

const isWindows = process.platform === 'win32';
/** A short grace period, so a command that ignores the polite stop is killed within the test's patience. */
const run = (spec: CommandSpec) => runCommandSpec(spec, { windows: isWindows, killGraceMs: 150 });

/** Settles within `ms` or fails the test: the point of these tests is that a call never hangs. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still running after ${ms}ms`)), ms); });
  try { return await Promise.race([promise, limit]); } finally { clearTimeout(timer); }
}

/** `node -e <script> <args...>`: the one program every platform the tests run on has. */
function node(script: string, args: string[] = [], options: Parameters<typeof buildCommandSpec>[2] = {}) {
  return buildCommandSpec(process.execPath, ['-e', script, ...args], options);
}

describe('runCommandSpec', () => {
  it('returns stdout and stderr with exit code 0', async () => {
    const result = await run(node('process.stdout.write("out"); process.stderr.write("err")'));
    expect(result).toEqual({ exitCode: 0, signal: null, stdout: 'out', stderr: 'err' });
  });

  it('returns a non-zero exit code as a result, with the output', async () => {
    const result = await run(node('process.stderr.write("bad"); process.exit(3)'));
    expect(result).toEqual({ exitCode: 3, signal: null, stdout: '', stderr: 'bad' });
  });

  it('passes arguments as they are, with no shell splitting or expansion', async () => {
    const tricky = ['a b', '$HOME', '"q"', "it's", '*', '', ';echo pwned', '日本語'];
    const result = await run(node('process.stdout.write(JSON.stringify(process.argv.slice(1)))', tricky));
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  it('runs in cwd', async () => {
    const dir = os.tmpdir();
    const result = await run(node('process.stdout.write(process.cwd())', [], { cwd: dir }));
    // Both sides resolved: the OS may hand the directory back by another spelling (a symlink, a Windows 8.3 short name).
    expect(fs.realpathSync.native(result.stdout).toLowerCase()).toBe(fs.realpathSync.native(dir).toLowerCase());
  });

  it('adds env to the process environment', async () => {
    const result = await run(node('process.stdout.write(process.env.AZITO_RUN_TEST + "|" + (process.env.PATH ? "path" : "nopath"))', [], { env: { AZITO_RUN_TEST: 'v 1' } }));
    expect(result.stdout).toBe('v 1|path');
  });

  it('feeds stdin and closes it', async () => {
    const result = await run(node('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))', [], { stdin: 'hello\nworld' }));
    expect(result.stdout).toBe('HELLO\nWORLD');
  });

  it('closes stdin when none is given, so a program that reads it does not hang', async () => {
    const result = await run(node('process.stdin.on("data",()=>{}).on("end",()=>process.stdout.write("eof"))', [], { timeoutMs: 10_000 }));
    expect(result.stdout).toBe('eof');
  });

  it('rejects with a spawn error for a program that does not exist', async () => {
    const err = await run(buildCommandSpec('azito-no-such-program-xyz', [])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandSpawnError);
    expect((err as CommandSpawnError).code).toBe('ENOENT');
  });

  it('rejects with a spawn error for a cwd that does not exist', async () => {
    const err = await run(node('', [], { cwd: os.tmpdir() + '/azito-no-such-dir-xyz' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandSpawnError);
  });

  it('rejects .cmd and .bat files with the reason, on every OS', async () => {
    for (const file of ['build.cmd', 'C:\\x\\RUN.BAT']) {
      const err = await run(buildCommandSpec(file, [])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommandSpawnError);
      expect((err as CommandSpawnError).code).toBe('UNSUPPORTED_FILE');
      expect((err as CommandSpawnError).message).toContain('without one');
    }
  });

  it('rejects with a timeout error that keeps the output so far', async () => {
    const err = await run(node('process.stdout.write("partial"); setInterval(()=>{}, 1000)', [], { timeoutMs: 400 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandTimeoutError);
    expect((err as CommandTimeoutError).stdout).toBe('partial');
    expect((err as CommandTimeoutError).timeoutMs).toBe(400);
  });

  it('rejects with an output-limit error that keeps the output so far', async () => {
    const err = await run(node('process.stdout.write("x".repeat(100000)); setInterval(()=>{}, 1000)', [], { maxOutputBytes: 1000, timeoutMs: 10_000 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandOutputLimitError);
    expect((err as CommandOutputLimitError).stdout.length).toBeGreaterThan(0);
    expect((err as CommandOutputLimitError).stdout.length).toBeLessThanOrEqual(1000);
  });
});

// The deadline and the output limit belong to the runner, not to the command: whatever the command does when it is stopped.
describe('runCommandSpec: stopping a command', () => {
  const timeoutOf = (script: string, timeoutMs = 300) => within(8000, run(node(script, [], { timeoutMs })).catch((e: unknown) => e));

  it('fails with a timeout, not a hang, for a command that ignores SIGTERM (it is killed after the grace period)', async () => {
    const err = await timeoutOf('process.on("SIGTERM", () => {}); process.stdout.write("up"); setInterval(()=>{}, 1000)');
    expect(err).toBeInstanceOf(CommandTimeoutError);
    expect((err as CommandTimeoutError).stdout).toBe('up');
  });

  it('fails with a timeout, not success, for a command that exits 0 when it gets SIGTERM', async () => {
    const err = await timeoutOf('process.on("SIGTERM", () => process.exit(0)); setInterval(()=>{}, 1000)');
    expect(err).toBeInstanceOf(CommandTimeoutError);
  });

  it('fails with a timeout, not a plain failure, for a command that exits 1 when it gets SIGTERM', async () => {
    const err = await timeoutOf('process.on("SIGTERM", () => process.exit(1)); setInterval(()=>{}, 1000)');
    expect(err).toBeInstanceOf(CommandTimeoutError);
  });

  it('stops a command that ignores SIGTERM when it writes past the output limit', async () => {
    const err = await within(8000, run(node('process.on("SIGTERM", () => {}); process.stdout.write("x".repeat(5000)); setInterval(()=>{}, 1000)', [], { maxOutputBytes: 100, timeoutMs: 10_000 })).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(CommandOutputLimitError);
  });

  it.skipIf(isWindows)('kills the whole process group: a grandchild that holds the pipes and ignores SIGTERM does not keep the call open', async () => {
    const script = `
      const { spawn } = require("child_process");
      spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(()=>{}, 1000)"], { stdio: "inherit" });
      process.on("SIGTERM", () => process.exit(0));
      setInterval(()=>{}, 1000);
    `;
    expect(await timeoutOf(script)).toBeInstanceOf(CommandTimeoutError);
  });

  it('still returns a normal non-zero exit as a result when no limit was hit', async () => {
    expect(await within(8000, run(node('process.exit(7)')))).toMatchObject({ exitCode: 7 });
  });
});

describe('runCommandSpec: the output limit is in bytes', () => {
  const limited = (text: string, maxOutputBytes: number) =>
    run(node(`process.stdout.write(${JSON.stringify(text)}); setInterval(()=>{}, 1000)`, [], { maxOutputBytes, timeoutMs: 10_000 })).catch((e: unknown) => e);

  it('cuts Japanese text at a character boundary within the limit', async () => {
    // 'あ' is 3 bytes: 4 of them are 12 bytes, over a 10 byte limit; 3 characters (9 bytes) fit.
    const err = await limited('ああああ', 10);
    expect(err).toBeInstanceOf(CommandOutputLimitError);
    expect((err as CommandOutputLimitError).stdout).toBe('あああ');
    expect(Buffer.byteLength((err as CommandOutputLimitError).stdout)).toBeLessThanOrEqual(10);
  });

  it('cuts emoji (4 bytes) at a character boundary within the limit', async () => {
    const err = await limited('😀😀😀😀😀', 10);
    expect(err).toBeInstanceOf(CommandOutputLimitError);
    expect((err as CommandOutputLimitError).stdout).toBe('😀😀');
  });

  it('counts bytes, not characters: 4 characters of 3 bytes exceed a 10 byte limit that 10 characters would not', async () => {
    expect(await limited('ああああ', 10)).toBeInstanceOf(CommandOutputLimitError);
    const ok = await run(node('process.stdout.write("0123456789")', [], { maxOutputBytes: 10 }));
    expect(ok.stdout).toBe('0123456789');
  });

  it('accepts output of exactly the limit', async () => {
    const ok = await run(node('process.stdout.write("あああ")', [], { maxOutputBytes: 9 }));
    expect(ok.stdout).toBe('あああ');
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
