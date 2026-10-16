import type { UnresolvedReason } from './transcriptTypes';

/**
 * エージェントサーバー上の会話ログに届かない理由（サーバーの resolve-window の reason と、会話ログ読み取りの
 * エラー本文 `{ error }` で同じ文字列を使う）。unsupported_server / no_recent_session は「そのサーバーでは
 * 読めない」「対応するセッションが無い」で、ここには含めない。
 */
export type HostUnavailableReason = Extract<UnresolvedReason, 'agent_unreachable' | 'agent_outdated'>;

export function hostUnavailableReason(value: string | undefined): HostUnavailableReason | null {
  return value === 'agent_unreachable' || value === 'agent_outdated' ? value : null;
}
