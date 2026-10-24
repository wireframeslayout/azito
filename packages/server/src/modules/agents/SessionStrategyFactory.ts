import type { ISessionStrategy, ISessionStrategyFactory } from './SessionStrategy';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { AgentRegistry } from './registry';
import { NullSessionStrategy } from './NullSessionStrategy';
import type { LocalAgentHomes } from './agentHomes';

export class SessionStrategyFactory implements ISessionStrategyFactory {
  constructor(
    private registry: AgentRegistry,
    private transportFactory: TransportFactory,
    private localHomes: LocalAgentHomes,
  ) {}

  create(workerType: string | null): ISessionStrategy {
    if (workerType === null) return new NullSessionStrategy(null);
    const provider = this.registry.tryGet(workerType);
    if (!provider) return new NullSessionStrategy(workerType);
    return provider.createSessionStrategy({ transportFactory: this.transportFactory, localHomes: this.localHomes }) ?? new NullSessionStrategy(workerType);
  }
}
