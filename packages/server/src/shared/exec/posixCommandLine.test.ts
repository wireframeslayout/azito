import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { buildCommandSpec } from './commandSpec';
import { toPosixCommandLine } from './posixCommandLine';

/** What a real sh makes of a command line: the program and arguments it would start, one per NUL-terminated entry. */
function splitWithSh(commandLine: string): string[] {
  const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${commandLine}`], { encoding: 'utf-8' });
  return out.split('\0').slice(0, -1);
}

describe.skipIf(process.platform === 'win32')('toPosixCommandLine', () => {
  it('is split by sh back into exactly file and args', () => {
    const args = ["it's", 'a b', '$HOME', '`id`', '"q"', '*', '', ';echo pwned', '-n', '日本語\nline2', '\\'];
    const line = toPosixCommandLine(buildCommandSpec('git', args));
    expect(splitWithSh(line)).toEqual(['git', ...args]);
  });

  it('puts cwd, env and stdin in front without changing the program part', () => {
    const line = toPosixCommandLine(buildCommandSpec('cat', ['-n'], { cwd: "/tmp/a b", env: { A: "1 '2'" }, stdin: "in'put" }));
    expect(line).toBe("cd -- '/tmp/a b' && printf '%s' 'in'\\''put' | A='1 '\\''2'\\''' 'cat' '-n'");
  });

  it('runs: cwd, env and stdin all take effect', () => {
    const line = toPosixCommandLine(buildCommandSpec(process.execPath, ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(process.cwd()+"|"+process.env.A+"|"+d))'], { cwd: '/', env: { A: "x y" }, stdin: 'in' }));
    expect(execFileSync('/bin/sh', ['-c', line], { encoding: 'utf-8' })).toBe('/|x y|in');
  });

  it('closes stdin with </dev/null when none is given, so a program that reads it sees EOF', () => {
    const line = toPosixCommandLine(buildCommandSpec('cat', []));
    expect(line).toBe("'cat' </dev/null");
    expect(execFileSync('/bin/sh', ['-c', line], { encoding: 'utf-8', timeout: 5000 })).toBe('');
  });

  it('refuses an environment variable name that is not an identifier', () => {
    expect(() => toPosixCommandLine(buildCommandSpec('x', [], { env: { 'A;rm -rf /': '1' } }))).toThrow(/Invalid environment variable name/);
  });
});
