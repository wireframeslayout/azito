import type { IServerTransport } from './transport/ServerTransport';
import { buildCommandSpec, CommandSpawnError } from '../../shared/exec/commandSpec';
import type { HostProfile } from '../../shared/os/hostProfile';

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * What a probe program printed, for the install-status parsers. A program that is not installed (cannot be started) or
 * exits non-zero printed no answer: `''`, which every parser reads as "not installed". Anything else that goes wrong
 * (timeout, an unreachable agent) is thrown, so the row reports why instead of a misleading "not installed".
 */
export async function probeOutput(transport: Pick<IServerTransport, 'run'>, file: string, args: string[]): Promise<string> {
  try {
    const result = await transport.run(buildCommandSpec(file, args, { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: PROBE_MAX_OUTPUT_BYTES }));
    return result.exitCode === 0 ? result.stdout : '';
  } catch (err) {
    if (err instanceof CommandSpawnError && err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * `uname -s` as the OS name the browser-runtime detection expects, for a host with a recorded profile — no probe. A host
 * whose profile is not recorded (an agent from before the OS was kept, or a hub on an OS AZITO does not know) is a Unix
 * one and is asked, the one place the OS is still probed.
 */
export async function resolveOsName(transport: Pick<IServerTransport, 'run'>, hostProfile: HostProfile | null): Promise<string> {
  if (hostProfile) return osNameOf(hostProfile);
  return (await probeOutput(transport, 'uname', ['-s'])).trim();
}

/**
 * `uname -m` as the architecture name the managed tmux binaries are keyed by (`x86_64` / `aarch64`), for a host with a
 * recorded profile — no probe. A host with no recorded profile is asked, like {@link resolveOsName}.
 */
export async function resolveArchName(transport: Pick<IServerTransport, 'run'>, hostProfile: HostProfile | null): Promise<string> {
  if (hostProfile) return hostProfile.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return (await probeOutput(transport, 'uname', ['-m'])).trim();
}

function osNameOf(hostProfile: HostProfile): string {
  switch (hostProfile.platform) {
    case 'darwin': return 'Darwin';
    case 'linux': return 'Linux';
    case 'win32': return 'Windows_NT';
  }
}
