import { posixDialect } from './os/shellDialect';

/** シェルコマンド引数として安全な形に単一引用符で囲む（POSIX sh 用。ShellDialect の POSIX 実装）。 */
export function shellQuote(s: string): string {
  return posixDialect.quote(s);
}
