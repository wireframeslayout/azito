import { ENV_NAME_PATTERN } from '../exec/commandSpec';
import type { HostProfile } from './hostProfile';

/**
 * The text that goes through a shell on the target host. It is used for exactly two things: the fixed scripts an SSH
 * bootstrap runs, and the line typed into a pane. Ordinary commands never use it (they are a `CommandSpec`, no shell).
 * Two implementations: POSIX sh and Windows PowerShell 5.1. cmd.exe has no dialect: the PowerShell one is wrapped so that it
 * runs the same under a cmd.exe and a PowerShell default shell.
 */
export interface ShellDialect {
  readonly kind: 'posix' | 'powershell';
  /** `value` as one literal argument of a command line. */
  quote(value: string): string;
  /** `command` run with these environment variables set (under PowerShell they stay set in an interactive shell). */
  withEnv(env: Readonly<Record<string, string>>, command: string): string;
  /** Moves the shell's working directory. */
  changeDirectory(dir: string): string;
  /**
   * `file` run with exactly these arguments: empty strings, spaces, quotes and `$` reach it unchanged. Under PowerShell a
   * native command is started through a fixed Node launcher (see {@link NODE_LAUNCHER_SOURCE}) because 5.1 and 7 re-quote
   * arguments differently.
   */
  invoke(file: string, args: readonly string[]): string;
  /** The steps in order, each only when the one before succeeded. A failed step is the result of the whole line. */
  chain(steps: readonly string[]): string;
  /**
   * A whole script as one command line that a remote login shell (cmd.exe, PowerShell or sh) runs the same way. Its exit
   * status is the one of the step that stopped it (exactly, under sh and cmd.exe; a PowerShell login shell reduces any
   * failure of a native command to 1, as `powershell -Command` does).
   */
  wrapScript(script: string): string;
}

/** The longest command line cmd.exe takes (Windows OpenSSH's default shell may be cmd.exe). */
export const MAX_WINDOWS_COMMAND_LINE = 8191;

function assertEnvName(name: string): void {
  if (!ENV_NAME_PATTERN.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
}

class PosixDialect implements ShellDialect {
  readonly kind = 'posix';

  quote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  withEnv(env: Readonly<Record<string, string>>, command: string): string {
    const assignments = Object.entries(env).map(([name, value]) => {
      assertEnvName(name);
      return `${name}=${this.quote(value)}`;
    });
    return [...assignments, command].join(' ');
  }

  changeDirectory(dir: string): string {
    return `cd -- ${this.quote(dir)}`;
  }

  invoke(file: string, args: readonly string[]): string {
    return [file, ...args].map((part) => this.quote(part)).join(' ');
  }

  chain(steps: readonly string[]): string {
    return steps.join(' && ');
  }

  /** The text is already run by the target's sh, so it is passed on as it is. */
  wrapScript(script: string): string {
    return script;
  }
}

/**
 * Runs in a Node process on the target host: reads `{ file, args }` (base64 of UTF-8 JSON) from its first argument and starts
 * the program with exactly those arguments, no shell. It contains no `"`, `'` or `\`, so PowerShell 5.1 hands it to node.exe
 * as one argument unchanged. Nothing is placed on the host: it is given with `node -e`, so the only requirement is `node` on PATH.
 */
export const NODE_LAUNCHER_SOURCE = 'const a=JSON.parse(Buffer.from(process.argv[1],`base64`).toString(`utf8`));'
  + 'const r=require(`child_process`).spawnSync(a.file,a.args,{stdio:`inherit`});'
  + 'if(r.error){console.error(r.error.message);process.exit(127)}'
  + 'process.exit(r.status===null?1:r.status)';

/** PowerShell also reads these typographic quotes as single quotes; one is escaped by doubling it, like `'`. */
const POWERSHELL_QUOTE_CHARS = /['‘’‚‛]/g;

/**
 * The arguments of `powershell.exe` that run `script`: the same script text reaches PowerShell unchanged whatever shell (or no
 * shell) starts it. A cmdlet error stops the script (exit 1); a native command's exit code is what `exit` returns, as the steps
 * after a failure are skipped.
 */
export function powershellEncodedArgs(script: string): string[] {
  const body = `$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = 0\n${script}\nexit $LASTEXITCODE\n`;
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')];
}

class PowerShellDialect implements ShellDialect {
  readonly kind = 'powershell';

  quote(value: string): string {
    return `'${value.replace(POWERSHELL_QUOTE_CHARS, (c) => c + c)}'`;
  }

  withEnv(env: Readonly<Record<string, string>>, command: string): string {
    const assignments = Object.entries(env).map(([name, value]) => {
      assertEnvName(name);
      return `$env:${name} = ${this.quote(value)}`;
    });
    return [...assignments, command].join('; ');
  }

  changeDirectory(dir: string): string {
    return `Set-Location -LiteralPath ${this.quote(dir)}`;
  }

  invoke(file: string, args: readonly string[]): string {
    const payload = Buffer.from(JSON.stringify({ file, args }), 'utf8').toString('base64');
    return `node -e ${this.quote(NODE_LAUNCHER_SOURCE)} ${payload}`;
  }

  chain(steps: readonly string[]): string {
    return steps.reduceRight((rest, step) => (rest === '' ? step : `${step}; if ($?) { ${rest} }`), '');
  }

  wrapScript(script: string): string {
    const line = ['powershell.exe', ...powershellEncodedArgs(script)].join(' ');
    if (line.length > MAX_WINDOWS_COMMAND_LINE) {
      throw new Error(`The PowerShell script is too long for one command line (${line.length} > ${MAX_WINDOWS_COMMAND_LINE} characters once encoded).`);
    }
    return line;
  }
}

export const posixDialect: ShellDialect = new PosixDialect();
export const powershellDialect: ShellDialect = new PowerShellDialect();

/**
 * The dialect of a host: PowerShell for win32, POSIX sh for linux and darwin. A null profile (an agent registered before the
 * OS was recorded, or a hub on an OS AZITO does not know) is a Unix host.
 */
export function shellDialectFor(profile: Pick<HostProfile, 'platform'> | null): ShellDialect {
  return profile?.platform === 'win32' ? powershellDialect : posixDialect;
}
