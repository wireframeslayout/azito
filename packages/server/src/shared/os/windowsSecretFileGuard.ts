import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { SecretFileGuard, SecretFileInspection, SecretPathKind } from './secretFileGuardTypes';

/** Get-Acl の 1 エントリ（IdentityReference は SID に解決した値）。sid が空なら解決できなかった主体。 */
export interface AclEntry {
  sid: string;
  name: string;
  type: 'Allow' | 'Deny';
  inherited: boolean;
}

export interface AclSnapshot {
  currentSid: string;
  entries: AclEntry[];
}

/** PowerShell を 1 回実行して stdout を返す。path は環境変数 AZITO_GUARD_PATH で渡す（スクリプトに埋め込まない）。 */
export type PowerShellRunner = (script: string, targetPath: string) => string;

// Get-Acl / Set-Acl は Microsoft.PowerShell.Security の自動読み込みに依存し、PSModulePath が PowerShell 7 のものだと失敗する。
// FileInfo / DirectoryInfo の GetAccessControl / SetAccessControl（.NET）なら、モジュール無しで DACL だけを読み書きできる。
const OPEN_INFO = 'if($isDir){$info=New-Object System.IO.DirectoryInfo $p}else{$info=New-Object System.IO.FileInfo $p};';

const PS_PREAMBLE = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $p=$env:AZITO_GUARD_PATH; ";

/**
 * 継承を切った（保護）DACL に、現在のユーザーの FullControl だけを入れて丸ごと置き換える。
 * 読み出した DACL の明示的な許可（他のユーザーのもの）は PurgeAccessRules で全部除いてから足す
 * （`icacls /inheritance:r /grant:r` だけでは他の主体の明示的な許可が残る）。ディレクトリには子へ継承させる。
 */
const PROTECT_SCRIPT = PS_PREAMBLE +
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
  '$isDir=[System.IO.Directory]::Exists($p); ' +
  `${OPEN_INFO} ` +
  "$acl=$info.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access'); " +
  '$acl.SetAccessRuleProtection($true,$false); ' +
  'foreach($r in @($acl.Access)){ $acl.PurgeAccessRules($r.IdentityReference) }; ' +
  "if($isDir){$inh=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{$inh=[System.Security.AccessControl.InheritanceFlags]'None'}; " +
  "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]'FullControl',$inh,[System.Security.AccessControl.PropagationFlags]'None',[System.Security.AccessControl.AccessControlType]'Allow'); " +
  '$acl.AddAccessRule($rule); ' +
  '$info.SetAccessControl($acl)';

/** 全エントリを SID に解決して JSON で返す（表示名はロケールで変わるので、判定は SID だけで行う）。 */
const INSPECT_SCRIPT = PS_PREAMBLE +
  '$isDir=[System.IO.Directory]::Exists($p); ' +
  `${OPEN_INFO} ` +
  "$acl=$info.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access'); " +
  '$entries=@($acl.Access | ForEach-Object { ' +
  "$s=''; try { $s=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}; " +
  '[pscustomobject]@{ sid=$s; name=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); inherited=[bool]$_.IsInherited } }); ' +
  '[pscustomobject]@{ currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; entries=$entries } | ConvertTo-Json -Depth 4 -Compress';

/** 親が PowerShell 7 のとき PSModulePath が 5.1 に合わない値になるので、渡さず 5.1 の既定に任せる。 */
function powerShellEnv(targetPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AZITO_GUARD_PATH: targetPath };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  return env;
}

function runPowerShell(script: string, targetPath: string): string {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: powerShellEnv(targetPath),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`Failed to restrict access to ${targetPath} (powershell.exe): ${stderr || (err as Error).message}`);
  }
}

export function parseAclSnapshot(json: string): AclSnapshot {
  const raw = JSON.parse(json) as { currentSid?: unknown; entries?: unknown };
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
  return { currentSid: raw.currentSid, entries };
}

/**
 * 方針: 現在のユーザー以外の許可エントリ（継承されたものも含む）が無く、現在のユーザーの許可があること。
 * SYSTEM / Administrators も許可しない（管理者は所有権の取得で読めるが、ACL 上は許可を持たせない）。拒否エントリは見ない。
 */
export function evaluateAcl(snapshot: AclSnapshot, targetPath: string, kind: SecretPathKind): SecretFileInspection {
  const allows = snapshot.entries.filter((e) => e.type === 'Allow');
  const others = allows.filter((e) => e.sid !== snapshot.currentSid);
  const hasCurrent = allows.some((e) => e.sid === snapshot.currentSid);
  if (others.length === 0 && hasCurrent) return { ok: true };

  const parts: string[] = [];
  if (others.length > 0) {
    parts.push(`現在のユーザー以外に許可が付いています: ${others.map((e) => e.name || e.sid || '(解決できない主体)').join(', ')}`);
  }
  if (!hasCurrent) parts.push('現在のユーザーの許可がありません');

  const grant = kind === 'dir' ? `*${snapshot.currentSid}:(OI)(CI)F` : `*${snapshot.currentSid}:F`;
  const removals = others.filter((e) => e.sid !== '').map((e) => `/remove:g *${e.sid}`);
  const fix = ['icacls', `"${targetPath}"`, '/inheritance:r', ...removals, '/grant:r', `"${grant}"`].join(' ');
  return { ok: false, summary: `${parts.join('。')}。`, fix };
}

/**
 * 現在のユーザーの SID だけを許可する保護 DACL（継承なし）。OS 標準の powershell.exe を引数配列で実行する（シェル文字列は組まない）。
 * 保護してから公開する: 同じディレクトリに空の一時ファイルを排他作成 → 保護 → 中身を書く → rename で置き換える。
 */
export class WindowsSecretFileGuard implements SecretFileGuard {
  readonly policyDescription = 'アクセス権が現在のユーザーのみ';

  constructor(private readonly run: PowerShellRunner = runPowerShell) {}

  ensureProtectedDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    this.protect(dir);
  }

  writeSecretFile(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    this.ensureParent(dir);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    fs.closeSync(fs.openSync(tmp, 'wx'));
    try {
      this.protect(tmp);
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, filePath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  appendSecretFile(filePath: string, content: string): void {
    this.ensureParent(path.dirname(filePath));
    try {
      fs.closeSync(fs.openSync(filePath, 'wx'));
      this.protect(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        fs.rmSync(filePath, { force: true });
        throw err;
      }
    }
    fs.appendFileSync(filePath, content);
  }

  protectFile(filePath: string): void {
    this.protect(filePath);
  }

  repairFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    this.protect(filePath);
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
  }
}

export function createWindowsSecretFileGuard(): SecretFileGuard {
  return new WindowsSecretFileGuard();
}
