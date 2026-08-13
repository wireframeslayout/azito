import { useTranslation } from 'react-i18next';
import { useClickOutside } from '../../hooks/useClickOutside';
import { OptionList, type OptionListItem } from './OptionList';
import type { ChatCommand } from './chatCommands';

export type CommandPaletteStage = 'commands' | 'options';

interface CommandPaletteProps {
  stage: CommandPaletteStage;
  /** stage: 'commands' のときの候補一覧（呼び出し側でフィルタ済み）。 */
  commands: ChatCommand[];
  /** stage: 'options' のとき選択中のコマンド。 */
  activeCommand?: ChatCommand;
  /** 現在キーボードでハイライトされている value（コマンド名 or option value）。 */
  activeValue?: string;
  onSelectCommand: (command: ChatCommand) => void;
  onSelectOption: (value: string) => void;
  /** Esc・外側タップ: stage: 'options' なら1段階戻る、stage: 'commands' なら閉じる。 */
  onDismiss: () => void;
}

/**
 * チャット入力欄の「/」誘導パレット（Issue #338 フェーズC、設定駆動コマンドパレット）。
 * 浮遊UIのため背景は --bg-elevated 必須（--bg-card は不可 — メモ「浮遊UIの背景トークン」）。
 * OptionList（フェーズAで InteractionCard 向けに切り出した汎用リスト部品）を対話モードで再利用する。
 */
export function CommandPalette({ stage, commands, activeCommand, activeValue, onSelectCommand, onSelectOption, onDismiss }: CommandPaletteProps) {
  const { t } = useTranslation('transcript');
  const ref = useClickOutside<HTMLDivElement>(onDismiss);

  const items: OptionListItem[] =
    stage === 'commands'
      ? commands.map((c) => ({ value: c.name, label: `/${c.name}`, description: c.description }))
      : (activeCommand?.options ?? []).map((o) => ({ value: o.value, label: o.label, description: o.description }));

  const handleSelect = (value: string) => {
    if (stage === 'commands') {
      const command = commands.find((c) => c.name === value);
      if (command) onSelectCommand(command);
      return;
    }
    onSelectOption(value);
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('promptBar.commandPalette.ariaLabel')}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 6,
        zIndex: 100,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-2)',
        maxHeight: 260,
        overflowY: 'auto',
        padding: 6,
      }}
    >
      {stage === 'options' && activeCommand && (
        <div
          style={{
            padding: '4px 8px 6px',
            fontSize: 'var(--font-2xs)',
            color: 'var(--text-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          /{activeCommand.name}
        </div>
      )}
      {items.length === 0 ? (
        <div style={{ padding: '10px 8px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
          {t('promptBar.commandPalette.empty')}
        </div>
      ) : (
        <OptionList options={items} selectedValues={new Set()} activeValue={activeValue} onSelect={handleSelect} />
      )}
    </div>
  );
}
