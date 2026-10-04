import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import type { SupervisorRegistry } from '../SupervisorRegistry';
import { handleSupervisorConnection } from './supervisorSocketHandler';

// TODO(#313): remove with the server alias compatibility.
const register = {
  type: 'register', protocolVersion: 1, serverName: 'local-misao', target: 'ws:w_X', taskId: null, unitId: null, pid: 1, childCommand: 'claude',
};

function connect(resolve: (name: string) => string) {
  const socket = new EventEmitter();
  const registry = { register: vi.fn(), handleMessage: vi.fn(), handleSocketClosed: vi.fn() };
  handleSupervisorConnection(socket as unknown as WebSocket, registry as unknown as SupervisorRegistry, resolve);
  const send = (msg: unknown): void => { socket.emit('message', Buffer.from(JSON.stringify(msg))); };
  return { registry, send };
}

describe('handleSupervisorConnection: a supervisor that still carries a merged server\'s old name', () => {
  const resolve = (name: string): string => (name === 'local-misao' ? 'local' : name);

  it('registers a launch-bound supervisor (launchId + session token) under the current name', () => {
    const { registry, send } = connect(resolve);
    send({ ...register, launchId: 'l1', sessionToken: 'tok' });
    expect(registry.register).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ serverName: 'local', launchId: 'l1', sessionToken: 'tok' }));
  });

  it('registers a supervisor without a launchId under the current name', () => {
    const { registry, send } = connect(resolve);
    send(register);
    expect(registry.register).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ serverName: 'local', target: 'ws:w_X' }));
  });

  it('leaves a current name untouched', () => {
    const { registry, send } = connect(resolve);
    send({ ...register, serverName: 'local' });
    expect(registry.register).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ serverName: 'local' }));
  });
});
