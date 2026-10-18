import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { SecretFileGuard, SecretFileInspection, SecretPathKind } from './secretFileGuardTypes';

/** ACL の 1 エントリ（IdentityReference は SID に解決した値）。sid が空なら解決できなかった主体。 */
export interface AclEntry {
  sid: string;
  name: string;
  type: 'Allow' | 'Deny';
  inherited: boolean;
}

export interface AclSnapshot {
  currentSid: string;
  /** 所有者の SID（所有者は暗黙に DACL を書き換えられるので、現在のユーザーでなければ違反）。 */
  ownerSid: string;
  entries: AclEntry[];
}

/** PowerShell を 1 回実行して stdout を返す。path は環境変数 AZITO_GUARD_PATH で渡す（スクリプトに埋め込まない）。 */
export type PowerShellRunner = (script: string, targetPath: string) => string;

// Get-Acl / Set-Acl は Microsoft.PowerShell.Security の自動読み込みに依存し、PSModulePath が PowerShell 7 のものだと失敗する。
// FileInfo / DirectoryInfo の GetAccessControl / SetAccessControl（.NET）なら、モジュール無しで DACL と所有者を読み書きできる。
const OPEN_INFO = '$isDir=[System.IO.Directory]::Exists($p); if($isDir){$info=New-Object System.IO.DirectoryInfo $p}else{$info=New-Object System.IO.FileInfo $p}; ';
const ACL_SECTIONS = "[System.Security.AccessControl.AccessControlSections]'Access,Owner'";

const PS_PREAMBLE = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $p=$env:AZITO_GUARD_PATH; " +
  '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ';

/** 継承を切った DACL に、現在のユーザーの FullControl だけを入れ、所有者も現在のユーザーにする（$inh を先に決めておく）。 */
const BUILD_RULE =
  '$acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($sid); ' +
  "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]'FullControl',$inh,[System.Security.AccessControl.PropagationFlags]'None',[System.Security.AccessControl.AccessControlType]'Allow'); " +
  '$acl.AddAccessRule($rule); ';

/**
 * 既存のファイル / ディレクトリを、所有者と DACL を現在のユーザーだけにして置き換える。ディレクトリは子へ継承させる。
 * 読み出した明示的な許可（他のユーザーのもの）は PurgeAccessRules で全部除く
 * （`icacls /inheritance:r /grant:r` だけでは他の主体の明示的な許可が残る）。所有者を変えられなければ失敗する。
 */
const PROTECT_SCRIPT = PS_PREAMBLE + OPEN_INFO +
  `$acl=$info.GetAccessControl(${ACL_SECTIONS}); ` +
  'foreach($r in @($acl.Access)){ $acl.PurgeAccessRules($r.IdentityReference) }; ' +
  "if($isDir){$inh=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{$inh=[System.Security.AccessControl.InheritanceFlags]'None'}; " +
  BUILD_RULE +
  '$info.SetAccessControl($acl)';

/**
 * 空のファイルを、作成の時点から保護 DACL と所有者を付けて排他作成する（CreateNew）。
 * 親の ACL のまま作ってから保護すると、その間に開かれたハンドルから秘密が読めてしまう。
 */
const CREATE_SCRIPT = PS_PREAMBLE +
  '$acl=New-Object System.Security.AccessControl.FileSecurity; ' +
  "$inh=[System.Security.AccessControl.InheritanceFlags]'None'; " +
  BUILD_RULE +
  "$stream=New-Object System.IO.FileStream($p,[System.IO.FileMode]'CreateNew',[System.Security.AccessControl.FileSystemRights]'FullControl',[System.IO.FileShare]'None',4096,[System.IO.FileOptions]'None',$acl); " +
  '$stream.Dispose()';

/** 全エントリを SID に解決して JSON で返す（表示名はロケールで変わるので、判定は SID だけで行う）。 */
const INSPECT_SCRIPT = PS_PREAMBLE + OPEN_INFO +
  `$acl=$info.GetAccessControl(${ACL_SECTIONS}); ` +
  '$entries=@($acl.Access | ForEach-Object { ' +
  "$s=''; try { $s=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}; " +
  '[pscustomobject]@{ sid=$s; name=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); inherited=[bool]$_.IsInherited } }); ' +
  "$owner=''; try { $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value } catch {}; " +
  '[pscustomobject]@{ currentSid=$sid.Value; ownerSid=$owner; entries=$entries } | ConvertTo-Json -Depth 4 -Compress';

/** 親が PowerShell 7 のとき PSModulePath が 5.1 に合わない値になるので、渡さず 5.1 の既定に任せる。 */
function powerShellEnv(targetPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AZITO_GUARD_PATH: targetPath };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  return env;
}

/** PATH 探索に頼らないよう、境界で解決した powershell.exe の絶対パスを使う。 */
export function createPowerShellRunner(powershellPath: string): PowerShellRunner {
  return (script, targetPath) => {
    try {
      return execFileSync(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: powerShellEnv(targetPath),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      throw new Error(`Failed to restrict access to ${targetPath} (${powershellPath}): ${stderr || (err as Error).message}`);
    }
  };
}

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。SystemRoot が無ければ投げる。env は境界から渡す。 */
export function resolveWindowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot) throw new Error('Cannot locate powershell.exe: the SystemRoot environment variable is not set');
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function parseAclSnapshot(json: string): AclSnapshot {
  const raw = JSON.parse(json) as { currentSid?: unknown; ownerSid?: unknown; entries?: unknown };
  if (typeof raw.currentSid !== 'string' || raw.currentSid === '') {
    throw new Error('ACL snapshot has no current user SID');
  }
  // ConvertTo-Json は要素が 1 つの配列を配列にしない版がある
  const list = raw.entries == null ? [] : Array.isArray(raw.entries) ? raw.entries : [raw.entries];
  const entries = list.map((e: { sid?: unknown; name?: unknown; type?: unknown; inherited?: unknown }): AclEntry => ({
    sid: typeof e.sid === 'string' ? e.sid : '',
    name: typeof e.name === 'string' ? e.name : '',
    type: e.type === 'Deny' ? 'Deny' : 'Allow',
    inherited: e.inherited === true,
  }));
  return { currentSid: raw.currentSid, ownerSid: typeof raw.ownerSid === 'string' ? raw.ownerSid : '', entries };
}

/**
 * 方針: 所有者が現在のユーザーで、現在のユーザー以外の許可エントリ（継承されたものも含む）が無く、現在のユーザーの許可があること。
 * SYSTEM / Administrators も許可しない（管理者は所有権の取得で読めるが、ACL 上は許可を持たせない）。拒否エントリは見ない。
 */
export function evaluateAcl(snapshot: AclSnapshot, targetPath: string, kind: SecretPathKind): SecretFileInspection {
  const allows = snapshot.entries.filter((e) => e.type === 'Allow');
  const others = allows.filter((e) => e.sid !== snapshot.currentSid);
  const hasCurrent = allows.some((e) => e.sid === snapshot.currentSid);
  const ownedByCurrent = snapshot.ownerSid === snapshot.currentSid;
  if (others.length === 0 && hasCurrent && ownedByCurrent) return { ok: true };

  const parts: string[] = [];
  if (others.length > 0) {
    parts.push(`現在のユーザー以外に許可が付いています: ${others.map((e) => e.name || e.sid || '(解決できない主体)').join(', ')}`);
  }
  if (!hasCurrent) parts.push('現在のユーザーの許可がありません');
  if (!ownedByCurrent) parts.push(`所有者が現在のユーザーではありません（${snapshot.ownerSid || '解決できない主体'}）`);

  const grant = kind === 'dir' ? `*${snapshot.currentSid}:(OI)(CI)F` : `*${snapshot.currentSid}:F`;
  const removals = others.filter((e) => e.sid !== '').map((e) => `/remove:g *${e.sid}`);
  const setOwner = ownedByCurrent ? [] : [`/setowner *${snapshot.currentSid}`];
  const fix = ['icacls', `"${targetPath}"`, '/inheritance:r', ...setOwner, ...removals, '/grant:r', `"${grant}"`].join(' ');
  return { ok: false, summary: `${parts.join('。')}。`, fix };
}

const RENAME_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
const RENAME_RETRY_DELAY_MS = 50;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface WindowsSecretFileGuardOptions {
  /** 境界で解決した powershell.exe の絶対パス。 */
  powershellPath: string;
  /** テスト用: PowerShell の実行を差し替える。 */
  run?: PowerShellRunner;
  /** テスト用: rename を差し替える。 */
  rename?: (from: string, to: string) => void;
  /** テスト用: 再試行の待ち（ミリ秒）を差し替える。 */
  sleep?: (ms: number) => void;
}

/**
 * 現在のユーザーの SID だけを許可し、所有者も現在のユーザーにした保護 DACL（継承なし）。
 * OS 標準の powershell.exe を引数配列で実行する（シェル文字列は組まない）。
 * 保護してから公開する: 同じディレクトリに、作成の時点から保護された空の一時ファイルを排他作成 → 中身を書く → rename で置き換える。
 */
export class WindowsSecretFileGuard implements SecretFileGuard {
  readonly policyDescription = 'アクセス権が現在のユーザーのみ';

  private readonly run: PowerShellRunner;
  private readonly rename: (from: string, to: string) => void;
  private readonly sleep: (ms: number) => void;
  /** このプロセスで保護済みのパス。追記や修復のたびに PowerShell を起動しないための記録。 */
  private readonly protectedPaths = new Set<string>();

  constructor(options: WindowsSecretFileGuardOptions) {
    this.run = options.run ?? createPowerShellRunner(options.powershellPath);
    this.rename = options.rename ?? fs.renameSync;
    this.sleep = options.sleep ?? sleepSync;
  }

  ensureProtectedDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    this.protect(dir);
  }

  writeSecretFile(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    this.ensureParent(dir);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      this.createProtected(tmp);
      fs.writeFileSync(tmp, content);
      this.renameWithRetry(tmp, filePath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    this.protectedPaths.add(filePath);
  }

  appendSecretFile(filePath: string, content: string): void {
    this.ensureParent(path.dirname(filePath));
    if (!this.protectedPaths.has(filePath)) {
      if (fs.existsSync(filePath)) this.protect(filePath);
      else this.createProtected(filePath);
    }
    fs.appendFileSync(filePath, content);
  }

  protectFile(filePath: string): void {
    this.protect(filePath);
  }

  repairFile(filePath: string): void {
    if (this.protectedPaths.has(filePath) || !fs.existsSync(filePath)) return;
    this.protect(filePath);
  }

  prepareFile(filePath: string): void {
    if (fs.existsSync(filePath)) this.protect(filePath);
    else this.createProtected(filePath);
  }

  inspect(targetPath: string, kind: SecretPathKind): SecretFileInspection {
    return evaluateAcl(parseAclSnapshot(this.run(INSPECT_SCRIPT, targetPath)), targetPath, kind);
  }

  /** 親が無ければ作り、そのとき作ったディレクトリは保護する（既存の親は呼び出し側の責務で、触らない）。 */
  private ensureParent(dir: string): void {
    const created = fs.mkdirSync(dir, { recursive: true });
    if (created !== undefined) this.protect(dir);
  }

  private protect(targetPath: string): void {
    this.run(PROTECT_SCRIPT, targetPath);
    this.protectedPaths.add(targetPath);
  }

  private createProtected(targetPath: string): void {
    this.run(CREATE_SCRIPT, targetPath);
    this.protectedPaths.add(targetPath);
  }

  /** ウイルス対策ソフトや読み取り中のプロセスが一瞬ファイルを掴んでいると rename が失敗するので、短く数回やり直す。 */
  private renameWithRetry(from: string, to: string): void {
    for (let attempt = 1; ; attempt++) {
      try {
        this.rename(from, to);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= RENAME_ATTEMPTS || code === undefined || !RENAME_RETRYABLE.has(code)) throw err;
        this.sleep(RENAME_RETRY_DELAY_MS);
      }
    }
  }
}

export function createWindowsSecretFileGuard(env: NodeJS.ProcessEnv): SecretFileGuard {
  return new WindowsSecretFileGuard({ powershellPath: resolveWindowsPowerShellPath(env) });
}
