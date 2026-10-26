import os from 'os';
import path from 'path';
import { statfs } from 'fs/promises';
import { z } from 'zod';

/** Agent endpoint (behind the agent token) where an agent reports the memory and disk of its host, measured with Node's own `os` / `fs` (no shell). */
export const AGENT_HOST_RESOURCES_PATH = '/api/host/resources';

const hostResourceSampleSchema = z.object({
  memTotalBytes: z.number().positive(),
  /** Memory a program can still use. Windows: `os.freemem()`, the available physical memory. */
  memAvailableBytes: z.number().nonnegative(),
  /** The system drive's usage. Null when the drive cannot be read or the host does not name one. */
  disk: z.object({ usedBytes: z.number().nonnegative(), totalBytes: z.number().positive() }).nullable(),
});

/** What a host reports of itself without a shell. There is no load: Windows has no loadavg, and `os.loadavg()` would report 0 there. */
export type HostResourceSample = z.infer<typeof hostResourceSampleSchema>;

/** Reads a sample that crossed the agent wire (`GET /api/host/resources`). A body of another shape is an error. */
export function parseHostResourceSample(body: unknown): HostResourceSample {
  return hostResourceSampleSchema.parse(body);
}

/** The agent has no `GET /api/host/resources` (HTTP 404): it is older than this hub. */
export class AgentResourcesOutdatedError extends Error {
  constructor(readonly serverName: string) {
    super(`agent_outdated: agent server "${serverName}" cannot report its resources (update the agent)`);
    this.name = 'AgentResourcesOutdatedError';
  }
}

/** What {@link measureHostResources} reads from the machine; the real one is Node's `os` and `fs`. */
export interface HostResourceSource {
  totalmem(): number;
  freemem(): number;
  statfs(path: string): Promise<{ bsize: number; blocks: number; bfree: number }>;
}

const nodeSource: HostResourceSource = { totalmem: os.totalmem, freemem: os.freemem, statfs: (p) => statfs(p) };

/**
 * The drive the Windows system folder (`%SystemRoot%`) is on, e.g. `C:\`. Null when the host names none: the disk is then not measured.
 * Resolved at the process entry from its HostEnv, never read from `process.env` here.
 */
export function systemDriveOf(systemRoot: string | undefined): string | null {
  if (!systemRoot) return null;
  const root = path.win32.parse(systemRoot).root;
  return root === '' ? null : root;
}

/**
 * Memory and disk of this host from Node, the same code for the hub's own Windows host and for an agent's. A drive that cannot be
 * read leaves `disk` null (the rest is still a measurement); memory that cannot be read is an error.
 */
export async function measureHostResources(diskPath: string | null, source: HostResourceSource = nodeSource): Promise<HostResourceSample> {
  const memTotalBytes = source.totalmem();
  const memAvailableBytes = source.freemem();
  let disk: HostResourceSample['disk'] = null;
  if (diskPath !== null) {
    try {
      const fsStat = await source.statfs(diskPath);
      const totalBytes = fsStat.blocks * fsStat.bsize;
      if (totalBytes > 0) disk = { usedBytes: totalBytes - fsStat.bfree * fsStat.bsize, totalBytes };
    } catch {
      disk = null;
    }
  }
  return parseHostResourceSample({ memTotalBytes, memAvailableBytes, disk });
}
