import type { ChipTone } from '../components/ui/Chip';

// プロジェクト設定「サーバー環境」一覧（ProjectSettings.tsx の ServersSection）の
// 行表示ロジックを純粋関数として切り出したもの。コンポーネント本体は React Testing
// Library を使わない現状のテスト構成（vitest environment: 'node'、*.test.ts のみ）の
// ため、jsdom なしでユニットテストできるようここへ抽出している。

/** GET /api/projects/:id/servers が各行に返す配信前提チェックの失敗ステージ（server: modules/projects/routes.ts の ProjectServerDistributionInfo）。 */
export type DistributionPrerequisiteStage =
  | 'service_not_wired'
  | 'no_working_dir'
  | 'no_distribution_repository'
  | 'distribution_repository_not_found'
  | 'no_token'
  | 'credential_unreadable'
  | 'identity_unresolvable';

/**
 * 配信でどの資格情報を使うか（server: ProjectServerDistributionInfo）。
 *
 * - `repository`: プロジェクトに保存された PAT。暗号化して記録された明示的な付与。
 * - `cli`: ハブの `gh` / `glab` のログイン。操作者の環境依存なので、ハブで
 *   `gh auth logout` すると設定を変えていなくても配信が落ちる。
 */
export type DistributionCredentialSource = 'repository' | 'cli';

export interface DistributionPrerequisite {
  status: 'not_required' | 'ok' | 'failed' | 'unknown';
  /** `status: 'failed'` のときのみ非 null。 */
  stage: DistributionPrerequisiteStage | null;
  /** `status: 'ok'` のときのみ非 null。 */
  credentialSource: DistributionCredentialSource | null;
}

export interface LastDistribution {
  distributedAt: string;
  bundleType: 'full' | 'incremental';
  lastDistributedSha: string;
}

export type EnvironmentChipId = 'distribution' | 'credentialSource' | 'isolated' | 'branch' | 'inputPolicy';

export interface EnvironmentChip {
  /** React key / テストの識別子。 */
  id: EnvironmentChipId;
  tone: ChipTone;
  /** projects 名前空間の i18n キー。stage 識別子そのものは画面に出さない。 */
  labelKey: string;
  /** labelKey に渡す補間値のうち、そのまま文字列として渡せるもの。 */
  params?: Record<string, string>;
  /**
   * 配信チップの `{{bundle}}`（全体/差分）に埋める語の i18n キー。呼び出し側が
   * 先に翻訳してから labelKey の補間値に渡す（i18n キーを純粋関数の外で解決する
   * ため、ここでは値ではなくキーを返す）。
   */
  bundleKey?: string;
  /** 配信チップの `{{time}}` に埋める相対時刻の元になる ISO 風文字列。 */
  distributedAt?: string;
  /**
   * チップの語だけでは伝えきれない背景を補う説明文の i18n キー（title 属性）。
   * チップ本体の語は単独で意味が通るものにし、これは補足に留める。
   */
  detailKey?: string;
}

const FAILED_STAGE_LABEL_KEYS: Record<DistributionPrerequisiteStage, string> = {
  service_not_wired: 'settings.servers.distribution.failed.serviceNotWired',
  no_working_dir: 'settings.servers.distribution.failed.noWorkingDir',
  no_distribution_repository: 'settings.servers.distribution.failed.noDistributionRepository',
  distribution_repository_not_found: 'settings.servers.distribution.failed.distributionRepositoryNotFound',
  no_token: 'settings.servers.distribution.failed.noToken',
  credential_unreadable: 'settings.servers.distribution.failed.credentialUnreadable',
  identity_unresolvable: 'settings.servers.distribution.failed.identityUnresolvable',
};

/**
 * 配信状態チップの記述子。`not_required`（このサーバーへは配信しない）は
 * チップを出さないので `null` を返す。
 *
 * 色だけに意味を持たせないため、どの状態も必ず語（labelKey）を伴う。
 */
export function resolveDistributionChip(
  prerequisite: DistributionPrerequisite | undefined,
  lastDistribution: LastDistribution | null | undefined,
): EnvironmentChip | null {
  if (!prerequisite) return null;
  switch (prerequisite.status) {
    case 'not_required':
      return null;
    case 'unknown':
      return { id: 'distribution', tone: 'default', labelKey: 'settings.servers.distribution.unknown' };
    case 'failed':
      return {
        id: 'distribution',
        tone: 'red',
        // stage が null の failed は API 契約上ありえないが、型上は表現できる。
        // 「配信できません」という一段抽象度の高い語に落として、失敗そのものは
        // 必ず danger として伝える（無害な状態に化けさせない）。
        labelKey: prerequisite.stage
          ? FAILED_STAGE_LABEL_KEYS[prerequisite.stage]
          : 'settings.servers.distribution.failedGeneric',
      };
    case 'ok':
      if (!lastDistribution) {
        // 前提は満たしているがまだ一度も配信していない。エラーではないが
        // 「このサーバーにはまだコードが届いていない」という運用上の未完了
        // 状態なので、中立ではなく warning で出す。
        return { id: 'distribution', tone: 'orange', labelKey: 'settings.servers.distribution.notDistributed' };
      }
      return {
        id: 'distribution',
        tone: 'green',
        labelKey: 'settings.servers.distribution.distributed',
        distributedAt: lastDistribution.distributedAt,
        bundleKey: lastDistribution.bundleType === 'full'
          ? 'settings.servers.distribution.bundleFull'
          : 'settings.servers.distribution.bundleIncremental',
      };
  }
}

/**
 * 配信に使う資格情報の出所チップ。ハブの CLI ログイン（`cli`）のときだけ出す。
 *
 * `repository`（プロジェクトに保存した PAT）は配信の既定の姿なので、チップを
 * 増やしても雑音にしかならない。一方 `cli` は操作者の環境に依存していて、ハブで
 * `gh auth logout` すればこの環境の設定を変えなくても配信が落ちる — 行から
 * 読み取れないと原因を追えない差なので、こちらだけ明示する。
 *
 * 状態としては正常（`status: 'ok'`）なので色で警告はせず、語で伝える。
 */
export function resolveCredentialSourceChip(
  prerequisite: DistributionPrerequisite | undefined,
): EnvironmentChip | null {
  if (prerequisite?.status !== 'ok') return null;
  if (prerequisite.credentialSource !== 'cli') return null;
  return {
    id: 'credentialSource',
    tone: 'default',
    labelKey: 'settings.servers.distribution.credentialSourceCli',
    detailKey: 'settings.servers.distribution.credentialSourceCliDetail',
  };
}

/** 配信前提が失敗しているとき、行に「設定する」導線（編集モーダルを開く）を出すか。 */
export function needsDistributionSetup(prerequisite: DistributionPrerequisite | undefined): boolean {
  return prerequisite?.status === 'failed';
}

export interface EnvironmentRowInput {
  branch?: string;
  inputPolicy?: 'deny' | 'manual-approval' | 'allow';
  /** サーバー側の隔離宣言（servers.isolationIntent）。 */
  isolated: boolean;
  distributionPrerequisite?: DistributionPrerequisite;
  lastDistribution?: LastDistribution | null;
}

const INPUT_POLICY_LABEL_KEYS = {
  deny: 'settings.servers.inputPolicyDeny',
  allow: 'settings.servers.inputPolicyAllow',
  'manual-approval': 'settings.servers.inputPolicyManualApproval',
} as const;

/**
 * 一覧行に並べるチップを「緊急 → 文脈 → 詳細」の順で返す。
 *
 * 順序は 配信状態 → 資格情報の出所 → 隔離 → ブランチ → 入力ポリシー で固定。tmux セッションは
 * 行から降ろしてある（編集モーダルでのみ扱う）ため、ここでは一切扱わない。
 */
export function buildEnvironmentRowChips(input: EnvironmentRowInput): EnvironmentChip[] {
  const chips: EnvironmentChip[] = [];

  const distribution = resolveDistributionChip(input.distributionPrerequisite, input.lastDistribution);
  if (distribution) chips.push(distribution);

  const credentialSource = resolveCredentialSourceChip(input.distributionPrerequisite);
  if (credentialSource) chips.push(credentialSource);

  if (input.isolated) {
    chips.push({ id: 'isolated', tone: 'purple', labelKey: 'settings.servers.isolatedChip' });
  }

  if (input.branch) {
    chips.push({ id: 'branch', tone: 'default', labelKey: 'settings.servers.branchChip', params: { name: input.branch } });
  }

  // 'allow'（承認なしで自動実行）だけが注意を要する設定。deny / manual-approval は
  // 既定寄りの安全側なので中立色で出す。
  const policy = input.inputPolicy === 'deny' || input.inputPolicy === 'allow' ? input.inputPolicy : 'manual-approval';
  chips.push({
    id: 'inputPolicy',
    tone: policy === 'allow' ? 'orange' : 'default',
    labelKey: INPUT_POLICY_LABEL_KEYS[policy],
  });

  return chips;
}
