import * as fs from 'fs';
import * as path from 'path';
import {
  isValidSidekickName,
  isValidSidekickTag,
  legacyPhaseFieldToTags,
  SIDEKICK_NAME_PATTERN,
  type SidekickMeta,
  type SidekickPackage,
} from './SidekickPackage';
import { isPhaseTag } from './TaskPhase';
import type { SidekickPackageLoader } from './SidekickPackageLoader';

export interface SidekickScriptInput {
  filename: string;
  content: string;
}

export interface CreateSidekickInput {
  name: string;
  description: string;
  /** 自由語彙のタグ。省略時は `phase`（後方互換）で解決し、それも無ければ tags: []。 */
  tags?: string[];
  /** @deprecated 後方互換: tags 省略時のみ使用され、内部で tags へ正規化される。 */
  phase?: string;
  isDefault?: boolean;
  body?: string;
  scripts?: SidekickScriptInput[];
}

export interface UpdateSidekickInput {
  description?: string;
  /** 自由語彙のタグ。省略時は既存値を保持する（`phase` 指定時はそちらを優先して正規化）。 */
  tags?: string[];
  /** @deprecated 後方互換: tags 省略時のみ使用され、内部で tags へ正規化される。 */
  phase?: string;
  isDefault?: boolean;
  body?: string;
  scripts?: SidekickScriptInput[];
}

const SCRIPT_FILENAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

function assertValidName(name: string): void {
  if (!isValidSidekickName(name)) {
    throw new Error(`Invalid sidekick name "${name}" (must match ${SIDEKICK_NAME_PATTERN})`);
  }
}

function assertValidTags(tags: string[]): void {
  for (const tag of tags) {
    if (!isValidSidekickTag(tag)) {
      throw new Error(`Invalid tag "${tag}" (must match ${SIDEKICK_NAME_PATTERN})`);
    }
  }
}

/**
 * `tags` と後方互換の `phase` から実際に採用するタグ配列を解決する。`tags` が優先。
 * どちらも未指定なら undefined を返す（create では [] にフォールバック、update では既存値を保持する）。
 */
function resolveTagsInput(input: { tags?: string[]; phase?: string }): string[] | undefined {
  if (input.tags !== undefined) {
    assertValidTags(input.tags);
    return input.tags;
  }
  if (input.phase !== undefined) {
    return legacyPhaseFieldToTags(input.phase); // 不正な値は例外を投げる
  }
  return undefined;
}

/** isDefault: true は phase タグ（planning/implementing/reviewing/testing/pushing のいずれか）を最低1つ要求する。 */
function assertDefaultHasPhaseTag(isDefault: boolean, tags: string[]): void {
  if (isDefault && !tags.some((tag) => isPhaseTag(tag))) {
    throw new Error('isDefault: true requires at least one phase tag (planning/implementing/reviewing/testing/pushing)');
  }
}

function assertValidScripts(scripts: SidekickScriptInput[] | undefined): void {
  for (const script of scripts ?? []) {
    if (!SCRIPT_FILENAME_PATTERN.test(script.filename)) {
      throw new Error(`Invalid script filename "${script.filename}" (must match ${SCRIPT_FILENAME_PATTERN})`);
    }
  }
}

/**
 * scripts 書き込み対象の symlink 拒否（多層防御）。既存パッケージ内の `scripts/` や
 * `scripts/<filename>` が symlink の場合、writeFileSync/chmodSync がリンク先を辿って
 * パッケージ外を書き換える経路になるため、書き込み前に lstat で検証する
 * （cpSync は symlink を symlink のままコピーするので、tmp コピー上の検証で元の symlink も捕捉できる）。
 * 存在しない場合は新規作成なので安全。存在する場合は期待する種別（dir / regular file）のみ許可。
 */
function assertSafeScriptWriteTarget(p: string, label: string, expect: 'directory' | 'file'): void {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(p);
  } catch {
    return; // 未作成: これから作る分には安全
  }
  if (lst.isSymbolicLink()) {
    throw new Error(`Refusing to write scripts: "${label}" is a symlink`);
  }
  if (expect === 'directory' ? !lst.isDirectory() : !lst.isFile()) {
    throw new Error(`Refusing to write scripts: "${label}" is not a ${expect === 'directory' ? 'directory' : 'regular file'}`);
  }
}

/** scripts 入力を対象ディレクトリ配下へ検証付きで書き込む（0o755 付与）。 */
function writeScripts(pkgDir: string, name: string, scripts: SidekickScriptInput[]): void {
  const scriptsDir = path.join(pkgDir, 'scripts');
  assertSafeScriptWriteTarget(scriptsDir, `${name}/scripts`, 'directory');
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const script of scripts) {
    const scriptPath = path.join(scriptsDir, script.filename);
    assertSafeScriptWriteTarget(scriptPath, `${name}/scripts/${script.filename}`, 'file');
    fs.writeFileSync(scriptPath, script.content, 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
  }
}

function buildSkillMdContent(
  fm: { name: string; description: string; tags: string[]; isDefault: boolean },
  body: string,
): string {
  return `---
name: ${fm.name}
description: ${fm.description}
tags: ${fm.tags.join(', ')}
isDefault: ${fm.isDefault}
---
${body}`;
}

/**
 * Sidekick パッケージの CRUD をファイル操作として実装するサービス。
 * routes.ts はこのサービスを呼ぶだけに留め、ビジネスロジック（copy-on-write・
 * バリデーション・層の制約・symlink 拒否）はここに集約する。
 */
export class SidekickPackageService {
  constructor(
    private readonly loader: SidekickPackageLoader,
    private readonly userDir: string,
  ) {}

  list(): SidekickMeta[] {
    return this.loader.list().map(({ body: _body, ...meta }) => meta);
  }

  getDetail(name: string): SidekickPackage | null {
    return this.loader.findByName(name);
  }

  /**
   * ユーザー層に新規パッケージを scaffold する。
   * 原子性: 全入力を先に検証し、userDir 内の一時ディレクトリに組み立ててから
   * rename する（途中失敗で中途半端なパッケージが残らない）。
   */
  create(input: CreateSidekickInput): void {
    // ─── 1. 全入力検証（書き込みより前に完了させる） ───
    assertValidName(input.name);
    const tags = resolveTagsInput(input) ?? [];
    const isDefault = input.isDefault ?? false;
    assertDefaultHasPhaseTag(isDefault, tags);
    assertValidScripts(input.scripts);
    if (this.loader.findByName(input.name)) {
      throw new Error(`Sidekick "${input.name}" already exists`);
    }

    const pkgDir = this.resolveUserPackageDir(input.name);

    // ─── 2. 一時ディレクトリに組み立て → rename（同一 FS 内なので原子的） ───
    fs.mkdirSync(this.userDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(this.userDir, `.tmp-${input.name}-`));
    try {
      const content = buildSkillMdContent(
        { name: input.name, description: input.description, tags, isDefault },
        input.body ?? `# ${input.name}\n\n(このパッケージの内容を記述してください)\n`,
      );
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), content, 'utf-8');

      if (input.scripts && input.scripts.length > 0) {
        writeScripts(tmpDir, input.name, input.scripts);
      }

      fs.renameSync(tmpDir, pkgDir);
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }

    this.loader.invalidateCache();
  }

  /**
   * ユーザー層の SKILL.md（および scripts/ の追加・更新）を反映する。対象がビルトインのみの
   * 場合は copy-on-write（パッケージ一式をユーザー層へコピーしてから変更）になる。
   * scripts は upsert のみ（既存ファイルの削除は行わない）。
   *
   * 原子性: create と同じく、更新後のパッケージ全体を userDir 内の一時ディレクトリに
   * 組み立ててから rename で差し替える。rename 直前まで既存パッケージには一切触れないため、
   * 途中失敗（symlink 拒否・書き込みエラー等）で中途半端な状態が残らない。
   */
  update(name: string, input: UpdateSidekickInput): void {
    // ─── 1. 全入力検証（書き込みより前に完了させる） ───
    assertValidName(name);
    const tagsInput = resolveTagsInput(input); // undefined = 変更なし（既存値を保持）
    assertValidScripts(input.scripts);
    const existing = this.loader.findByName(name);
    if (!existing) {
      throw new Error(`Sidekick "${name}" not found`);
    }

    const tags = tagsInput ?? existing.tags;
    const isDefault = input.isDefault ?? existing.isDefault;
    assertDefaultHasPhaseTag(isDefault, tags);

    const pkgDir = this.resolveUserPackageDir(name);

    // ─── 2. 一時ディレクトリに更新後のパッケージ全体を組み立てる ───
    fs.mkdirSync(this.userDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(this.userDir, `.tmp-${name}-`));
    try {
      // 既存パッケージ一式（scripts/ references/ 含む）をコピー。ビルトインの場合は
      // これがそのまま copy-on-write の実体になる。
      fs.cpSync(existing.dir, tmpDir, { recursive: true });

      const merged = {
        name,
        description: input.description ?? existing.description,
        tags,
        isDefault,
      };
      const body = input.body ?? existing.body;
      fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), buildSkillMdContent(merged, body), 'utf-8');

      if (input.scripts && input.scripts.length > 0) {
        // cpSync は symlink を symlink のままコピーするので、tmp 上の検証で
        // 元パッケージ内の symlink 経由書き込みも書き込み前に拒否できる。
        writeScripts(tmpDir, name, input.scripts);
      }

      // ─── 3. rename で差し替え（ここまで既存パッケージには触れていない） ───
      this.replacePackageDir(tmpDir, pkgDir);
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }

    this.loader.invalidateCache();
  }

  /**
   * 組み立て済みの tmpDir で pkgDir を差し替える。既存の pkgDir がある場合は
   * いったん退避 → rename → 退避分を削除。2段目の rename が失敗した場合は退避分を
   * 戻して元の状態を復元する（pkgDir が消えたままにならない）。
   */
  private replacePackageDir(tmpDir: string, pkgDir: string): void {
    if (!fs.existsSync(pkgDir)) {
      fs.renameSync(tmpDir, pkgDir); // builtin-only の copy-on-write: 新規配置
      return;
    }
    const backupDir = `${tmpDir}-old`;
    fs.renameSync(pkgDir, backupDir);
    try {
      fs.renameSync(tmpDir, pkgDir);
    } catch (err) {
      fs.renameSync(backupDir, pkgDir); // 復元
      throw err;
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
  }

  /** ユーザー層のみ削除可能（= ビルトインへの revert、またはユーザー専用パッケージの完全削除）。 */
  remove(name: string): void {
    assertValidName(name);
    const existing = this.loader.findByName(name);
    if (!existing) {
      throw new Error(`Sidekick "${name}" not found`);
    }
    if (existing.layer === 'builtin') {
      throw new Error(`Cannot delete "${name}": it only exists in the builtin layer (no user override to remove)`);
    }
    fs.rmSync(this.resolveUserPackageDir(name), { recursive: true, force: true });
    this.loader.invalidateCache();
  }

  /**
   * `<userDir>/<name>` を操作対象として解決する。symlink 経由で userDir 外を
   * 操作されるのを防ぐため、パス自体が symlink の場合は拒否し、実在する場合は
   * realpath が userDir の realpath 配下にあることを確認する。
   * （name は正規表現検証済みなので `..` は含まれ得ないが、多層防御として検証する）
   */
  private resolveUserPackageDir(name: string): string {
    const pkgDir = path.join(this.userDir, name);

    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(pkgDir);
    } catch {
      return pkgDir; // 未作成: これから作る分には安全
    }

    if (lst.isSymbolicLink()) {
      throw new Error(`Refusing to operate on "${name}": ${pkgDir} is a symlink`);
    }

    const realPkg = fs.realpathSync(pkgDir);
    const realUserDir = fs.realpathSync(this.userDir);
    if (realPkg !== path.join(realUserDir, name)) {
      throw new Error(`Refusing to operate on "${name}": resolved path escapes the user sidekicks directory`);
    }
    return pkgDir;
  }
}
