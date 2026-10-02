import type { MuxRef } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';
import type { IMuxClient, PaneWindowLabels } from './IMuxClient';

/** Stamps the hub window (and task) identity on the window's panes, for drivers that keep pane labels. */
export async function labelRegisteredWindow(driver: IMuxClient, server: ServerConfig, ref: MuxRef, labels: PaneWindowLabels): Promise<void> {
  if (!driver.supportsPaneLabels) return;
  await driver.labelWindowPanes(server, ref, labels);
}

/**
 * Labels a window whose row the caller just added. When labelling fails the row is removed again (so a retry registers
 * and labels it afresh instead of leaving an unlabelled row behind) and the failure is rethrown.
 */
export async function labelAddedWindowOrRemove(
  driver: IMuxClient,
  server: ServerConfig,
  ref: MuxRef,
  labels: PaneWindowLabels,
  windowRepo: { remove(id: number): void },
): Promise<void> {
  try {
    await labelRegisteredWindow(driver, server, ref, labels);
  } catch (err) {
    windowRepo.remove(labels.windowId);
    throw err;
  }
}
