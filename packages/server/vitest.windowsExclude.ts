/**
 * Windows の CI（`Unit tests (Windows)`）でまだ通らない unit テストファイル。
 * ファイル名は変えずに、ここで外して理由を書く。Windows 対応（#379 の P2〜P9、#369〜#372）が進むたびに減らす。
 * 1〜数ケースだけが原因のファイルはここではなく、該当ケースの `it.skipIf(process.platform === 'win32')` で外している（理由はそのコメント）。
 * ここに載るのは、ファイルの大半のケースが落ちるもの（ファイル内の Windows でも通るケースも一緒に外れる）。
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
    file: 'src/modules/servers/agent-deploy/__tests__/BrowserRuntimeInstaller.test.ts',
    reason: '/bin/sh 前提（スクリプトを sh で実行）',
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
