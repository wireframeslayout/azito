import type { IWorktreeService } from './IWorktreeService';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import { LocalWorktreeService } from './WorktreeService';
import { RemoteWorktreeService } from './RemoteWorktreeService';

export class WorktreeServiceFactory {
  private localService = new LocalWorktreeService();

  create(serverType: string, transport?: IServerTransport): IWorktreeService {
    if (serverType === 'local') return this.localService;
    if (!transport) throw new Error('Transport required for remote worktree operations');
    return new RemoteWorktreeService(transport);
  }
}
