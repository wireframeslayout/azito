import { errorMessageOf } from './apiResult';
import type { HostProfile } from './hostProfile';

/** What deleting a server can also do to its host. `windows`: the agent can be removed from the host with the row. `unsupported`: an agent on a host this release cannot clean (#499). `none`: nothing runs on the host for this server. */
export type HostRemovalSupport = 'windows' | 'unsupported' | 'none';

export function hostRemovalSupport(server: { type: string; hostProfile?: HostProfile | null }): HostRemovalSupport {
  if (server.type !== 'agent') return 'none';
  return server.hostProfile?.platform === 'win32' ? 'windows' : 'unsupported';
}

export type UninstallStepId = 'task' | 'processes' | 'firewall' | 'folder' | 'misaoTask' | 'misaoProcesses' | 'misaoFolder';
export type UninstallOutcome = 'done' | 'absent' | 'failed' | 'skipped';

export interface UninstallStep {
  id: UninstallStepId;
  outcome: UninstallOutcome;
  detail?: string;
}

/** Why the agent could not be taken off the host: the steps the hub reports (some failed), or a reason when nothing could be done (host unreachable, refused). */
export type HostRemovalFailure =
  | { kind: 'steps'; steps: UninstallStep[] }
  | { kind: 'error'; message: string };

const STEP_IDS: ReadonlySet<string> = new Set<UninstallStepId>(['task', 'processes', 'firewall', 'folder', 'misaoTask', 'misaoProcesses', 'misaoFolder']);
const OUTCOMES: ReadonlySet<string> = new Set<UninstallOutcome>(['done', 'absent', 'failed', 'skipped']);

function parseSteps(value: unknown): UninstallStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: UninstallStep[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { id, outcome, detail } = item as { id?: unknown; outcome?: unknown; detail?: unknown };
    if (typeof id !== 'string' || !STEP_IDS.has(id) || typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return null;
    steps.push({ id: id as UninstallStepId, outcome: outcome as UninstallOutcome, ...(typeof detail === 'string' ? { detail } : {}) });
  }
  return steps;
}

/**
 * Reads the answer of `POST /api/servers/:name/agent/uninstall`. `null` = the agent is off the host (`ok: true`); otherwise why not.
 * Anything that is not a well-formed result is a failure, never a success: the row is only deleted for a body that says `ok: true` with its steps.
 */
export function readUninstallAnswer(body: unknown): HostRemovalFailure | null {
  if (typeof body === 'object' && body !== null && 'ok' in body && 'steps' in body) {
    const steps = parseSteps((body as { steps: unknown }).steps);
    const ok = (body as { ok: unknown }).ok;
    if (steps !== null && ok === true) return null;
    if (steps !== null && ok === false) return { kind: 'steps', steps };
  }
  return { kind: 'error', message: errorMessageOf(body) ?? '' };
}

/** The steps that did not work: what the person has to look at. */
export function failedSteps(steps: readonly UninstallStep[]): UninstallStep[] {
  return steps.filter((s) => s.outcome === 'failed');
}

export interface HostRemovalChoice {
  /** Remove the agent from the host before the row is deleted. Meaningful for `windows` only. */
  removeFromHost: boolean;
  /** Also remove the misao beside the agent (every window of the host closes). Only with `removeFromHost`. */
  removeMisao: boolean;
}

export const DEFAULT_HOST_REMOVAL: HostRemovalChoice = { removeFromHost: true, removeMisao: false };

/** What `POST .../agent/uninstall` is sent for this choice; `null` = delete the row without touching the host. */
export function uninstallRequestFor(support: HostRemovalSupport, choice: HostRemovalChoice): { removeMisao: boolean } | null {
  if (support !== 'windows' || !choice.removeFromHost) return null;
  return { removeMisao: choice.removeMisao };
}

/** Turning the host removal off also turns the misao off (it is only offered with it). */
export function setRemoveFromHost(choice: HostRemovalChoice, removeFromHost: boolean): HostRemovalChoice {
  return { removeFromHost, removeMisao: removeFromHost ? choice.removeMisao : false };
}

/** The misao can be chosen only with the host removal. */
export function setRemoveMisao(choice: HostRemovalChoice, removeMisao: boolean): HostRemovalChoice {
  return choice.removeFromHost ? { ...choice, removeMisao } : choice;
}

export type DeletionResult =
  | { kind: 'deleted' }
  /** The host removal did not work: the row was NOT deleted. */
  | { kind: 'hostFailed'; failure: HostRemovalFailure }
  /** The row could not be deleted (the host removal, when one was asked for, had worked). */
  | { kind: 'rowFailed'; message: string };

// ─── The state of the confirmation ───

/**
 * - `idle`: nothing asked yet.
 * - `confirming`: the choices are shown (also while the row is being deleted).
 * - `removingHost`: the agent is being taken off the host; the row is still there.
 * - `hostFailed`: the host removal did not work; the row is still there and the person decides (try again, delete only the entry, cancel).
 */
export type DeletionPhase = 'idle' | 'confirming' | 'removingHost' | 'hostFailed';

export interface DeletionState {
  phase: DeletionPhase;
  choice: HostRemovalChoice;
  /** The result of the host removal that failed. Kept while the person tries again or deletes the entry only, so it never disappears from the screen. */
  failure: HostRemovalFailure | null;
  /** Why the row itself could not be deleted: a state of its own, beside `failure`. */
  rowError: string | null;
  /** The row is being deleted. */
  deletingRow: boolean;
}

export const IDLE_DELETION: DeletionState = { phase: 'idle', choice: DEFAULT_HOST_REMOVAL, failure: null, rowError: null, deletingRow: false };

export type DeletionEvent =
  | { type: 'open' }
  | { type: 'cancel' }
  | { type: 'chooseRemoveFromHost'; value: boolean }
  | { type: 'chooseRemoveMisao'; value: boolean }
  | { type: 'removingHost' }
  | { type: 'deletingRow' }
  | { type: 'result'; result: DeletionResult };

/** Something is in flight (the host removal or the row's deletion): the choices and cancel are off. */
export function isDeletionBusy(state: DeletionState): boolean {
  return state.phase === 'removingHost' || state.deletingRow;
}

export function deletionReducer(state: DeletionState, event: DeletionEvent): DeletionState {
  switch (event.type) {
    case 'open':
      return state.phase === 'idle' ? { ...IDLE_DELETION, phase: 'confirming' } : state;
    case 'cancel':
      return isDeletionBusy(state) ? state : IDLE_DELETION;
    case 'chooseRemoveFromHost':
      return state.phase === 'confirming' && !isDeletionBusy(state) ? { ...state, choice: setRemoveFromHost(state.choice, event.value) } : state;
    case 'chooseRemoveMisao':
      return state.phase === 'confirming' && !isDeletionBusy(state) ? { ...state, choice: setRemoveMisao(state.choice, event.value) } : state;
    case 'removingHost':
      return { ...state, phase: 'removingHost', failure: null, rowError: null };
    case 'deletingRow':
      // The host part is over (it worked, or was not asked for): back to the choices, unless the person is on the failure screen, which stays.
      return { ...state, phase: state.phase === 'removingHost' ? 'confirming' : state.phase, rowError: null, deletingRow: true };
    case 'result': {
      const { result } = event;
      if (result.kind === 'deleted') return IDLE_DELETION;
      if (result.kind === 'hostFailed') return { ...state, phase: 'hostFailed', failure: result.failure, deletingRow: false };
      return { ...state, phase: state.phase === 'removingHost' ? 'confirming' : state.phase, rowError: result.message, deletingRow: false };
    }
  }
}

// ─── The calls ───

export interface DeletionCalls {
  /** `POST /api/servers/:name/agent/uninstall`: resolves with the body, rejects when the call itself failed. */
  uninstallHost(request: { removeMisao: boolean }): Promise<unknown>;
  /** `DELETE /api/servers/:name`. */
  deleteRow(): Promise<unknown>;
}

/** Deletes the row alone. An answer that is an error, or a call that throws, is a failure: the row is only gone for a clean answer. */
export async function deleteEntryOnly(calls: DeletionCalls): Promise<DeletionResult> {
  try {
    const message = errorMessageOf(await calls.deleteRow());
    return message === null ? { kind: 'deleted' } : { kind: 'rowFailed', message };
  } catch (err: unknown) {
    return { kind: 'rowFailed', message: (err as Error).message };
  }
}

/** "Delete the entry only": the row is deleted, the host is not asked, and a failure of the row is reported as its own state. */
export async function runEntryOnly(calls: DeletionCalls, dispatch: (event: DeletionEvent) => void): Promise<void> {
  dispatch({ type: 'deletingRow' });
  dispatch({ type: 'result', result: await deleteEntryOnly(calls) });
}

/**
 * The deletion the person confirmed: when the host is to be touched (a Windows agent, the choice on), the agent is taken off it
 * FIRST, and the row is deleted only if that worked. A failed host removal never deletes the row; the screen shows the steps and the
 * person chooses {@link runEntryOnly}. Every step is an event, so the screen follows what is happening.
 */
export async function runDeletion(calls: DeletionCalls, support: HostRemovalSupport, choice: HostRemovalChoice, dispatch: (event: DeletionEvent) => void): Promise<void> {
  const request = uninstallRequestFor(support, choice);
  if (request === null) return runEntryOnly(calls, dispatch);
  dispatch({ type: 'removingHost' });
  let failure: HostRemovalFailure | null;
  try {
    failure = readUninstallAnswer(await calls.uninstallHost(request));
  } catch (err: unknown) {
    failure = { kind: 'error', message: (err as Error).message };
  }
  if (failure !== null) {
    dispatch({ type: 'result', result: { kind: 'hostFailed', failure } });
    return;
  }
  return runEntryOnly(calls, dispatch);
}
