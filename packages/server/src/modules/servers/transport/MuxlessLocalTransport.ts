import type { MuxDriverKind, MuxExecRequest, MuxRef, PaneHandle, PaneOrdinal } from '@azito/shared';
import type { ExecResult, IMuxTransport, IServerTransport, ITerminalStream } from './ServerTransport';
import type { IPaneStream } from '../../tmux/PaneStream';
import type { MuxDriverAvailability } from '../../tmux/MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../../tmux/MuxCapabilityError';
import { execLocal } from './LocalTransport';

/**
 * Local transport for a server whose mux is not tmux. Shell exec (files, git, ps, ResourceGuard) does not depend on
 * the mux and keeps working; only the tmux-shaped mux operations fail, explicitly, instead of falling back to tmux.
 */
export class MuxlessLocalTransport implements IServerTransport, IMuxTransport {
  constructor(private kind: MuxDriverKind, private availability: () => MuxDriverAvailability) {}

  exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    return execLocal('/bin/sh', ['-c', command], timeoutMs);
  }

  async execMux(_req: MuxExecRequest): Promise<ExecResult> {
    throw this.muxError();
  }

  async openTerminal(_ref: MuxRef, _ordinal: PaneOrdinal, _cols: number, _rows: number): Promise<ITerminalStream> {
    throw this.muxError();
  }

  createPaneStream(_handle: PaneHandle): IPaneStream {
    throw this.muxError();
  }

  private muxError(): Error {
    const availability = this.availability();
    if (availability.available) return new Error(`Mux kind "${this.kind}" does not run through the shell transport`);
    return new MuxDriverUnavailableError(this.kind, availability.reason);
  }
}
