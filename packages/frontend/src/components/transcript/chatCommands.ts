// ─── 設定駆動コマンドパレット（Issue #338 フェーズC）の純ロジック ───
//
// server の GET /api/chat-commands が返す定義形と一致させる（サーバー側は必須フィールド検証済み・
// output のデフォルト補完済みのため、frontend 側では構造をそのまま信頼する）。

export interface ChatCommandOption {
  value: string;
  label: string;
  description?: string;
}

export interface ChatCommand {
  name: string;
  description: string;
  agentTypes: string[];
  type: 'select' | 'text';
  options?: ChatCommandOption[];
  output?: string;
}

/**
 * 入力欄テキストがコマンドパレットの対象かどうかを判定し、対象なら「/」に続くクエリ文字列を返す。
 * 対象外（"/" で始まらない）は null。
 */
export function extractCommandQuery(text: string): string | null {
  if (!text.startsWith('/')) return null;
  return text.slice(1);
}

/** name/description の前方一致でコマンドを絞り込む（大小文字を無視）。 */
export function filterChatCommands(commands: ChatCommand[], query: string): ChatCommand[] {
  const q = query.toLowerCase();
  return commands.filter(
    (c) => c.name.toLowerCase().startsWith(q) || c.description.toLowerCase().startsWith(q),
  );
}

/**
 * select 型コマンドの output テンプレートを、選択された option の value で展開する。
 * output 未指定時は `/${name} ${value}` を既定とする（server 側で既に補完されている想定だが、
 * frontend 単体テスト・防御的フォールバックのためここでも同じ既定を適用する）。
 */
export function expandCommandOutput(command: ChatCommand, value: string): string {
  const template = command.output ?? `/${command.name} \${value}`;
  return template.split('${value}').join(value);
}

/** text 型コマンドを選んだ際に入力欄へ挿入する文字列。 */
export function textCommandInsertion(command: ChatCommand): string {
  return `/${command.name} `;
}
