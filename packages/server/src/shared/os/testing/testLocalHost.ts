import * as os from 'os';
import type { LocalHost } from '../hostEnv';

/** The host a test's LocalTransport / TransportFactory runs on: Linux with the real home directory, unless a test says otherwise. */
export function testLocalHost(overrides: Partial<LocalHost> = {}): LocalHost {
  return { platform: 'linux', homeDir: os.homedir(), systemRoot: undefined, ...overrides };
}
