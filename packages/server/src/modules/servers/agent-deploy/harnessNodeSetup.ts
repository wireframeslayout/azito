import type { IFileOps } from '../../../shared/fs/fileOps';
import { pathApiFor } from '../../../shared/os/hostPath';
import { collectTreeEntries } from '../../../shared/fs/tarGz';
import type { HarnessLocation } from './harnessLocation';

// The Windows route of the harness install: the harness is written with the host's IFileOps (no tar, no SFTP, no shell) and
// set up by `node setup.mjs` (setup.sh is bash, which a Windows host does not have). POSIX hosts keep setup.sh.

/** What `setup.mjs` is called with. */
export interface NodeSetupInvocation {
  /** Everything but the secrets, as the command line. */
  args: string[];
  /**
   * The tokens, and the other options too (as empty strings when absent): a secret never goes in an argument list, and an
   * AZITO_* variable that happens to be in the host process's own environment must not be taken for an option.
   */
  env: Record<string, string>;
}

export interface NodeSetupOptions {
  azitoUrl?: string;
  webhookToken?: string;
  uiToken?: string;
  serverName?: string;
  prefix?: string;
  isolationIntent?: boolean;
}

export function buildNodeSetupInvocation(options: NodeSetupOptions): NodeSetupInvocation {
  const { azitoUrl, webhookToken, uiToken, serverName, prefix, isolationIntent } = options;
  const args: string[] = [];
  if (azitoUrl) args.push('--azito-url', azitoUrl);
  if (serverName) args.push('--server-name', serverName);
  if (prefix) args.push('--prefix', prefix);
  // Withheld for an isolation-intent server and purged from it (see HarnessInstallOptions.isolationIntent).
  if (isolationIntent) args.push('--purge-operator-token');
  return {
    args,
    env: {
      AZITO_URL: '',
      AZITO_SERVER_NAME: '',
      AZITO_PREFIX: '',
      AZITO_WEBHOOK_TOKEN: webhookToken ?? '',
      AZITO_UI_TOKEN: uiToken && !isolationIntent ? uiToken : '',
    },
  };
}

/**
 * The dependencies of the azt-mcp MCP server, installed on the host by hand (`npm install`, see docs/harness.md). They are not
 * part of the harness that is sent (node_modules is left out), so a replacement of the directory must carry them over.
 */
const MCP_DEPENDENCIES = ['skills', 'azt-mcp', 'mcp-server', 'node_modules'];

/**
 * Writes the harness directory on the host: into a staging directory next to it, then swapped in as one operation
 * (`replaceDirectory` puts the old one back when that fails), so a transfer that stops half way never leaves a half harness.
 */
export async function sendHarnessDirectory(files: IFileOps, sourceDir: string, location: HarnessLocation, stamp: number): Promise<void> {
  const api = pathApiFor(files.platform);
  const staging = `${location.harnessDir}.staging-${stamp}`;
  const entries = collectTreeEntries(sourceDir, {
    exclude: (name) => name === 'node_modules' || name === '.git',
    fileMode: () => 0o644,
    directoryMode: 0o755,
  });
  const installedDependencies = api.join(location.harnessDir, ...MCP_DEPENDENCIES);
  const stagedDependencies = api.join(staging, ...MCP_DEPENDENCIES);
  let carriedOver = false;
  try {
    await files.create(staging, 'directory', { recursive: true });
    for (const entry of entries) {
      const target = api.join(staging, ...entry.path.split('/'));
      if (entry.type === 'directory') await files.create(target, 'directory', { recursive: true });
      else if (entry.type === 'file' && entry.data) await files.write(target, entry.data);
      else throw new Error(`Cannot send ${entry.path} to the host: it is neither a file nor a directory`);
    }
    // The installed dependencies move into the new copy before it takes the old one's place (a rename on the same disk).
    if ((await files.stat(installedDependencies, { followLinks: false }))?.kind === 'directory') {
      await files.rename(installedDependencies, stagedDependencies);
      carriedOver = true;
    }
    await files.replaceDirectory(staging, location.harnessDir);
  } catch (err) {
    // Best effort: the error being reported is the transfer's, not the cleanup's. A replacement that failed leaves the old
    // harness in place, so the dependencies go back to it before the staging directory is removed.
    if (carriedOver) await files.rename(stagedDependencies, installedDependencies).catch(() => undefined);
    await files.remove(staging).catch(() => undefined);
    throw err;
  }
}
