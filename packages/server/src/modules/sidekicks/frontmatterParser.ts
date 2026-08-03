// ─── SKILL.md frontmatter parser ───
//
// フラットな `key: value` 形式のみをサポートする自前実装（新規依存禁止のため js-yaml 等は使わない）。
// ケアするのは以下の2点のみ:
//   - 値に `:` を含む場合（最初の `:` だけをキー/値の区切りとして扱う）
//   - 引用符（' または "）で囲まれた値（前後の引用符を1組だけ剥がす）

export interface ParsedSkillFile {
  frontmatter: Record<string, string>;
  body: string;
}

const FRONTMATTER_DELIM = '---';

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * SKILL.md の内容を frontmatter（`---` で囲まれた先頭ブロック）と本文に分解する。
 * frontmatter が無い、または終端の `---` が無い場合はエラーとする（fail fast）。
 */
export function parseFrontmatter(raw: string): ParsedSkillFile {
  const lines = raw.split('\n');
  if (lines.length === 0 || lines[0].trim() !== FRONTMATTER_DELIM) {
    throw new Error('SKILL.md must start with a "---" frontmatter block');
  }

  const endIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === FRONTMATTER_DELIM);
  if (endIdx === -1) {
    throw new Error('SKILL.md frontmatter is not terminated with "---"');
  }

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, endIdx)) {
    if (!line.trim()) continue;
    const sepIdx = line.indexOf(':');
    if (sepIdx === -1) {
      throw new Error(`Invalid frontmatter line (missing ":"): "${line}"`);
    }
    const key = line.slice(0, sepIdx).trim();
    const value = stripQuotes(line.slice(sepIdx + 1).trim());
    if (!key) {
      throw new Error(`Invalid frontmatter line (empty key): "${line}"`);
    }
    frontmatter[key] = value;
  }

  // 終端行の直後の改行1つ分は区切りとして除去し、それ以降を本文とする。
  const body = lines.slice(endIdx + 1).join('\n').replace(/^\n/, '');
  return { frontmatter, body };
}
