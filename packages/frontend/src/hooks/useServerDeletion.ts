import { useState } from 'react';
import { api } from '../api/client';
import type { Server } from './useServerManagement';
import {
  DEFAULT_HOST_REMOVAL, deleteEntryOnly as deleteEntryOnlyOf, hostRemovalSupport, runDeletion, setRemoveFromHost, setRemoveMisao,
  type DeletionCalls, type DeletionResult, type HostRemovalChoice, type HostRemovalFailure, type HostRemovalSupport,
} from '../lib/serverDeletion';

/**
 * - `idle`: nothing asked yet.
 * - `confirming`: the choices are shown (also while the row is being deleted without a host removal).
 * - `removingHost`: the agent is being taken off the host; the row is still there.
 * - `hostFailed`: the host removal did not work; the row is still there and the person decides (try again, delete only the entry, cancel).
 */
export type ServerDeletionPhase = 'idle' | 'confirming' | 'removingHost' | 'hostFailed';

export interface ServerDeletion {
  phase: ServerDeletionPhase;
  support: HostRemovalSupport;
  choice: HostRemovalChoice;
  /** Set in `hostFailed`: the steps that failed, or why the host could not be asked. */
  failure: HostRemovalFailure | null;
  /** Set when the server row itself could not be deleted (after the host removal worked, or when none was asked for). */
  rowError: string | null;
  /** A deletion is in progress (the host removal or the row). */
  busy: boolean;
  open(): void;
  cancel(): void;
  setRemoveFromHost(value: boolean): void;
  setRemoveMisao(value: boolean): void;
  /** Removes the agent from the host when asked for, then deletes the row. A failed host removal keeps the row. */
  confirm(): Promise<void>;
  /** After a failed host removal: delete the row anyway, leaving what is on the host. */
  deleteEntryOnly(): Promise<void>;
}

/**
 * The deletion of a server from the Danger section (the flow itself is `runDeletion`). The host is cleaned BEFORE the row is deleted and a
 * failure never deletes the row on its own: the person picks "delete the entry only" after seeing each step's result. The row alone is
 * deleted when the host removal is off, so a host that is offline can still be forgotten.
 */
export function useServerDeletion(server: Pick<Server, 'name' | 'type' | 'hostProfile'>, onDeleted: () => void): ServerDeletion {
  const support = hostRemovalSupport(server);
  const [phase, setPhase] = useState<ServerDeletionPhase>('idle');
  const [choice, setChoice] = useState<HostRemovalChoice>(DEFAULT_HOST_REMOVAL);
  const [failure, setFailure] = useState<HostRemovalFailure | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/servers/${encodeURIComponent(server.name)}`;
  const calls: DeletionCalls = {
    uninstallHost: (request) => api<unknown>(`${path}/agent/uninstall`, { method: 'POST', body: JSON.stringify(request) }),
    deleteRow: () => api<unknown>(path, { method: 'DELETE' }),
  };

  /** Takes the outcome of a deletion attempt: gone, or why not. */
  function settle(result: DeletionResult): void {
    if (result.kind === 'deleted') {
      onDeleted();
    } else if (result.kind === 'hostFailed') {
      setFailure(result.failure);
      setPhase('hostFailed');
    } else {
      // The host is clean (or was not touched): asking again is safe, a second removal finds nothing to remove.
      setRowError(result.message);
    }
  }

  async function attempt(run: () => Promise<DeletionResult>): Promise<void> {
    setFailure(null);
    setRowError(null);
    setBusy(true);
    try {
      settle(await run());
    } finally {
      setBusy(false);
      setPhase((current) => (current === 'removingHost' ? 'confirming' : current));
    }
  }

  return {
    phase, support, choice, failure, rowError, busy,
    open() {
      setChoice(DEFAULT_HOST_REMOVAL);
      setFailure(null);
      setRowError(null);
      setPhase('confirming');
    },
    cancel() {
      setFailure(null);
      setRowError(null);
      setPhase('idle');
    },
    setRemoveFromHost: (value) => setChoice((c) => setRemoveFromHost(c, value)),
    setRemoveMisao: (value) => setChoice((c) => setRemoveMisao(c, value)),
    confirm: () => attempt(() => runDeletion(calls, support, choice, () => setPhase('removingHost'))),
    deleteEntryOnly: () => attempt(() => deleteEntryOnlyOf(calls)),
  };
}
