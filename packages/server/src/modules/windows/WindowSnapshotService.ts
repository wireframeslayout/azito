import type { IWindowRepository, Window } from './Window';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../tmux/MuxCapabilityError';
import { AgentUnreachableError } from '../servers/transport/AgentUnreachableError';
import { runWithConcurrency } from '../../shared/concurrency';
import { snapshotScreenText } from './snapshotScreenText';
import { windowKindOf, windowRefOf } from '../tmux/windowIdentity';

export type SnapshotErrorCode = 'window_not_found' | 'server_not_found' | 'mux_unavailable' | 'pane_not_found' | 'capture_failed';
// Activity is measured in seconds; polling clients recapture once before confirming a new value.
export type WindowSnapshot = { status: 'ok'; id: number; content: string; activity: number | null; changed: true } | { status: 'unchanged'; id: number; activity: number } | { status: 'error'; id: number; code: SnapshotErrorCode; message: string };
const SNAPSHOT_CONCURRENCY_PER_SERVER = 4;
const messages: Record<SnapshotErrorCode, string> = { window_not_found: 'Window not found', server_not_found: 'Server not found', mux_unavailable: 'Window service unavailable', pane_not_found: 'Pane not found', capture_failed: 'Could not capture window' };
function failure(id: number, code: SnapshotErrorCode): WindowSnapshot { return { status: 'error', id, code, message: messages[code] }; }

export class WindowSnapshotService {
  constructor(private readonly windows: IWindowRepository, private readonly servers: IServerRepository, private readonly drivers: MuxDriverRegistry) {}

  async capture(ids: number[], lines: number, since: Map<number, number> = new Map()): Promise<WindowSnapshot[]> {
    const results: WindowSnapshot[] = new Array(ids.length);
    const groups = new Map<string, Array<() => Promise<void>>>();
    ids.forEach((id, index) => {
      const win = this.windows.findById(id);
      if (!win) { results[index] = failure(id, 'window_not_found'); return; }
      const server = this.servers.findByName(win.serverName);
      if (!server) { results[index] = failure(id, 'server_not_found'); return; }
      const tasks = groups.get(server.name) ?? [];
      tasks.push(async () => { results[index] = await this.captureOne(id, win, server, lines, since); });
      groups.set(server.name, tasks);
    });
    await Promise.all([...groups.values()].map((tasks) => runWithConcurrency(tasks, SNAPSHOT_CONCURRENCY_PER_SERVER)));
    return results;
  }

  private async captureOne(id: number, win: Window, server: ServerConfig, lines: number, since: Map<number, number>): Promise<WindowSnapshot> {
    try {
      const ref = windowRefOf(win, windowKindOf(win));
      const driver = this.drivers.resolveKind(ref.kind, server);
      const activity = await driver.windowActivity(server, ref);
      if (activity !== null && since.get(id) === activity) return { status: 'unchanged', id, activity };
      const pane = await driver.resolvePane(server, ref, 1);
      const result = await driver.captureScreen(server, pane, ref.kind === 'tmux' ? -lines * 3 : undefined);
      if (result.code !== 0) {
        console.warn(`[WindowSnapshot] Capture failed for window ${id} on server ${JSON.stringify(server.name.slice(0, 100))}`);
        return failure(id, 'capture_failed');
      }
      return { status: 'ok', id, content: snapshotScreenText(result.stdout, lines), activity, changed: true };
    } catch (error) {
      if (error instanceof AgentUnreachableError) {
        console.warn(`[WindowSnapshot] Agent unreachable for window ${id} on server ${JSON.stringify(server.name.slice(0, 100))}`);
        return { status: 'error', id, code: 'capture_failed', message: `Could not reach server ${server.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100)}` };
      }
      if (error instanceof MuxDriverUnavailableError) return failure(id, 'mux_unavailable');
      if (error instanceof Error && (/^Pane ordinal \d+ out of range/.test(error.message) || /^misao window .+ not found$/.test(error.message))) return failure(id, 'pane_not_found');
      console.warn(`[WindowSnapshot] Capture failed for window ${id} on server ${JSON.stringify(server.name.slice(0, 100))}`);
      return failure(id, 'capture_failed');
    }
  }
}
