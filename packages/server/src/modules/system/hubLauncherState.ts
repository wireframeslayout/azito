import * as fs from 'fs';
import { z } from 'zod';

/**
 * What the Windows hub's launcher records in `<prefix>\logs\hub-launcher.json` (see `buildHubLauncherScript`): the Task Scheduler's
 * Last Result stays 0 whatever happens to the hub below the launcher, so this file (and hub.log) is where restarts are visible.
 * It is rewritten at every start of the launcher, so it describes the last launcher that ran (it stays after `azito stop`).
 */
const launcherStateSchema = z.object({
  startedAt: z.string(),
  restarts: z.number().int().nonnegative(),
  lastExitCode: z.number().int().nullable(),
  lastExitAt: z.string().nullable(),
  nextWaitSeconds: z.number().nonnegative(),
});

export type HubLauncherState = z.infer<typeof launcherStateSchema>;

/** The launcher's record, or undefined when it has not written one (a task from before the launcher kept it, or never started). A file that is there but cannot be read is an error. */
export function readHubLauncherState(file: string): HubLauncherState | undefined {
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '');
  return launcherStateSchema.parse(JSON.parse(text));
}

/** One line for `azito status`. */
export function describeHubLauncherState(state: HubLauncherState): string {
  if (state.restarts === 0) return `no restart since the launcher began (${state.startedAt})`;
  const code = state.lastExitCode === null ? 'the launcher could not start it' : `last exit code ${state.lastExitCode}`;
  return `${state.restarts} restart${state.restarts === 1 ? '' : 's'} since ${state.startedAt} (${code}, at ${state.lastExitAt})`;
}
