import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { HerdrNavigationLock } from '@azito/shared';

const LOCKED_TOML = `onboarding = false
[ui]
sidebar_start_collapsed = true
sidebar_collapsed_mode = "hidden"
hide_tab_bar_when_single_tab = true
mouse_capture = true
[keys]
prefix = "f24"
workspace_picker = ""
goto = ""
new_workspace = ""
close_workspace = ""
rename_workspace = ""
new_worktree = ""
new_tab = ""
next_tab = ""
previous_tab = ""
switch_tab = ""
close_tab = ""
toggle_sidebar = ""
detach = ""
`;

const FREE_TOML = `onboarding = false
[ui]
sidebar_start_collapsed = true
sidebar_collapsed_mode = "hidden"
hide_tab_bar_when_single_tab = true
mouse_capture = true
`;

export function herdrClientConfigDir(): string {
  return path.join(os.homedir(), '.azito', 'herdr');
}

export function herdrClientConfigPath(lock: HerdrNavigationLock): string {
  return path.join(herdrClientConfigDir(), `client-${lock}.toml`);
}

function writeIfChanged(filePath: string, content: string): void {
  try {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === content) return;
  } catch {
    // file doesn't exist — will be created
  }
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

export function ensureHerdrClientConfigs(): void {
  const dir = herdrClientConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeIfChanged(path.join(dir, 'client-locked.toml'), LOCKED_TOML);
  writeIfChanged(path.join(dir, 'client-free.toml'), FREE_TOML);
}

export const HERDR_RECOMMENDED_UI: Record<string, string> = {
  hide_tab_bar_when_single_tab: 'true',
  sidebar_collapsed_mode: '"hidden"',
  mouse_capture: 'true',
};
