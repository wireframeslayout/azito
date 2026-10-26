import * as path from 'path';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { harnessLocation, homeDirOf } from '../../servers/agent-deploy/harnessLocation';
import type { EnvelopeHost } from '../../prompt/executionEnvelope';
import type { IFileOps } from '../../../shared/fs/fileOps';
import { pathApiFor } from '../../../shared/os/hostPath';
import { checkedWindowsPromptPath } from '../../../shared/os/windowsPromptPath';

import { resolveRoot } from '../../../shared/releaseInfo';

const LOCAL_AZITOCTL_PATH = path.join(resolveRoot(), 'harness', 'bin', 'azitoctl');
const LOCAL_AZITOCTL_NODE_PATH = path.join(resolveRoot(), 'harness', 'bin', 'azitoctl.mjs');

/**
 * Resolves the absolute path to the `azitoctl` CLI on the target execution
 * environment, for embedding into an http-signal execution envelope
 * (Issue: AZITO監視強化 Phase 1). The path of the bash CLI: a Windows host uses
 * `azitoctl.mjs` ({@link resolveEnvelopeHost}).
 *
 * Path to `azitoctl` on agent servers, as deployed by HarnessInstaller
 * (`~/.azito/harness[-<prefix>]/bin/azitoctl` — the same `harnessLocation` the
 * install uses; `remoteHarnessDir` in HarnessInstaller.ts splits the folder by
 * the hub's harness prefix too). The `~` is intentionally left for the remote shell to
 * expand: this string is rendered directly into the phase prompt text (via
 * httpSignalEnvelope), which the coding agent itself runs as a shell command
 * in its own interactive shell — not through our exec layer — so tilde
 * expansion is always safe there. (A Windows host's shell expands no `~`:
 * {@link resolveEnvelopeHost} writes its home directory out.)
 */
export function resolveAzitoctlPath(server: Pick<ServerConfig, 'type'>, harnessPrefix: string): string {
  // The local server runs the hub's own checkout / bundle (`runSetupLocal` points at it, never at a prefixed copy), so the prefix does not apply to it.
  return server.type === 'local' ? LOCAL_AZITOCTL_PATH : path.posix.join(harnessLocation('linux', '~', harnessPrefix).harnessDir, 'bin', 'azitoctl');
}

/**
 * Fails at once, with the way out, when the harness folder this hub names in the prompt is not on the host (a host that has only the
 * unprefixed `~/.azito/harness`, or none): the worker would otherwise run a missing azitoctl and the phase would be noticed only after the idle timeout.
 * There is no fallback to the unprefixed folder: it belongs to another hub.
 */
async function assertHarnessInstalled(files: IFileOps, serverName: string, harnessPrefix: string, script: 'azitoctl' | 'azitoctl.mjs'): Promise<void> {
  const { harnessDir } = harnessLocation(files.platform, await homeDirOf(files), harnessPrefix);
  const scriptPath = pathApiFor(files.platform).join(harnessDir, 'bin', script);
  // A failed query is not "missing": it fails with its own reason (reinstalling would not help), `null` is the only "not installed".
  let found: Awaited<ReturnType<IFileOps['stat']>>;
  try {
    found = await files.stat(scriptPath);
  } catch (err) {
    throw new Error(`Could not check whether this hub's harness is installed on server "${serverName}" (${scriptPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (found !== null) return;
  const hub = harnessPrefix ? `this hub's harness (prefix "${harnessPrefix}")` : "this hub's harness";
  throw new Error(`${hub} is not installed on server "${serverName}" (${scriptPath} is missing). Install the harness again from Setup.`);
}

/**
 * The shell and azitoctl the worker's prompt is written for (#371). A POSIX host (and one whose OS is not recorded) gets the bash `azitoctl`'s path
 * as before. A Windows host gets `"<node.exe>" "<home>/.azito/harness/bin/azitoctl.mjs"` — the hub's own harness for its local server, the
 * agent's `~/.azito/harness[-<prefix>]` for an agent server (`harnessPrefix` is the hub's, '' = none: the value the install used), the home directory written out because nothing on Windows expands `~` in a quoted
 * word — with forward slashes (Git Bash and PowerShell both read them, and neither reads a backslash in a double-quoted word as text).
 */
export async function resolveEnvelopeHost(
  transportFactory: Pick<TransportFactory, 'hostProfileFor' | 'getFileOps' | 'getAgentTransport'>,
  server: ServerConfig,
  harnessPrefix: string,
): Promise<EnvelopeHost> {
  const isWindows = transportFactory.hostProfileFor(server)?.platform === 'win32';
  // The hub's own server runs the hub's checkout / bundle (nothing prefixed is installed there), so only another host can lack the harness.
  if (server.type !== 'local') {
    await assertHarnessInstalled(transportFactory.getFileOps(server), server.name, harnessPrefix, isWindows ? 'azitoctl.mjs' : 'azitoctl');
  }
  if (!isWindows) {
    return { os: 'posix', azitoctl: resolveAzitoctlPath(server, harnessPrefix) };
  }
  // `node` is the host's own executable by its full path: a Windows host that has only the native Claude Code has no node on the worker's PATH.
  const [node, script] = server.type === 'local'
    ? [process.execPath, LOCAL_AZITOCTL_NODE_PATH]
    : [
        await transportFactory.getAgentTransport(server).fetchNodeExecPath(),
        path.win32.join(harnessLocation('win32', await homeDirOf(transportFactory.getFileOps(server)), harnessPrefix).harnessDir, 'bin', 'azitoctl.mjs'),
      ];
  return { os: 'windows', azitoctl: `"${checkedWindowsPromptPath(node, 'The node executable')}" "${checkedWindowsPromptPath(script, 'The path of azitoctl.mjs')}"` };
}
