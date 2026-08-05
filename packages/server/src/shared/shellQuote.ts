/** シェルコマンド引数として安全な形に単一引用符で囲む。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
