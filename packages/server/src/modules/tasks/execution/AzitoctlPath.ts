import * as path from 'path';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { harnessLocation, homeDirOf } from '../../servers/agent-deploy/harnessLocation';
import type { EnvelopeHost } from '../../prompt/executionEnvelope';
import { windowsPromptPath } from '../../../shared/os/windowsPromptPath';

import { resolveRoot } from '../../../shared/releaseInfo';

const LOCAL_AZITOCTL_PATH = path.join(resolveRoot(), 'harness', 'bin', 'azitoctl');
const LOCAL_AZITOCTL_NODE_PATH = path.join(resolveRoot(), 'harness', 'bin', 'azitoctl.mjs');

/**
 * Path to `azitoctl` on agent servers, as deployed by HarnessInstaller
 * (`~/.azito/harness/bin/azitoctl` — see HarnessInstaller.ts's `~/.azito/harness`
 * extraction target). The `~` is intentionally left for the remote shell to
 * expand: this string is rendered directly into the phase prompt text (via
 * httpSignalEnvelope), which the coding agent itself runs as a shell command
 * in its own interactive shell — not through our exec layer — so tilde
 * expansion is always safe there. (A Windows host's shell expands no `~`:
 * {@link resolveEnvelopeHost} writes its home directory out.)
 */
const REMOTE_AZITOCTL_PATH = '~/.azito/harness/bin/azitoctl';

/**
 * Resolves the absolute path to the `azitoctl` CLI on the target execution
 * environment, for embedding into an http-signal execution envelope
 * (Issue: AZITO監視強化 Phase 1). The path of the bash CLI: a Windows host uses
 * `azitoctl.mjs` ({@link resolveEnvelopeHost}).
 */
export function resolveAzitoctlPath(server: Pick<ServerConfig, 'type'>): string {
  return server.type === 'local' ? LOCAL_AZITOCTL_PATH : REMOTE_AZITOCTL_PATH;
}

/**
 * The shell and azitoctl the worker's prompt is written for (#371). A POSIX host (and one whose OS is not recorded) gets the bash `azitoctl`'s path
 * as before. A Windows host gets `node "<home>/.azito/harness/bin/azitoctl.mjs"` — the hub's own harness for its local server, the
 * agent's `~/.azito/harness` for an agent server, the home directory written out because nothing on Windows expands `~` in a quoted
 * word — with forward slashes (Git Bash and PowerShell both read them, and neither reads a backslash in a double-quoted word as text).
 */
export async function resolveEnvelopeHost(
  transportFactory: Pick<TransportFactory, 'hostProfileFor' | 'getFileOps'>,
  server: ServerConfig,
): Promise<EnvelopeHost> {
  if (transportFactory.hostProfileFor(server)?.platform !== 'win32') {
    return { os: 'posix', azitoctl: resolveAzitoctlPath(server) };
  }
  const script = server.type === 'local'
    ? LOCAL_AZITOCTL_NODE_PATH
    : path.win32.join(harnessLocation('win32', await homeDirOf(transportFactory.getFileOps(server))).harnessDir, 'bin', 'azitoctl.mjs');
  const quoted = windowsPromptPath(script);
  if (/["$`]/.test(quoted)) {
    throw new Error(`The path of azitoctl.mjs (${JSON.stringify(quoted)}) contains a double quote, $ or a backtick, which the worker's shell reads inside double quotes.`);
  }
  return { os: 'windows', azitoctl: `node "${quoted}"` };
}
