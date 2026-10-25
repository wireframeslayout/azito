import { useReducer } from 'react';
import { api } from '../api/client';
import { useLeftBehind } from './useLeftBehind';
import type { Server } from './useServerManagement';
import {
  deletionReducer, hostRemovalSupport, IDLE_DELETION, isDeletionBusy, runDeletion, runEntryOnly,
  type DeletionCalls, type DeletionEvent, type DeletionState, type HostRemovalSupport,
} from '../lib/serverDeletion';

export interface ServerDeletion extends DeletionState {
  support: HostRemovalSupport;
  /** The host removal or the row's deletion is in progress. */
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
 * The deletion of a server from the Danger section. The states and the flow are `lib/serverDeletion.ts` (a reducer and `runDeletion`,
 * tested there); this wires them to React and to the two API calls. The host is cleaned BEFORE the row is deleted and a failure never
 * deletes the row on its own: the person picks "delete the entry only" after seeing each step's result.
 */
export function useServerDeletion(server: Pick<Server, 'name' | 'type' | 'hostProfile'>, onDeleted: () => void): ServerDeletion {
  const support = hostRemovalSupport(server);
  const [state, dispatch] = useReducer(deletionReducer, IDLE_DELETION);
  const showLeftBehind = useLeftBehind();
  const path = `/servers/${encodeURIComponent(server.name)}`;
  const calls: DeletionCalls = {
    uninstallHost: (request) => api<unknown>(`${path}/agent/uninstall`, { method: 'POST', body: JSON.stringify(request) }),
    deleteRow: () => api<unknown>(path, { method: 'DELETE' }),
  };
  const send = (event: DeletionEvent): void => {
    dispatch(event);
    if (event.type === 'result' && event.result.kind === 'deleted') {
      // What the host removal left in place on purpose is shown in a dialog that outlives this page (the row, and so the page, are gone).
      if (event.result.left.length > 0) showLeftBehind(server.name, event.result.left);
      onDeleted();
    }
  };

  return {
    ...state,
    support,
    busy: isDeletionBusy(state),
    open: () => dispatch({ type: 'open' }),
    cancel: () => dispatch({ type: 'cancel' }),
    setRemoveFromHost: (value) => dispatch({ type: 'chooseRemoveFromHost', value }),
    setRemoveMisao: (value) => dispatch({ type: 'chooseRemoveMisao', value }),
    confirm: () => runDeletion(calls, support, state.choice, send),
    deleteEntryOnly: () => runEntryOnly(calls, send),
  };
}
