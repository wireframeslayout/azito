/** The named pipe the Windows "OpenSSH Authentication Agent" service listens on (ssh-add and ssh.exe use it when SSH_AUTH_SOCK is unset). */
export const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

export type SshAgentResolution =
  | { socket: string; unavailableReason: null }
  | { socket: null; unavailableReason: string };

/**
 * Which ssh-agent the hub can ask for keys, and why none when there is none.
 *
 * - `SSH_AUTH_SOCK` wins on every OS (a Unix socket path, a `\\.\pipe\...` name, or `pageant` on Windows: ssh2 takes all three).
 * - Unset on Unix: no agent (the login session's socket is not inherited by a service; run-hub.sh looks for the usual places).
 * - Unset on Windows: the OpenSSH agent's fixed pipe, if the service is running. A pipe that is not there means the
 *   service is stopped or disabled, which is a reason to report, not an error: the key files are still tried.
 *
 * `pipeExists` is injected so the Windows branch can be tested on any OS.
 */
export function resolveSshAgent(platform: NodeJS.Platform, authSock: string | undefined, pipeExists: (pipe: string) => boolean): SshAgentResolution {
  if (authSock) return { socket: authSock, unavailableReason: null };
  if (platform !== 'win32') return { socket: null, unavailableReason: 'SSH_AUTH_SOCK is not set' };
  if (pipeExists(WINDOWS_OPENSSH_AGENT_PIPE)) return { socket: WINDOWS_OPENSSH_AGENT_PIPE, unavailableReason: null };
  return {
    socket: null,
    unavailableReason:
      `SSH_AUTH_SOCK is not set and the OpenSSH agent pipe ${WINDOWS_OPENSSH_AGENT_PIPE} does not exist ` +
      '(start the "OpenSSH Authentication Agent" service: Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent)',
  };
}
