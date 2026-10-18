/**
 * Windows の CI（`Unit tests (Windows)`）でまだ通らない unit テストファイル。
 * ファイル名は変えずに、ここで外して理由を書く。Windows 対応（#379 の P2〜P9、#369〜#372）が進むたびに減らす。
 * vitest.config.ts は Windows のときだけ unit プロジェクトの exclude にこれを足す（Linux / macOS には影響しない）。
 */
export interface WindowsExcludeEntry {
  /** packages/server からの相対パス（スラッシュ区切り）。 */
  file: string;
  reason: string;
}

export const WINDOWS_EXCLUDED_UNIT_TESTS: readonly WindowsExcludeEntry[] = [
  {
    file: 'src/agent/misaoRelay.test.ts',
    reason: 'POSIX パス前提（/home/u の連結）と Unix ドメインソケットの listen が EACCES。ワーカー異常終了の原因にもなる',
  },
  {
    file: 'src/agent/misaoRoutes.test.ts',
    reason: 'mode 前提（chmod 0o755 を検証）',
  },
  {
    file: 'src/cli/authDoctorCommand.test.ts',
    reason: 'mode 600 前提（operator.env の権限検査。P2 の SecretFileGuard で扱う）',
  },
  {
    file: 'src/cli/tokenCommand.test.ts',
    reason: 'mode 600 前提（rotate 後の権限を検証）',
  },
  {
    file: 'src/modules/agents/claude/ensureClaudeTrust.test.ts',
    reason: 'mode 600 前提',
  },
  {
    file: 'src/shared/dataDir.test.ts',
    reason: 'mode 700 前提（データディレクトリの権限）',
  },
  {
    file: 'src/shared/uiToken.test.ts',
    reason: 'mode 600 前提',
  },
  {
    file: 'src/modules/sidekicks/SidekickPackageService.test.ts',
    reason: 'mode 前提（chmod 0o755 を検証）',
  },
  {
    file: 'src/modules/sidekicks/routes.test.ts',
    reason: 'mode 前提（chmod 0o755 を検証）',
  },
  {
    file: 'src/modules/tasks/execution/ExecutionManifest.test.ts',
    reason: 'mode 前提（chmod 000 で読めなくなることを検証）',
  },
  {
    file: 'src/modules/files/FileBrowseService.test.ts',
    reason: 'POSIX 前提（シンボリックリンク作成・O_NOFOLLOW・エラー文言）',
  },
  {
    file: 'src/modules/files/ws/fileTailHandler.test.ts',
    reason: '/tmp/azito-pipe- の固定パス前提（P3 で許可の見直し）',
  },
  {
    file: 'src/modules/git/hub-transfer/HubRepoCache.test.ts',
    reason: '実 git を複数回起動して既定の 5 秒で時間切れ（Windows の CI では遅い。初回の実行では通ったので不安定）',
  },
  {
    file: 'src/modules/git/RepoDiscoveryService.test.ts',
    reason: '/bin/bash 前提',
  },
  {
    file: 'src/modules/git/WorktreeService.test.ts',
    reason: '存在しない POSIX パスを cwd に使うテスト（spawnSync git ENOENT）',
  },
  {
    file: 'src/modules/servers/agent-deploy/__tests__/BrowserRuntimeInstaller.test.ts',
    reason: '/bin/sh 前提（スクリプトを sh で実行）',
  },
  {
    file: 'src/modules/servers/agent-deploy/__tests__/integrityVerifier.test.ts',
    reason: 'bash / tar / HOME 前提（Unix の展開コマンドを実行）',
  },
  {
    file: 'src/modules/servers/routes.isolationIntent.test.ts',
    reason: '/bin/sh 前提（isolation doctor が sh 文字列を実行）',
  },
  {
    file: 'src/modules/sidekicks/SidekickSyncService.test.ts',
    reason: 'sh / tar 前提（転送コマンドを実行してタイムアウト）',
  },
  {
    file: 'src/modules/system/__tests__/DeployModeDetector.test.ts',
    reason: 'process.platform による systemd / launchd 判定の期待値が Linux 前提（P8 / #380）',
  },
  {
    file: 'src/modules/system/misao/MisaoAgentInstaller.test.ts',
    reason: 'POSIX パス前提（home の安全パス検査が C:\\ を拒否）',
  },
  {
    file: 'src/modules/system/misao/MisaoServiceController.test.ts',
    reason: 'POSIX パス前提（/home/u の連結）',
  },
  {
    file: 'src/modules/system/misao/MisaoServiceService.launchd.test.ts',
    reason: 'POSIX パス前提（prefix に \\ を含められない）',
  },
  {
    file: 'src/modules/system/misao/MisaoServiceService.test.ts',
    reason: 'misao の win32 バイナリが無い（misaoTargetFor が unsupported）',
  },
  {
    file: 'src/modules/tasks/TaskRestoreService.test.ts',
    reason: 'Windows の短いパス名（RUNNER~1）と長い名前の不一致（realpath 比較）',
  },
  {
    file: 'src/modules/tasks/execution/ExecuteTaskUseCase.env.test.ts',
    reason: 'Windows の短いパス名（RUNNER~1）と長い名前の不一致、cd -- の sh 文字列前提',
  },
  {
    file: 'src/modules/tmux/PaneOutputStream.test.ts',
    reason: 'tail -f 前提（P3 で Node のファイル追跡に置き換え）',
  },
  {
    file: 'src/modules/tmux/misao/misaoDriver.test.ts',
    reason: 'MISAO_SOCKET が Unix ソケットパス前提（Windows は名前付きパイプ）',
  },
  {
    file: 'src/modules/transcripts/agentTranscript.integration.test.ts',
    reason: 'POSIX の bin スクリプト（シェバン）を実行する前提',
  },
  {
    file: 'src/modules/windows/WindowRespawnService.test.ts',
    reason: 'Windows の短いパス名（RUNNER~1）と cd -- の sh 文字列前提',
  },
];
