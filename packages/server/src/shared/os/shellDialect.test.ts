import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  MAX_WINDOWS_COMMAND_LINE,
  NODE_LAUNCHER_SOURCE,
  posixDialect,
  powershellDialect,
  shellDialectFor,
} from './shellDialect';
import { shellQuote } from '../shellQuote';

const isWindows = process.platform === 'win32';

/** Arguments a naive quoting gets wrong: empty, blank, quotes, `$`, backtick, backslashes, `%`, a newline, Japanese, an injection attempt. */
const TRICKY_VALUES = [
  '',
  ' ',
  'a b',
  'say "hi"',
  "it's",
  '$HOME',
  '$(Get-Date)',
  '`x`',
  'C:\\dir\\',
  '100%',
  '%PATH%',
  'line1\nline2',
  '日本語 テスト',
  '; echo injected',
  '‘smart’ ‚low‛ quotes',
  '--flag=value',
];

describe('POSIX dialect (the behavior shellQuote and the pane lines always had)', () => {
  it('quote is single quotes with the quote itself escaped', () => {
    expect(posixDialect.quote('')).toBe("''");
    expect(posixDialect.quote('plain')).toBe("'plain'");
    expect(posixDialect.quote('a b')).toBe("'a b'");
    expect(posixDialect.quote("it's")).toBe("'it'\\''s'");
    expect(posixDialect.quote('$HOME `x` "y"')).toBe("'$HOME `x` \"y\"'");
    expect(posixDialect.quote('claude-opus-4-6[1m]')).toBe("'claude-opus-4-6[1m]'");
  });

  it('shellQuote (the function the sh install scripts use) is the dialect quote', () => {
    for (const value of TRICKY_VALUES) expect(shellQuote(value)).toBe(posixDialect.quote(value));
  });

  it('changeDirectory is `cd --` so a leading dash is not an option', () => {
    expect(posixDialect.changeDirectory('/work/my dir')).toBe("cd -- '/work/my dir'");
    expect(posixDialect.changeDirectory("/work/it's")).toBe("cd -- '/work/it'\\''s'");
  });

  it('withEnv puts quoted assignments before the command, in the order given', () => {
    expect(posixDialect.withEnv({ A: '1', B: "x y" }, 'run it')).toBe("A='1' B='x y' run it");
    expect(posixDialect.withEnv({}, 'run it')).toBe('run it');
  });

  it('withEnv refuses a name that is not an identifier', () => {
    expect(() => posixDialect.withEnv({ 'A B': '1' }, 'x')).toThrow(/Invalid environment variable name/);
    expect(() => posixDialect.withEnv({ 'A=1;rm': '1' }, 'x')).toThrow(/Invalid environment variable name/);
  });

  it('invoke quotes the program and every argument', () => {
    expect(posixDialect.invoke('git', ['-C', '/a b', ''])).toBe("'git' '-C' '/a b' ''");
  });

  it('chain joins with && so a failure stops the rest', () => {
    expect(posixDialect.chain(['cd -- /a', 'make'])).toBe('cd -- /a && make');
    expect(posixDialect.chain(['one'])).toBe('one');
  });

  it('wrapScript hands the text on as it is (the target runs it with its sh)', () => {
    expect(posixDialect.wrapScript('set -e\nls')).toBe('set -e\nls');
  });

  it.skipIf(isWindows)('a quoted value reaches the real sh unchanged', () => {
    for (const value of TRICKY_VALUES) {
      const out = spawnSync('/bin/sh', ['-c', `printf '%s' ${posixDialect.quote(value)}`], { encoding: 'utf8' });
      expect(out.stdout, JSON.stringify(value)).toBe(value);
    }
  });

  it.skipIf(isWindows)('invoke + withEnv + changeDirectory + chain run a program with exactly its arguments in a real sh', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "azito dialect 'sh' ")));
    try {
      const script = 'console.log(JSON.stringify([process.cwd(), process.env.AZ_DIALECT, ...process.argv.slice(1)]))';
      const line = posixDialect.chain([
        posixDialect.changeDirectory(dir),
        posixDialect.withEnv({ AZ_DIALECT: 'v w' }, posixDialect.invoke(process.execPath, ['-e', script, ...TRICKY_VALUES])),
      ]);
      const out = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' });
      expect(JSON.parse(out.stdout)).toEqual([dir, 'v w', ...TRICKY_VALUES]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PowerShell dialect (text; the Windows job runs it for real)', () => {
  it('quote is single quotes, with every character PowerShell reads as a single quote doubled', () => {
    expect(powershellDialect.quote('')).toBe("''");
    expect(powershellDialect.quote('a b')).toBe("'a b'");
    expect(powershellDialect.quote("it's")).toBe("'it''s'");
    expect(powershellDialect.quote('$HOME `x` "y"')).toBe("'$HOME `x` \"y\"'");
    expect(powershellDialect.quote('‘a’‚b‛')).toBe("'‘‘a’’‚‚b‛‛'");
    expect(powershellDialect.quote('line1\nline2')).toBe("'line1\nline2'");
  });

  it('changeDirectory uses -LiteralPath, so wildcard characters in the path are literal', () => {
    expect(powershellDialect.changeDirectory('C:\\Users\\o\'neil\\[proj]')).toBe("Set-Location -LiteralPath 'C:\\Users\\o''neil\\[proj]'");
  });

  it('withEnv assigns $env: variables before the command', () => {
    expect(powershellDialect.withEnv({ A: '1', B: "x'y" }, 'run')).toBe("$env:A = '1'; $env:B = 'x''y'; run");
    expect(() => powershellDialect.withEnv({ 'A B': '1' }, 'x')).toThrow(/Invalid environment variable name/);
  });

  it('chain runs each step only if the one before succeeded (nested, no && which 5.1 lacks)', () => {
    expect(powershellDialect.chain(['a'])).toBe('a');
    expect(powershellDialect.chain(['a', 'b', 'c'])).toBe('a; if ($?) { b; if ($?) { c } }');
    expect(powershellDialect.chain([])).toBe('');
  });

  it('invoke starts the program through the fixed Node launcher, with the arguments as base64 JSON', () => {
    const line = powershellDialect.invoke('C:\\Program Files\\x\\tool.exe', ['', 'a "b"', '日本語']);
    const match = /^node -e '([^']*)' ([A-Za-z0-9+/=]+)$/.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(NODE_LAUNCHER_SOURCE);
    expect(JSON.parse(Buffer.from(match![2], 'base64').toString('utf8'))).toEqual({ file: 'C:\\Program Files\\x\\tool.exe', args: ['', 'a "b"', '日本語'] });
  });

  it('the launcher source has no double quote, single quote or backslash (nothing for 5.1 to re-quote)', () => {
    expect(NODE_LAUNCHER_SOURCE).not.toMatch(/["'\\]/);
  });

  it('wrapScript is the fixed powershell.exe command line with the script as UTF-16LE base64', () => {
    const line = powershellDialect.wrapScript('Write-Output 日本語');
    const match = /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(line);
    expect(match).not.toBeNull();
    const body = Buffer.from(match![1], 'base64').toString('utf16le');
    expect(body).toContain('Write-Output 日本語');
    expect(body).toMatch(/^\$ErrorActionPreference = 'Stop'\n/);
    expect(body).toMatch(/\nexit \$LASTEXITCODE\n$/);
  });

  it('wrapScript refuses a script whose command line cmd.exe could not take', () => {
    expect(() => powershellDialect.wrapScript('x'.repeat(MAX_WINDOWS_COMMAND_LINE))).toThrow(/too long/);
  });
});

describe('shellDialectFor', () => {
  it('is PowerShell for win32 and POSIX for linux, darwin and an unrecorded host', () => {
    expect(shellDialectFor({ platform: 'win32' })).toBe(powershellDialect);
    expect(shellDialectFor({ platform: 'linux' })).toBe(posixDialect);
    expect(shellDialectFor({ platform: 'darwin' })).toBe(posixDialect);
    expect(shellDialectFor(null)).toBe(posixDialect);
  });
});

/**
 * The Windows job runs the output on the real Windows PowerShell 5.1, the way Windows OpenSSH does: once with cmd.exe as the
 * login shell and once with PowerShell as the login shell. (Linux cannot run these: there is no powershell.exe.)
 */
describe.skipIf(!isWindows)('PowerShell dialect on a real powershell.exe', () => {
  type Login = 'cmd.exe' | 'powershell.exe';
  const LOGINS: Login[] = ['cmd.exe', 'powershell.exe'];

  function runLine(line: string, login: Login): { status: number | null; stdout: string; stderr: string } {
    const result = login === 'cmd.exe'
      ? spawnSync(line, { shell: true, encoding: 'utf8', timeout: 60_000 })
      : spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line], { encoding: 'utf8', timeout: 60_000 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  for (const login of LOGINS) {
    describe(`login shell ${login}`, () => {
      it('runs on Windows PowerShell 5.1', () => {
        const out = runLine(powershellDialect.wrapScript('[Console]::Out.Write($PSVersionTable.PSVersion.ToString())'), login);
        expect(out.status, out.stderr).toBe(0);
        expect(out.stdout.startsWith('5.1.')).toBe(true);
      }, 60_000);

      it('a quoted value is the same string inside PowerShell (checked as UTF-8 base64, so the console code page does not matter)', () => {
        const items = TRICKY_VALUES.map((value) => `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${powershellDialect.quote(value)}))`);
        const out = runLine(powershellDialect.wrapScript(`[Console]::Out.Write(@(${items.join(', ')}) -join ',')`), login);
        expect(out.status, out.stderr).toBe(0);
        const decoded = out.stdout.split(',').map((item) => Buffer.from(item, 'base64').toString('utf8'));
        expect(decoded).toEqual(TRICKY_VALUES);
      }, 60_000);

      it('invoke passes empty strings, blanks, quotes, $, backticks, backslashes, newlines and Japanese to a native program unchanged', () => {
        const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
        const line = powershellDialect.wrapScript(powershellDialect.invoke(process.execPath, ['-e', script, ...TRICKY_VALUES]));
        const out = runLine(line, login);
        expect(out.status, out.stderr).toBe(0);
        expect(JSON.parse(out.stdout)).toEqual(TRICKY_VALUES);
      }, 60_000);

      it('changeDirectory, withEnv and chain run in order, in the directory, with the variable', () => {
        const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "azito dialect 'ps' ")));
        try {
          const script = 'console.log(JSON.stringify([process.cwd(), process.env.AZ_DIALECT]))';
          const body = powershellDialect.chain([
            powershellDialect.changeDirectory(dir),
            powershellDialect.withEnv({ AZ_DIALECT: "v 'w'" }, powershellDialect.invoke(process.execPath, ['-e', script])),
          ]);
          const out = runLine(powershellDialect.wrapScript(body), login);
          expect(out.status, out.stderr).toBe(0);
          const [cwd, value] = JSON.parse(out.stdout) as [string, string];
          expect(fs.realpathSync.native(cwd)).toBe(dir);
          expect(value).toBe("v 'w'");
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }, 60_000);

      it('a failing step stops the rest and its exit code is the result', () => {
        const body = powershellDialect.chain([
          powershellDialect.invoke(process.execPath, ['-e', 'process.exit(3)']),
          powershellDialect.invoke(process.execPath, ['-e', 'console.log("SECOND")']),
        ]);
        const out = runLine(powershellDialect.wrapScript(body), login);
        expect(out.status).toBe(3);
        expect(out.stdout).not.toContain('SECOND');
      }, 60_000);

      it('every step runs and the result is 0 when none fails', () => {
        const body = powershellDialect.chain([
          powershellDialect.invoke(process.execPath, ['-e', 'console.log("FIRST")']),
          powershellDialect.invoke(process.execPath, ['-e', 'console.log("SECOND")']),
        ]);
        const out = runLine(powershellDialect.wrapScript(body), login);
        expect(out.status, out.stderr).toBe(0);
        expect(out.stdout).toContain('FIRST');
        expect(out.stdout).toContain('SECOND');
      }, 60_000);

      it('a failing cmdlet stops the script with a non-zero status', () => {
        const body = powershellDialect.chain([
          powershellDialect.changeDirectory(path.join(os.tmpdir(), 'azito-no-such-directory-for-dialect-test')),
          powershellDialect.invoke(process.execPath, ['-e', 'console.log("AFTER")']),
        ]);
        const out = runLine(powershellDialect.wrapScript(body), login);
        expect(out.status).not.toBe(0);
        expect(out.stdout).not.toContain('AFTER');
      }, 60_000);

      it('a program that cannot be started is reported with a non-zero status', () => {
        const out = runLine(powershellDialect.wrapScript(powershellDialect.invoke('azito-no-such-program-for-dialect-test', [])), login);
        expect(out.status).not.toBe(0);
        expect(out.stderr.length).toBeGreaterThan(0);
      }, 60_000);
    });
  }
});
