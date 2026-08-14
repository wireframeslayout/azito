import type { DeployMode } from './DeployModeDetector';

/**
 * 稼働検知診断（Settings の診断節／ステータスバーの導線）を出してよいかの判定。
 *
 * ソースコード版は開発者しか動かさないので常に出す。インストール版は「開発中バージョン」
 * （プレリリース更新チャンネル = 'rc'）を選んでいる利用者だけを対象にする — 一般利用者の
 * 画面に内部診断が混ざらないようにするためのゲート。API 自体（GET /api/debug/activity）は
 * このフラグに関わらず存置する。
 */
export function isDiagnosticsEnabled(deployMode: DeployMode, channel: 'stable' | 'rc'): boolean {
  return deployMode === 'source' || channel === 'rc';
}
