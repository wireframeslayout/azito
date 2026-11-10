import { formatWindowId, isInternalWindowName, stripGeneratedSuffix } from './windowId';
import { isMisaoWindowId } from './mux';

// Title priority: user label, agent pane title, auto label, task title, type, window ID.
// A pane title equal to its command is absent. Internal names and misao window IDs
// are excluded from labels, and generated --abcd suffixes are removed. The subtitle
// is the next distinct candidate. A single line is formatted as "title · W-123";
// if no candidate or ID is available, the mux target is the final fallback.
export interface WindowTitleInput {
  paneTitle?: string;
  paneCommand?: string;
  label?: string | null;
  labelSource?: 'auto' | 'user';
  taskTitle?: string;
  tmuxTarget?: string;
  id?: number;
  workerType?: string;
  windowType?: string;
}

export interface WindowTitle {
  title: string;
  subtitle?: string;
  idLabel?: string;
  hasDisplayName: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  claude: 'Claude', codex: 'Codex', generic: 'Terminal', terminal: 'Terminal',
};

export function resolvePaneDisplayTitle(paneTitle?: string, paneCommand?: string): string | undefined {
  const title = paneTitle?.trim();
  return title && title !== paneCommand?.trim() ? title : undefined;
}

function cleanLabel(value?: string | null): string | undefined {
  const label = value?.trim();
  if (!label || isInternalWindowName(label) || isMisaoWindowId(label)) return undefined;
  return stripGeneratedSuffix(label) || undefined;
}

export function resolveWindowTitle(input: WindowTitleInput): WindowTitle {
  const idLabel = input.id == null ? undefined : formatWindowId(input.id);
  const label = cleanLabel(input.label);
  const pane = resolvePaneDisplayTitle(input.paneTitle, input.paneCommand);
  const type = (input.workerType && TYPE_LABEL[input.workerType]) || (input.windowType && TYPE_LABEL[input.windowType]);
  const candidates = [input.labelSource === 'user' ? label : undefined, pane,
    input.labelSource !== 'user' ? label : undefined, input.taskTitle?.trim(), type].filter((v): v is string => !!v);
  const title = candidates[0] ?? idLabel ?? input.tmuxTarget ?? '';
  const subtitle = candidates.find((candidate, index) => index > 0 && candidate !== title);
  return { title, ...(subtitle ? { subtitle } : {}), ...(idLabel && title !== idLabel ? { idLabel } : {}), hasDisplayName: candidates.length > 0 };
}

export function formatWindowTitleLine(display: WindowTitle): string {
  return display.idLabel && display.title !== display.idLabel ? `${display.title} · ${display.idLabel}` : display.title;
}
