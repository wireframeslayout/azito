import * as path from 'path';
import type { ServerConfig } from '../../servers/Server';

import { resolveRoot } from '../../../shared/releaseInfo';

const LOCAL_AZITOCTL_PATH = path.join(resolveRoot(), 'harness', 'bin', 'azitoctl');

/**
 * Path to `azitoctl` on agent servers, as deployed by HarnessInstaller
 * (`~/.azito/harness/bin/azitoctl` — see HarnessInstaller.ts's `~/.azito/harness`
 * extraction target). The `~` is intentionally left for the remote shell to
 * expand: this string is rendered directly into the phase prompt text (via
 * httpSignalEnvelope), which the coding agent itself runs as a shell command
 * in its own interactive shell — not through our exec layer — so tilde
 * expansion is always safe there.
 */
const REMOTE_AZITOCTL_PATH = '~/.azito/harness/bin/azitoctl';

/**
 * Resolves the absolute path to the `azitoctl` CLI on the target execution
 * environment, for embedding into an http-signal execution envelope
 * (Issue: AZITO監視強化 Phase 1).
 */
export function resolveAzitoctlPath(server: Pick<ServerConfig, 'type'>): string {
  return server.type === 'local' ? LOCAL_AZITOCTL_PATH : REMOTE_AZITOCTL_PATH;
}
