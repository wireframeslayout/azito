export interface OptionListItem {
  value: string;
  label: string;
  description?: string;
}

interface OptionListProps {
  options: OptionListItem[];
  /** 選択済み option の value 集合。 */
  selectedValues: Set<string>;
  /**
   * キーボード操作/ホバーでハイライト中の value（対話利用、コマンドパレット Issue #338 フェーズC）。
   * selectedValues とは独立 — 「確定済み選択」の ✓ 表示とは別に、現在の候補位置を示す背景ハイライト。
   */
  activeValue?: string;
  /** 指定時は各行をクリック/キーボードで選択可能にする（対話利用）。省略時は従来どおり表示専用。 */
  onSelect?: (value: string) => void;
}

/**
 * 選択肢リスト表示（label + description、選択済みは ✓ とアクセント色）。props 駆動の汎用部品 —
 * InteractionCard（AskUserQuestion の質問カード、Issue #338 フェーズA）向けに切り出したが、
 * コマンドパレット（Issue #338 フェーズC）でも再利用するため、onSelect/activeValue を渡した場合のみ
 * 対話可能なリストとして振る舞う（省略時は従来どおり表示専用、transcript 固有の状態は持たせない）。
 */
export function OptionList({ options, selectedValues, activeValue, onSelect }: OptionListProps) {
  const interactive = onSelect !== undefined;
  return (
    <div role={interactive ? 'listbox' : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {options.map((option) => {
        const isSelected = selectedValues.has(option.value);
        const isActive = activeValue === option.value;
        return (
          <div
            key={option.value}
            role={interactive ? 'option' : undefined}
            aria-selected={interactive ? isActive : undefined}
            onClick={interactive ? () => onSelect(option.value) : undefined}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '5px 8px',
              borderRadius: 'var(--radius-sm)',
              background: isSelected ? 'var(--accent-a15)' : isActive ? 'var(--bg-hover)' : 'transparent',
              cursor: interactive ? 'pointer' : undefined,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                width: 14,
                lineHeight: 'var(--font-sm)',
                fontSize: 'var(--font-sm)',
                fontWeight: 700,
                color: isSelected ? 'var(--accent)' : 'transparent',
              }}
            >
              ✓
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 'var(--font-sm)',
                  lineHeight: 1.4,
                  color: isSelected || isActive ? 'var(--text)' : 'var(--text-dim)',
                  fontWeight: isSelected ? 600 : 400,
                }}
              >
                {option.label}
              </div>
              {option.description && (
                <div style={{ fontSize: 'var(--font-xs)', lineHeight: 1.4, color: 'var(--text-dim)' }}>
                  {option.description}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
