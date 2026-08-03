import * as fs from 'fs';
import * as path from 'path';

export interface PromptModules {
  reviewPerspectives: string;
  softwareDesignPrinciples: string;
  uiDesignPrinciples: string;
  /**
   * 言語横断の実装ルール（harness/prompt-modules/rules/ 配下の *.md を連結したもの）。
   * 親エージェントの CLAUDE.md には載るがサブエージェント（特に別プロバイダ）には
   * 自動では届かないため、委任時にこの内容をルールファイルとして渡す。
   * rules ディレクトリが存在しない環境では空文字になる。
   */
  implementationRules: string;
}

import { resolveRoot } from '../../shared/releaseInfo';

const DEFAULT_MODULES_DIR = path.join(resolveRoot(), 'harness', 'prompt-modules');

interface CacheEntry {
  content: string;
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

function readModule(dir: string, filename: string): string {
  const filePath = path.join(dir, filename);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`Prompt module not found: ${filePath}`);
  }

  const mtime = stat.mtimeMs;
  const cached = cache.get(filePath);
  if (cached && cached.mtime === mtime) {
    return cached.content;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  cache.set(filePath, { content, mtime });
  return content;
}

const RULES_SUBDIR = 'rules';

/**
 * rules/ ディレクトリ配下の *.md をファイル名昇順で連結する。
 * ディレクトリが無ければ空文字を返す（rules は任意の拡張のため、欠如は致命ではない）。
 * 個々のファイル読み込みは readModule のキャッシュ・mtime 判定をそのまま利用する。
 */
function readImplementationRules(modulesDir: string): string {
  const rulesDir = path.join(modulesDir, RULES_SUBDIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(rulesDir);
  } catch {
    return '';
  }
  const files = entries.filter((f) => f.endsWith('.md')).sort();
  return files.map((f) => readModule(rulesDir, f)).join('\n\n');
}

export function loadPromptModules(modulesDir: string = DEFAULT_MODULES_DIR): PromptModules {
  return {
    reviewPerspectives: readModule(modulesDir, 'review-perspectives.md'),
    softwareDesignPrinciples: readModule(modulesDir, 'software-design-principles.md'),
    uiDesignPrinciples: readModule(modulesDir, 'ui-design-principles.md'),
    implementationRules: readImplementationRules(modulesDir),
  };
}
