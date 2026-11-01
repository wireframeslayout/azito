import { execFileSync } from 'node:child_process';

/** The launchd job's PID is the hub PID because run.sh execs Node. */
export function isLaunchdHub(platform: string, pid: number): boolean {
  if (platform !== 'darwin') return false;
  try {
    const output = execFileSync('/bin/launchctl', ['list', 'com.azito.hub'], { encoding: 'utf8', timeout: 3000 });
    return Number(/"PID"\s*=\s*(\d+);/.exec(output)?.[1]) === pid;
  } catch {
    return false;
  }
}
