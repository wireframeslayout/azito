import * as fs from 'fs';
import * as path from 'path';
import { resolveRoot } from '../../shared/releaseInfo';
import { chatCommandSchema, chatCommandsFileSchema, withDefaultOutput, type ChatCommand } from './ChatCommand';

// ─── 層のパス解決（SidekickPackageLoader と同じ方式: 起動時に一度だけ解決し、以降は解決済みパスを
// 使う = Resolve at the Boundary）。実際の起点は main.ts/wiring 側で AZITO_DATA_DIR 込みで解決した
// パスを渡す想定で、ここのデフォルトは DI なしで直接使う場合のフォールバックに過ぎない。 ───

export const DEFAULT_BUILTIN_CHAT_COMMANDS_PATH = path.join(resolveRoot(), 'harness', 'chat-commands.json');
export const DEFAULT_USER_CHAT_COMMANDS_PATH = path.join(resolveRoot(), 'data', 'chat-commands.json');

// ─── ファイル内容キャッシュ（mtime ベース） ───

interface FileCacheEntry {
  mtime: number;
  commands: ChatCommand[];
}

const fileCache = new Map<string, FileCacheEntry>();

function commandLabel(entry: unknown): string {
  if (typeof entry === 'object' && entry !== null && 'name' in entry && typeof (entry as { name: unknown }).name === 'string') {
    return (entry as { name: string }).name;
  }
  return '(unknown)';
}

function loadFile(filePath: string): ChatCommand[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    fileCache.delete(filePath);
    return [];
  }

  const cached = fileCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.commands;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[chat-commands] Failed to parse ${filePath} as JSON: ${(err as Error).message}. Skipping this layer.`);
    return [];
  }

  const fileParsed = chatCommandsFileSchema.safeParse(raw);
  if (!fileParsed.success) {
    console.warn(`[chat-commands] ${filePath} does not match the expected shape ({ commands: [...] }): ${fileParsed.error.message}. Skipping this layer.`);
    return [];
  }

  const commands: ChatCommand[] = [];
  for (const entry of fileParsed.data.commands) {
    const parsed = chatCommandSchema.safeParse(entry);
    if (!parsed.success) {
      console.warn(`[chat-commands] Invalid command "${commandLabel(entry)}" in ${filePath}: ${parsed.error.message}. Skipping this entry.`);
      continue;
    }
    commands.push(withDefaultOutput(parsed.data));
  }

  fileCache.set(filePath, { mtime: stat.mtimeMs, commands });
  return commands;
}

/**
 * ビルトイン層とユーザー層をマージしてチャットコマンド定義を提供する2層ローダー
 * （SidekickPackageLoader の2層マージ方式を、ディレクトリではなく単一 JSON ファイル向けに簡略化）。
 * 同名コマンドはユーザー層が勝つ（name をキーにマージ）。
 */
export class ChatCommandLoader {
  constructor(
    private readonly builtinPath: string = DEFAULT_BUILTIN_CHAT_COMMANDS_PATH,
    private readonly userPath: string = DEFAULT_USER_CHAT_COMMANDS_PATH,
  ) {}

  invalidateCache(): void {
    fileCache.delete(this.builtinPath);
    fileCache.delete(this.userPath);
  }

  list(): ChatCommand[] {
    const builtin = loadFile(this.builtinPath);
    const user = loadFile(this.userPath);
    const userNames = new Set(user.map((c) => c.name));
    const merged = [...builtin.filter((c) => !userNames.has(c.name)), ...user];
    return merged.sort((a, b) => a.name.localeCompare(b.name));
  }

  listForAgentType(agentType: string): ChatCommand[] {
    return this.list().filter((c) => c.agentTypes.includes(agentType));
  }
}
