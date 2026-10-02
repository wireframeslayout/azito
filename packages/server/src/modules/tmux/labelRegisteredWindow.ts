import type { MuxRef } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';
import type { IMuxClient, PaneWindowLabels } from './IMuxClient';

/** Stamps the hub window (and task) identity on the window's panes, for drivers that keep pane labels. */
export async function labelRegisteredWindow(driver: IMuxClient, server: ServerConfig, ref: MuxRef, labels: PaneWindowLabels): Promise<void> {
  if (!driver.supportsPaneLabels) return;
  await driver.labelWindowPanes(server, ref, labels);
}
