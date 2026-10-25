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

/**
 * The deletion the person confirmed: when the host is to be touched (a Windows agent, the choice on), the agent is taken off it
 * FIRST, and the row is deleted only if that worked. A failed host removal never deletes the row; the caller shows the steps and the
 * person chooses {@link deleteEntryOnly}. `onRemovingHost` is called once the (slow) host removal starts.
 */
export async function runDeletion(calls: DeletionCalls, support: HostRemovalSupport, choice: HostRemovalChoice, onRemovingHost: () => void): Promise<DeletionResult> {
  const request = uninstallRequestFor(support, choice);
  if (request === null) return deleteEntryOnly(calls);
  onRemovingHost();
  let failure: HostRemovalFailure | null;
  try {
    failure = readUninstallAnswer(await calls.uninstallHost(request));
  } catch (err: unknown) {
    failure = { kind: 'error', message: (err as Error).message };
  }
  if (failure !== null) return { kind: 'hostFailed', failure };
  return deleteEntryOnly(calls);
}
