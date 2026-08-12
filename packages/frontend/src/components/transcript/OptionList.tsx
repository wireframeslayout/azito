export interface OptionListItem {
  value: string;
  label: string;
  description?: string;
}

interface OptionListProps {
  options: OptionListItem[];
  /** 選択済み option の value 集合。 */
  selectedValues: Set<string>;
}

/**
 * 選択肢リスト表示（label + description、選択済みは ✓ とアクセント色）。props 駆動の汎用部品 —
 * InteractionCard（AskUserQuestion の質問カード、Issue #338 フェーズA）向けに切り出したが、
 * 後続フェーズのコマンドパレットでも再利用予定のため、transcript 固有の状態は持たせない。
 */
export function OptionList({ options, selectedValues }: OptionListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {options.map((option) => {
        const isSelected = selectedValues.has(option.value);
        return (
          <div
            key={option.value}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '5px 8px',
              borderRadius: 'var(--radius-sm)',
              background: isSelected ? 'var(--accent-a15)' : 'transparent',
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
                  color: isSelected ? 'var(--text)' : 'var(--text-dim)',
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
