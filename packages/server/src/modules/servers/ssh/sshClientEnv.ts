import type { HostEnv } from '../../../shared/os/hostEnv';
import type { SshClientEnv } from './SshClient';

/** The hub's SSH environment, read from the process once at startup. `.ssh` is under `hostEnv.homeDir` (`%USERPROFILE%` on Windows), never `$HOME`. */
export function resolveSshClientEnv(hostEnv: Pick<HostEnv, 'homeDir' | 'platform'>, processEnv: NodeJS.ProcessEnv): SshClientEnv {
  const userName = hostEnv.platform === 'win32' ? processEnv.USERNAME : processEnv.USER || processEnv.LOGNAME;
  return {
    homeDir: hostEnv.homeDir,
    platform: hostEnv.platform,
    authSock: processEnv.SSH_AUTH_SOCK || undefined,
    defaultUser: userName || undefined,
  };
}
