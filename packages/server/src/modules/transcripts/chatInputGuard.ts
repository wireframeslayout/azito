import type { PaneHandle } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';
import type { IMuxClient } from '../tmux/IMuxClient';
import { isBareShellCommand } from '../../shared/os/shellCommands';
import { blockingWorkerDialog, isWorkerScreenReady, readInputBox, tuiAgentKindOfWorkerType } from '../tasks/execution/runtime/workerScreen';

export interface ChatInputRejection { code: string; error: string }

export async function guardChatInput(driver: IMuxClient, server: ServerConfig, handle: PaneHandle, workerType: string | null, text: string): Promise<ChatInputRejection | null> {
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return { code: 'invalid_control_character', error: 'The message contains unsupported control characters.' };
  const foreground = await driver.paneCommandByHandle(server, handle);
  if (!foreground) return { code: 'pane_unavailable', error: 'Cannot verify the pane process.' };
  if (isBareShellCommand(foreground)) return { code: 'worker_exited_to_shell', error: 'The pane is at a shell prompt.' };
  const kind = tuiAgentKindOfWorkerType(workerType);
  if (!kind) return { code: 'unsupported_worker', error: 'Cannot verify that this pane is ready for chat input.' };
  const screen = await driver.captureScreen(server, handle);
  if (screen.code !== 0) return { code: 'screen_unavailable', error: 'Cannot read the pane screen.' };
  const dialog = blockingWorkerDialog(kind, screen.stdout);
  if (dialog) return { code: dialog, error: 'The agent is waiting for a dialog to be resolved.' };
  if (!isWorkerScreenReady(kind, screen.stdout)) return { code: 'not_ready', error: 'The agent input is not ready.' };
  const box = readInputBox(kind, screen.stdout);
  if (box.state === 'ambiguous' && box.text.startsWith('Press up to')) return { code: 'not_ready', error: 'The agent has a queued message. Check the terminal before trying again.' };
  if (box.state !== 'empty') return { code: 'input_not_empty', error: 'The input may contain a suggestion or a draft. Check it in the terminal and clear or submit it before trying again.' };
  return null;
}

/** Types `text` into the agent's input: a line with a newline or a tab goes as one paste, so neither reaches the agent as a key. */
export async function typeChatText(driver: IMuxClient, server: ServerConfig, handle: PaneHandle, text: string): Promise<void> {
  if (/[\n\t]/.test(text)) await driver.pasteTextToHandle(server, handle, text);
  else await driver.sendTextToHandle(server, handle, text);
}
