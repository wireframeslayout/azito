import type { IWorktreeService } from './IWorktreeService';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import { requireHubHostProfile, type HubHostProfile } from '../../shared/os/hostProfile';
import { LocalWorktreeService } from './WorktreeService';
import { RemoteWorktreeService } from './RemoteWorktreeService';

export class WorktreeServiceFactory {
  private localService: LocalWorktreeService | null = null;

  /** `hubHost` is the hub's own host, where a `local` server's git runs; an unsupported one is refused when a local service is asked for. */
  constructor(private readonly hubHost: HubHostProfile) {}

  create(serverType: string, transport?: IServerTransport): IWorktreeService {
    if (serverType === 'local') return (this.localService ??= new LocalWorktreeService(requireHubHostProfile(this.hubHost).platform));
    if (!transport) throw new Error('Transport required for remote worktree operations');
    return new RemoteWorktreeService(transport);
  }
}
