import fs from 'fs';
import path from 'path';
import { createWindowsSecretFileGuard } from './windowsSecretFileGuard';
import type { SecretFileGuard, SecretFileInspection, SecretPathKind } from './secretFileGuardTypes';

export type { SecretFileGuard, SecretFileInspection, SecretPathKind } from './secretFileGuardTypes';

/** mode 600（ファイル）/ 700（ディレクトリ）。従来の挙動そのまま。 */
export class UnixSecretFileGuard implements SecretFileGuard {
  readonly policyDescription = 'パーミッションが 0600';

  ensureProtectedDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 他人所有のディレクトリ（共有の AZITO_DATA_DIR など）でも起動は止めない。緩さは inspect が報告する。
    try { fs.chmodSync(dir, 0o700); } catch {}
  }

  writeSecretFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    // mode は新規作成のときだけ効く。既存の緩いファイルは、中身を書く前に締める。
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
    fs.writeFileSync(filePath, content, { mode: 0o600 });
  }

  appendSecretFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, content, { mode: 0o600 });
  }

  protectFile(filePath: string): void {
    fs.chmodSync(filePath, 0o600);
  }

  repairFile(filePath: string): void {
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }

  inspect(targetPath: string, kind: SecretPathKind): SecretFileInspection {
    const expected = kind === 'dir' ? 0o700 : 0o600;
    const mode = fs.statSync(targetPath).mode & 0o777;
    if (mode === expected) return { ok: true };
    return {
      ok: false,
      summary: `パーミッションが ${mode.toString(8)} です。`,
      fix: `chmod ${expected.toString(8)} ${targetPath}`,
    };
  }
}

/** platform は HostEnv.platform。win32 以外は Unix 実装。 */
export function createSecretFileGuard(platform: NodeJS.Platform): SecretFileGuard {
  return platform === 'win32' ? createWindowsSecretFileGuard() : new UnixSecretFileGuard();
}
