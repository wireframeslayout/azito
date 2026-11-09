export type LaunchdDomain = 'gui' | 'user';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and reports its exit code; only a failure to spawn rejects. */
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export async function mustSucceed(run: CommandRunner, file: string, args: string[], what: string): Promise<CommandResult> {
  const result = await run(file, args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${what} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

const DOMAINS: readonly LaunchdDomain[] = ['gui', 'user'];

const SESSION_LIMIT_KEY = 'LimitLoadToSessionType';

/**
 * A LaunchAgent loaded into `user/<uid>` must be limited to the Background session type: without
 * `LimitLoadToSessionType = Background`, `launchctl bootstrap user/<uid>` fails with exit 5 (Input/output error), and a
 * plist with it cannot be loaded into `gui/<uid>` (checked on macOS, #366). The limit also keeps macOS from loading the
 * plist into `gui/<uid>` by itself when someone logs in on the screen later. The shipped templates carry it; this adds it
 * to a plist written by an older install (which has none). A plist that already names the key is left as it is.
 */
export function limitToBackgroundSession(plist: string): string {
  if (plist.includes(SESSION_LIMIT_KEY)) return plist;
  const end = plist.lastIndexOf('</dict>');
  if (end < 0) throw new Error(`The plist has no top-level <dict>, so ${SESSION_LIMIT_KEY} cannot be added to it.`);
  return `${plist.slice(0, end)}  <key>${SESSION_LIMIT_KEY}</key>\n  <string>Background</string>\n${plist.slice(end)}`;
}

/** How long launchd gets to finish a bootout, and how often a bootstrap that races it is tried again. */
export interface LaunchdTiming {
  /** The longest wait for `launchctl print` to stop finding a job that was just booted out. */
  settleTimeoutMs: number;
  pollIntervalMs: number;
  /** Extra bootstrap attempts after exit 5 (launchd answers 5 while the previous copy of the job is still being removed). */
  bootstrapRetries: number;
  retryDelayMs: number;
}

export const DEFAULT_LAUNCHD_TIMING: LaunchdTiming = { settleTimeoutMs: 3000, pollIntervalMs: 100, bootstrapRetries: 3, retryDelayMs: 500 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** launchctl's "Input/output error": what bootstrap answers both for a plist the domain cannot take and for a job that is still being removed. */
const BOOTSTRAP_IO_ERROR = 5;

/** Launchctl operations shared by local and remote service managers. */
export class LaunchdJobOperations {
  constructor(private readonly run: CommandRunner, private readonly label: string, private readonly uid: number, private readonly plistPath: string, private readonly timing: LaunchdTiming) {}

  domainTarget(domain: LaunchdDomain): string {
    return `${domain}/${this.uid}`;
  }

  jobTarget(domain: LaunchdDomain): string {
    return `${this.domainTarget(domain)}/${this.label}`;
  }

  /** `launchctl print` of the job in each domain: one call per domain, in `gui` then `user` order. */
  async printJobs(): Promise<{ domain: LaunchdDomain; result: CommandResult }[]> {
    const jobs: { domain: LaunchdDomain; result: CommandResult }[] = [];
    for (const domain of DOMAINS) {
      jobs.push({ domain, result: await this.run('launchctl', ['print', this.jobTarget(domain)]) });
    }
    return jobs;
  }

  /** Boots the job out of a domain and waits until launchd no longer reports it: a bootstrap right after a bootout otherwise fails with exit 5. */
  async bootout(domain: LaunchdDomain): Promise<void> {
    const target = this.jobTarget(domain);
    await mustSucceed(this.run, 'launchctl', ['bootout', target], 'launchctl bootout');
    const deadline = Date.now() + this.timing.settleTimeoutMs;
    while ((await this.run('launchctl', ['print', target])).code === 0 && Date.now() < deadline) {
      await sleep(this.timing.pollIntervalMs);
    }
  }

  /** bootstrap, tried again a few times when launchd answers exit 5 (a copy of the job that was just booted out may still be going away). */
  async bootstrap(domain: LaunchdDomain): Promise<void> {
    const target = this.domainTarget(domain);
    for (let attempt = 0; ; attempt++) {
      const result = await this.run('launchctl', ['bootstrap', target, this.plistPath]);
      if (result.code === 0) return;
      if (result.code === BOOTSTRAP_IO_ERROR && attempt < this.timing.bootstrapRetries) {
        await sleep(this.timing.retryDelayMs);
        continue;
      }
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(`launchctl bootstrap ${target} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
    }
  }

}

