import type { ChipTone } from '../components/ui/Chip';
import { parseRepoUrl, repoDisplayName } from './gitProvider';

// リポジトリ登録フォーム（components/settings/RepositoryModals.tsx の
// AddRepositoryModal）と、プロジェクト設定「リポジトリ」一覧の行表示ロジックを
// 純粋関数として切り出したもの。lib/environmentRow.ts と同じ方針で、
// jsdom を使わない現状のテスト構成（vitest environment: 'node'、*.test.ts のみ）
// でもユニットテストできるようにしている。

/** 登録ペイロードの provider。URL から判定できない場合も登録できるよう 'other' を持つ。 */
export type RepositoryFormProvider = 'github' | 'gitlab' | 'other';

/** リポジトリ登録フォームの入力値。provider は URL から導出するのでここには持たない。 */
export interface RepositoryFormValues {
  url: string;
  /** 表示名（任意）。 */
  displayName: string;
  owner: string;
  repoName: string;
  /** ハブにのみ保存されるアクセストークン（任意）。 */
  token: string;
}

export const EMPTY_REPOSITORY_FORM: RepositoryFormValues = {
  url: '', displayName: '', owner: '', repoName: '', token: '',
};

/**
 * URL から provider / owner / repoName を解決する。lib/gitProvider.ts の
 * `parseRepoUrl` が唯一の解析実装で、ここはそれを登録ペイロードの形
 * （判定不能なら provider: 'other' + owner/repoName なし）に写すだけ。
 */
export function resolveRepositoryRegistration(url: string): { provider: RepositoryFormProvider; owner: string | null; repoName: string | null } {
  const parsed = parseRepoUrl(url);
  if (!parsed) return { provider: 'other', owner: null, repoName: null };
  return { provider: parsed.provider, owner: parsed.owner, repoName: parsed.repo };
}

/** 入力中の URL から自動判定されるプロバイダ（画面には Badge で表示のみする）。 */
export function resolveRepositoryProvider(url: string): RepositoryFormProvider {
  return resolveRepositoryRegistration(url).provider;
}

/**
 * URL 入力を反映した次のフォーム値。解析できた場合だけ owner / repoName を
 * 上書きする（解析できない URL に変えても、手入力済みの値は消さない）。
 */
export function applyRepositoryUrlChange(values: RepositoryFormValues, url: string): RepositoryFormValues {
  const parsed = parseRepoUrl(url);
  if (!parsed) return { ...values, url };
  return { ...values, url, owner: parsed.owner, repoName: parsed.repo };
}

/** 候補一覧から選択したときのフォーム値。候補が owner/repoName を持たなければ URL から解析する。 */
export function applyRepositoryCandidate(
  values: RepositoryFormValues,
  candidate: { httpsUrl: string; owner: string | null; repoName: string | null },
): RepositoryFormValues {
  if (candidate.owner && candidate.repoName) {
    return { ...values, url: candidate.httpsUrl, owner: candidate.owner, repoName: candidate.repoName };
  }
  return applyRepositoryUrlChange(values, candidate.httpsUrl);
}

/** POST /projects/:id/repositories のリクエストボディ（サーバー側の受け口は snake_case）。 */
export interface RepositoryCreatePayload {
  url: string;
  name?: string;
  provider: RepositoryFormProvider;
  owner?: string;
  repo_name?: string;
  token?: string;
}

/**
 * 登録ペイロードを組み立てる。URL が空なら null（呼び出し側でバリデーション
 * エラーを出す）。owner / repoName は入力欄の値だけを見る（URL から自動補完
 * された値も入力欄に入っているため）。provider だけは手動選択を廃止したので
 * URL からの自動判定を使う。
 */
export function buildRepositoryCreatePayload(values: RepositoryFormValues): RepositoryCreatePayload | null {
  const url = values.url.trim();
  if (!url) return null;
  return {
    url,
    name: values.displayName.trim() || undefined,
    provider: resolveRepositoryProvider(url),
    owner: values.owner.trim() || undefined,
    repo_name: values.repoName.trim() || undefined,
    token: values.token.trim() || undefined,
  };
}

/** 一覧行に出すチップ。 */
export interface RepositoryRowChip {
  id: 'provider' | 'token' | 'distribution';
  tone: ChipTone;
  /** git 名前空間の i18n キー。 */
  labelKey: string;
}

export interface RepositoryRowView {
  provider: RepositoryFormProvider;
  /** 行タイトル。表示名 → owner/repoName → URL の順で解決する。 */
  title: string;
  /** 行の説明。owner/repoName（無ければ URL）。 */
  description: string;
  chips: RepositoryRowChip[];
}

/** 一覧行の入力となるリポジトリ（GET /api/projects/:id が返す形の部分集合）。 */
export interface RepositoryRowInput {
  url: string;
  name?: string;
  provider?: string;
  owner?: string;
  repoName?: string;
  /** トークンが登録済みか。API が返さない場合は undefined（チップを出さない）。 */
  hasToken?: boolean;
}

function normalizeProvider(provider: string | undefined, url: string): RepositoryFormProvider {
  if (provider === 'github' || provider === 'gitlab' || provider === 'other') return provider;
  return resolveRepositoryProvider(url);
}

/**
 * 一覧1行分の表示情報。`usedAsDistributionSource` は「この project_servers の
 * どれかが distributionRepositoryId にこのリポジトリを指しているか」で、
 * 判定材料は既にセクションへ来ているデータ（projectServers）だけを使う。
 */
export function buildRepositoryRowView(
  repo: RepositoryRowInput,
  options: { usedAsDistributionSource: boolean },
): RepositoryRowView {
  const provider = normalizeProvider(repo.provider, repo.url);
  const path = repo.owner && repo.repoName ? `${repo.owner}/${repo.repoName}` : '';
  const description = path || repoDisplayName(repo.url) || repo.url;
  const chips: RepositoryRowChip[] = [
    { id: 'provider', tone: 'default', labelKey: `repo.${provider}` },
  ];
  if (repo.hasToken !== undefined) {
    chips.push(repo.hasToken
      ? { id: 'token', tone: 'green', labelKey: 'repo.chipTokenSet' }
      : { id: 'token', tone: 'default', labelKey: 'repo.chipTokenNone' });
  }
  if (options.usedAsDistributionSource) {
    chips.push({ id: 'distribution', tone: 'accent', labelKey: 'repo.chipDistributionSource' });
  }
  return { provider, title: repo.name || description, description, chips };
}

/** project_servers の配信先設定から、配信元として使われているリポジトリ ID の集合を作る。 */
export function collectDistributionRepositoryIds(
  projectServers: { distributionRepositoryId?: number | null }[],
): Set<number> {
  const ids = new Set<number>();
  for (const ps of projectServers) {
    if (typeof ps.distributionRepositoryId === 'number') ids.add(ps.distributionRepositoryId);
  }
  return ids;
}
