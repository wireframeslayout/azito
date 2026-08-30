import type { GitProviderService } from './providers/GitProviderService';
import type { IProjectRepository } from '../projects/Project';
import type { RemoteRepositorySummary } from './providers/types';
import type { RepositoryProvider } from './parseRemoteUrl';
import { normalizeRemoteUrl } from './parseRemoteUrl';
import { sanitizeDiscoveredRemoteUrl } from './sanitizeDiscoveredRemoteUrl';

/** プロジェクト作成ウィザードで提示する1件のリポジトリ候補。 */
export interface RepositoryCandidate {
  /** 'registered' = AZITOに既に登録済み（全プロジェクト横断）、'provider' = プロバイダAPIから取得 */
  source: 'registered' | 'provider';
  provider: RepositoryProvider;
  owner: string | null;
  repoName: string | null;
  /** cloneに使えるURL（sanitizeDiscoveredRemoteUrl済み） */
  httpsUrl: string;
  defaultBranch: string | null;
  private: boolean | null;
  updatedAt: string | null;
  /** 登録済みリポジトリがトークンを保持しているか（トークン自体は返さない） */
  hasToken: boolean;
}

export interface ProviderFetchError {
  provider: 'github' | 'gitlab';
  message: string;
}

export interface RepositoryCandidatesResult {
  candidates: RepositoryCandidate[];
  /** 件数上限（{@link MAX_CANDIDATES}）で切り捨てた場合true */
  truncated: boolean;
  /** プロバイダAPI取得が失敗したプロバイダの一覧（空配列は全プロバイダ成功、または対象プロバイダなしを意味する） */
  providerErrors: ProviderFetchError[];
}

export type ProviderFilter = 'github' | 'gitlab' | 'all';

/** レスポンスに含める候補数の上限。超えた分は黙って切り捨てず truncated フラグで示す。 */
const MAX_CANDIDATES = 50;

/** プロバイダAPI結果の短時間キャッシュTTL（ウィザードの入力毎に外部APIを叩かないため）。 */
const PROVIDER_CACHE_TTL_MS = 60 * 1000;

interface ProviderCacheEntry {
  repositories: RemoteRepositorySummary[] | null;
  /** プロバイダ自身がページ上限で打ち切ったか（{@link ListAccessibleRepositoriesResult.truncated}）。 */
  truncated: boolean;
  errorMessage: string | null;
  expiresAt: number;
}

/**
 * プロジェクト作成ウィザードの「候補を提示」機能向けに、AZITO登録済み
 * リポジトリ（全プロジェクト横断）とプロバイダAPI（GitHub/GitLab）の
 * リポジトリ一覧をマージして返す。プロバイダAPIの失敗はエラーとして
 * 結果に含め、登録済み候補は失敗と無関係に常に返す（空配列で成功を装わない）。
 */
export class RepositoryCandidateService {
  // キャッシュキーはプロバイダ＋トークン有無のみ（トークン文字列自体は保持しない）。
  private providerCache = new Map<string, ProviderCacheEntry>();

  constructor(
    private projectRepo: IProjectRepository,
    private gitProvider: GitProviderService,
  ) {}

  async listCandidates(opts: { q?: string; provider?: ProviderFilter }): Promise<RepositoryCandidatesResult> {
    const q = (opts.q || '').trim().toLowerCase();
    const providerFilter = opts.provider ?? 'all';
    const providers: ('github' | 'gitlab')[] = providerFilter === 'all' ? ['github', 'gitlab'] : [providerFilter];

    const registered = this.collectRegisteredCandidates();
    const providerErrors: ProviderFetchError[] = [];
    const providerCandidates: RepositoryCandidate[] = [];
    let providerTruncated = false;

    for (const provider of providers) {
      try {
        const { repositories, truncated } = await this.fetchProviderRepositories(provider);
        if (truncated) providerTruncated = true;
        for (const repo of repositories) {
          const safeUrl = sanitizeDiscoveredRemoteUrl(repo.httpsUrl);
          if (safeUrl === null) continue;
          providerCandidates.push({
            source: 'provider',
            provider: repo.provider,
            owner: repo.owner,
            repoName: repo.repoName,
            httpsUrl: safeUrl,
            defaultBranch: repo.defaultBranch,
            private: repo.private,
            updatedAt: repo.updatedAt,
            hasToken: false,
          });
        }
      } catch (err) {
        providerErrors.push({ provider, message: err instanceof Error ? err.message : 'Unknown provider error' });
      }
    }

    const merged = this.dedupe(registered, providerCandidates);
    const filtered = q
      ? merged.filter((c) => `${c.owner ?? ''}/${c.repoName ?? ''}`.toLowerCase().includes(q))
      : merged;

    const localTruncated = filtered.length > MAX_CANDIDATES;
    const candidates = localTruncated ? filtered.slice(0, MAX_CANDIDATES) : filtered;
    // ローカルの50件上限による切り捨てと、プロバイダ自身のページ上限による切り捨て（絞り込み後は
    // 50件未満になり得るため、ローカル判定だけでは検出できない）のORを取る。
    const truncated = localTruncated || providerTruncated;

    return { candidates, truncated, providerErrors };
  }

  /**
   * 登録済みを優先し、normalizeRemoteUrlで同一と見なせるものを1件にまとめる。
   * ただし登録済み側の `defaultBranch`/`private`/`updatedAt` は常にnull（DBに保持しない項目）
   * のため、衝突時は `source`/`hasToken` のみ登録済みを維持し、それ以外はプロバイダ側の値で
   * 補う（プロバイダがdevelopをデフォルトブランチと報告しているのに、登録済み側の
   * null由来でウィザードの既定がmainのまま残る、という不整合を防ぐ）。
   */
  private dedupe(registered: RepositoryCandidate[], provider: RepositoryCandidate[]): RepositoryCandidate[] {
    const byKey = new Map<string, RepositoryCandidate>();
    // projectRepo.findAll() は新しい順。同一URLが複数プロジェクトに登録されていると、
    // どちらの重複が先/後に並ぶかは「新しい順」でしかなく、トークンを持つ方とは無関係
    // （新しい方に限らずどちらにも起こり得る）。無条件上書き（旧実装）はもちろん、単純な
    // 先勝ちも「先に見つかった重複がトークン無しなら、後続の重複が持つ hasToken: true を
    // 拾えない」という同種の退行になり得るため、hasToken は「一致するいずれかの登録済み
    // 重複がトークンを持つか」の意味に定め、重複間で OR を取る（プロバイダのメタデータ
    // 合成とは無関係の退行を避ける）。
    for (const candidate of registered) {
      const key = normalizeRemoteUrl(candidate.httpsUrl);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, candidate);
      } else if (candidate.hasToken && !existing.hasToken) {
        byKey.set(key, { ...existing, hasToken: true });
      }
    }
    for (const candidate of provider) {
      const key = normalizeRemoteUrl(candidate.httpsUrl);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, candidate);
        continue;
      }
      byKey.set(key, {
        ...existing,
        defaultBranch: candidate.defaultBranch,
        private: candidate.private,
        updatedAt: candidate.updatedAt,
      });
    }
    return [...byKey.values()];
  }

  private collectRegisteredCandidates(): RepositoryCandidate[] {
    const candidates: RepositoryCandidate[] = [];
    for (const project of this.projectRepo.findAll()) {
      for (const repo of project.repositories) {
        const safeUrl = sanitizeDiscoveredRemoteUrl(repo.url);
        if (safeUrl === null) continue;
        candidates.push({
          source: 'registered',
          provider: repo.provider,
          owner: repo.owner,
          repoName: repo.repoName,
          httpsUrl: safeUrl,
          defaultBranch: null,
          private: null,
          updatedAt: null,
          hasToken: repo.hasToken,
        });
      }
    }
    return candidates;
  }

  private async fetchProviderRepositories(provider: 'github' | 'gitlab'): Promise<{ repositories: RemoteRepositorySummary[]; truncated: boolean }> {
    // このエントリポイントは呼び出し元から明示トークンを受け取らない（gh/glab CLIの
    // フォールバックに一任する）ため、hasToken部分は常に'no-token'固定。将来トークンを
    // 渡す経路ができた場合に備えてキー形式だけ用意しておく。
    const cacheKey = `${provider}:no-token`;
    const cached = this.providerCache.get(cacheKey);
    const now = Date.now();
    if (cached && now < cached.expiresAt) {
      if (cached.errorMessage !== null) throw new Error(cached.errorMessage);
      return { repositories: cached.repositories!, truncated: cached.truncated };
    }

    try {
      const result = await this.gitProvider.listAccessibleRepositories(provider);
      this.providerCache.set(cacheKey, { repositories: result.repositories, truncated: result.truncated, errorMessage: null, expiresAt: now + PROVIDER_CACHE_TTL_MS });
      return { repositories: result.repositories, truncated: result.truncated };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      this.providerCache.set(cacheKey, { repositories: null, truncated: false, errorMessage: message, expiresAt: now + PROVIDER_CACHE_TTL_MS });
      throw err;
    }
  }
}
