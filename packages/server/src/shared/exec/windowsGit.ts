import { promises as fs } from 'fs';
import * as path from 'path';
import { GitNotFoundError } from './commandSpec';

/**
 * What a Windows host's environment says about where programs live, read once at the process's entry (`resolveCurrentHostEnv`):
 * the search of `git.exe` reads no `process.env`.
 */
export interface WindowsProgramEnv {
  /** `%PATH%`, `;`-separated. */
  path: string;
  /** `%PATHEXT%`. */
  pathExt: string;
  /** `%ProgramFiles%` / `%ProgramFiles(x86)%` / `%LOCALAPPDATA%`; undefined when the variable is not set. */
  programFiles: string | undefined;
  programFilesX86: string | undefined;
  localAppData: string | undefined;
}

/** Reads the variables of a Windows process (Node's `process.env` on win32 is case-insensitive). */
export function windowsProgramEnvOf(env: Record<string, string | undefined>): WindowsProgramEnv {
  return {
    path: env.PATH ?? '',
    pathExt: env.PATHEXT ?? '',
    programFiles: env.ProgramFiles,
    programFilesX86: env['ProgramFiles(x86)'],
    localAppData: env.LOCALAPPDATA,
  };
}

/** What can be asked of the host's disk and clock. Production: Node `fs` and `Date.now`. */
export interface GitLocatorIo {
  isFile(file: string): Promise<boolean>;
  now(): number;
}

const nodeIo: GitLocatorIo = {
  isFile: async (file) => {
    try {
      return (await fs.stat(file)).isFile();
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
};

/** After a miss, how long the answer "not installed" is kept before the disk is searched again (so a `winget install` just done is found without a restart). */
export const GIT_NOT_FOUND_RETRY_MS = 30_000;

/** A program started without a shell must be a real executable: `.cmd` / `.bat` from PATHEXT are not candidates (`runCommandSpec` refuses them). */
const STARTABLE_EXTENSION = /^\.(exe|com)$/i;

/**
 * Finds Git for Windows' `git.exe` on the host that runs it, in one place (the hub for a local server, the agent for an agent
 * server: both run specs through `runCommandSpec`).
 *
 * Order: every directory of PATH with the PATHEXT extensions, then the standard install locations. The second step is there
 * because an agent started by the Task Scheduler gets a minimal environment without the user's PATH, and because the PATH of a
 * process started before `winget install` does not have the new entry until the next logon. The standard locations name
 * `cmd\git.exe` only: that is the launcher Git for Windows puts on PATH itself. `bin\git.exe` is a wrapper that starts the real
 * one and `mingw64\bin` is its internals; neither is meant to be put in front of other programs. (A PATH that lists one of them
 * still finds it: that is the user's own setting.)
 *
 * The answer is kept: a found path is checked again with a stat per call (a removed git is searched for again), a miss is kept
 * for {@link GIT_NOT_FOUND_RETRY_MS}.
 */
export class GitLocator {
  private found: string | null = null;
  private missAt: number | null = null;

  constructor(private readonly env: WindowsProgramEnv, private readonly io: GitLocatorIo = nodeIo) {}

  private pathCandidates(): string[] {
    const extensions = this.env.pathExt.split(';').map((e) => e.trim()).filter((e) => STARTABLE_EXTENSION.test(e));
    const candidates: string[] = [];
    for (const raw of this.env.path.split(';')) {
      const dir = raw.trim().replace(/^"(.*)"$/, '$1');
      if (dir === '') continue;
      for (const ext of extensions) candidates.push(path.win32.join(dir, `git${ext.toLowerCase()}`));
    }
    return candidates;
  }

  private standardCandidates(): string[] {
    const win = path.win32;
    const roots: Array<[string | undefined, string]> = [
      [this.env.programFiles, win.join('Git', 'cmd', 'git.exe')],
      [this.env.programFilesX86, win.join('Git', 'cmd', 'git.exe')],
      [this.env.localAppData, win.join('Programs', 'Git', 'cmd', 'git.exe')],
    ];
    return roots.flatMap(([root, rest]) => (root ? [win.join(root, rest)] : []));
  }

  /** The absolute path of `git.exe`. Throws {@link GitNotFoundError} (with where it looked) when there is none. */
  async resolve(): Promise<string> {
    if (this.found !== null) {
      if (await this.io.isFile(this.found)) return this.found;
      this.found = null;
    }
    if (this.missAt !== null && this.io.now() - this.missAt < GIT_NOT_FOUND_RETRY_MS) throw this.notFound();
    for (const file of [...this.pathCandidates(), ...this.standardCandidates()]) {
      if (await this.io.isFile(file)) {
        this.found = file;
        this.missAt = null;
        return file;
      }
    }
    this.missAt = this.io.now();
    throw this.notFound();
  }

  private notFound(): GitNotFoundError {
    const standard = this.standardCandidates();
    const where = standard.length > 0 ? standard.join(', ') : 'no standard install location (ProgramFiles and LOCALAPPDATA are not set)';
    return new GitNotFoundError(
      'Git for Windows (git.exe) was not found on this host. Install it with "winget install --id Git.Git -e"; a git.exe that is not on PATH '
      + `is still found in its standard install locations. Searched: PATH, then ${where}.`,
    );
  }
}

const shared = new Map<string, GitLocator>();

/** The process-wide locator for an environment (one per distinct environment, so the answer is kept across calls). */
export function sharedGitLocator(env: WindowsProgramEnv): GitLocator {
  const key = JSON.stringify(env);
  let locator = shared.get(key);
  if (!locator) {
    locator = new GitLocator(env);
    shared.set(key, locator);
  }
  return locator;
}
