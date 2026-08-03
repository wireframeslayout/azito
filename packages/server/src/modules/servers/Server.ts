export type MuxRuntime = 'system' | 'managed';

export interface ServerConfig {
  name: string;
  type: 'local' | 'agent';
  host: string | null;
  agentPort: number | null;
  agentToken: string | null;
  agentVersion: string | null;
  sshHost: string | null;
  muxRuntime: MuxRuntime;
  sshHostFingerprint: string | null;
  createdAt: string;
}

export interface IServerRepository {
  findAll(): ServerConfig[];
  findByName(name: string): ServerConfig | null;
  create(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, agentVersion?: string, sshHost?: string, muxRuntime?: MuxRuntime): void;
  update(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, sshHost?: string, muxRuntime?: MuxRuntime): void;
  updateAgentVersion(name: string, version: string): void;
  updateFingerprint(name: string, fingerprint: string): void;
  clearFingerprint(name: string): void;
  delete(name: string): void;
}
