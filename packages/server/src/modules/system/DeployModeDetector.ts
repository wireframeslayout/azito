import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { isReleaseMode } from '../../shared/releaseInfo';
import type { ServiceManagerKind } from './serviceManager';

export type DeployMode = 'systemd' | 'launchd' | 'taskscheduler' | 'source';

const LAUNCHD_PLIST_PATH = path.join('Library', 'LaunchAgents', 'com.azito.hub.plist');

/**
 * Detects how the hub was launched, to decide whether an in-app "run system
 * update" flow is available:
 *  - source: running from a git checkout (not a release bundle) — nothing to
 *    switch, the operator must `git pull` themselves.
 *  - launchd: macOS release install managed by a per-user LaunchAgent.
 *  - systemd: Linux release install managed by `systemctl --user`.
 *  - taskscheduler: Windows release install running as the Task Scheduler task
 *    (`run.ps1 -Service` hands the hub AZITO_HUB_EXIT_WITH_PID; no schtasks call is needed).
 *
 * systemd and launchd support the update flow; 'source' does not, because there
 * is no service to restart into the new version, and 'taskscheduler' does not
 * yet: the in-app update of a Windows install is #381.
 */
export class DeployModeDetector {
  // How the hub was launched can't change while this process is alive, but
  // detecting it (isSystemdUnitActive) spawns a blocking subprocess — cache
  // after the first call so GET /api/health (polled by uptime monitors) and
  // GET /api/system/update/status don't re-spawn `systemctl` on every request.
  private cached: DeployMode | null = null;

  /** `launchedByTaskScheduler`: this hub was started by its Task Scheduler task (resolved once at the entry point from the environment `run.ps1 -Service` sets). */
  constructor(private homeDir: string, private launchedByTaskScheduler: boolean) {}

  detect(): DeployMode {
    if (this.cached) return this.cached;
    this.cached = this.detectUncached();
    return this.cached;
  }

  private detectUncached(): DeployMode {
    if (!isReleaseMode()) return 'source';

    if (process.platform === 'win32') return this.launchedByTaskScheduler ? 'taskscheduler' : 'source';

    if (process.platform === 'darwin') {
      const plistPath = path.join(this.homeDir, LAUNCHD_PLIST_PATH);
      if (fs.existsSync(plistPath)) return 'launchd';
    }

    if (this.isSystemdUnitActive()) return 'systemd';

    return 'source';
  }

  canUpdate(): boolean {
    const mode = this.detect();
    return mode !== 'source' && mode !== 'taskscheduler';
  }

  /** The service manager to restart through, or null when there is none. */
  serviceManager(): ServiceManagerKind | null {
    const mode = this.detect();
    return mode === 'source' || mode === 'taskscheduler' ? null : mode;
  }

  getDisabledReason(): string | null {
    const mode = this.detect();
    if (mode === 'source') {
      // 'source' covers two situations: a git checkout, and a release bundle
      // started by hand instead of through a service manager. Telling the
      // latter to run `git pull` would be nonsense — there is no repository.
      if (isReleaseMode()) {
        if (process.platform === 'win32') {
          return 'タスクスケジューラのタスクとして起動されていないため、画面からは更新できません。install.ps1 でタスクを登録するか、手動で zip を展開して hub\\current.txt を書き換えてください';
        }
        return 'サービスとして登録されていないため、画面からは更新できません。install.sh でサービスを設定するか、手動で tarball を展開して current を切り替えてください';
      }
      return '開発モードで起動中のため、画面からは更新できません。ターミナルで git pull を実行してください';
    }
    if (mode === 'taskscheduler') {
      return 'Windows のタスクスケジューラで常駐しているハブは、画面からの更新にまだ対応していません（#381）。新しい zip を hub\\<版> に展開して hub\\current.txt を書き換え、`azito service restart` を実行してください';
    }
    return null;
  }

  private isSystemdUnitActive(): boolean {
    try {
      execFileSync('systemctl', ['--user', 'is-active', 'azito'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}
