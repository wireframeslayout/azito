import type { IWorktreeService } from './IWorktreeService';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import { RemoteWorktreeService } from './RemoteWorktreeService';

/**
 * Every server type, the hub's own `local` one included, gets the same service over its transport: git runs through
 * `transport.run` (no shell) and the file operations through `transport.files()`, so a local and a remote worktree take one path
 * and the hub's event loop is never held by a synchronous git.
 */
export class WorktreeServiceFactory {
  create(transport: IServerTransport): IWorktreeService {
    return new RemoteWorktreeService(transport);
  }
}
