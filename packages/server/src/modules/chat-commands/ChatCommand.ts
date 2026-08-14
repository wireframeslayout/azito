import { z } from 'zod';

// ─── 設定駆動コマンドパレット（Issue #338 フェーズC）───
//
// claude の `/model sonnet` のような引数付きスラッシュコマンドは TUI の選択画面を開かず即適用され、
// このセッション限定で有効になる。チャット入力欄でユーザーが `/` を打った際に候補パレットを出す
// ための定義を、ビルトイン（harness/chat-commands.json）＋ユーザー層（<data>/chat-commands.json）
// の2層 JSON 設定として持つ。YAML ライブラリは追加しない方針のため JSON。

export const CHAT_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export const chatCommandOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

export type ChatCommandOption = z.infer<typeof chatCommandOptionSchema>;

export const chatCommandSchema = z
  .object({
    name: z.string().regex(CHAT_COMMAND_NAME_PATTERN),
    description: z.string(),
    // 適用対象の workerType（例: "claude"）。codex は引数付きスラッシュコマンドの即時適用挙動が
    // 未実測のため、ビルトインには含めない（ユーザー層で自己責任で追加することは妨げない）。
    agentTypes: z.array(z.string().min(1)).min(1),
    type: z.enum(['select', 'text']),
    options: z.array(chatCommandOptionSchema).optional(),
    // 省略時は `/${name} ${value}`（frontend 側で name から補完する。text 型では入力欄への
    // `/${name} ` 挿入に使うため、output は select 型でのみ実際に展開・送信される）。
    output: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'select' && (!val.options || val.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'select type commands require a non-empty "options" array',
        path: ['options'],
      });
    }
  });

export type ChatCommand = z.infer<typeof chatCommandSchema>;

export const chatCommandsFileSchema = z.object({
  commands: z.array(z.unknown()),
});

/** output 省略時の既定テンプレートを補う。`${value}` は選択された option の value で展開する（frontend 側）。 */
export function withDefaultOutput(command: ChatCommand): ChatCommand {
  if (command.output !== undefined) return command;
  return { ...command, output: `/${command.name} \${value}` };
}
