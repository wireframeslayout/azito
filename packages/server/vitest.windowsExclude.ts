/**
 * Windows の CI（`Unit tests (Windows)`）でまだ通らない unit テストファイル。
 * ファイル名は変えずに、ここで外して理由を書く。Windows 対応（#379 の P2〜P9、#369〜#372）が進むたびに減らす。
 * 一部のケースだけが原因のファイルはここではなく、該当ケースの `it.skipIf(process.platform === 'win32')` で外している
 * （理由はそのコメント）。ここに載るのは、ファイルの読み込み時またはほぼ全ケースが Windows で成立しないものだけ。
 * vitest.config.ts は Windows のときだけ unit プロジェクトの exclude にこれを足す（Linux / macOS には影響しない）。
 */
export interface WindowsExcludeEntry {
  /** packages/server からの相対パス（スラッシュ区切り）。 */
  file: string;
  reason: string;
}

export const WINDOWS_EXCLUDED_UNIT_TESTS: readonly WindowsExcludeEntry[] = [
  {
    file: 'src/modules/system/misao/MisaoAgentInstaller.test.ts',
    reason: 'home の安全パス検査が C:\\ を拒否する POSIX 前提。systemd やバックグラウンドプロセスを起動する多くのケースが落ち、ワーカーが EPIPE で異常終了する（ケース単位の skip を重ねても収まらなかった）',
  },
  {
    file: 'src/modules/system/misao/MisaoServiceService.test.ts',
    reason: 'misaoTargetFor が win32 の misao バイナリを持たず、ファイルの読み込み時に失敗する（unsupported）',
  },
  {
    file: 'src/modules/system/misao/MisaoServiceService.launchd.test.ts',
    reason: 'POSIX パス前提（launchd の prefix に \\ を含められない）。全 4 ケースが対象',
  },
  {
    file: 'src/modules/transcripts/agentTranscript.integration.test.ts',
    reason: '/bin/sleep を claude の代わりに symlink して実エージェントを起動する POSIX 前提（ファイル全体が 1 つの統合シナリオ）',
  },
];
