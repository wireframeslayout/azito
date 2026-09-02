import * as crypto from 'crypto';
import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';

/**
 * `repoIdentity.httpsUrl` から決定的なディレクトリ名を導出する純粋関数。
 *
 * hub 側の repo キャッシュ（`HubRepoCache`）とサーバー側の配布用 bare mirror
 * （`RemoteBundleOps` の `~/.azito/repos/<hash>.git`）の両方が、同じリポジトリを
 * 指す同じハッシュ値を使う必要があるため、ここに切り出して共有する（Issue #87）。
 */
export function computeRepoHash(identity: CanonicalRepositoryIdentity): string {
  return crypto.createHash('sha256').update(identity.httpsUrl).digest('hex').slice(0, 16);
}
