import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { baseInputStyle } from './FormInput';

interface TagChipInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Tags shown as one-click "quick add" suggestions (e.g. the 5 phase tags). */
  suggestions?: string[];
  /** Validates a candidate tag before it's added; invalid tags are rejected with `onInvalid`. */
  validate?: (tag: string) => boolean;
  onInvalid?: (tag: string) => void;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

/**
 * Chip-style tag editor: type + Enter (or comma) to add, click a chip's × to remove,
 * Backspace on an empty input removes the last chip. Suggestions (phase tags) render
 * as quick-add buttons for tags not yet applied. Reusable base component (components/ui).
 */
export function TagChipInput({
  value, onChange, suggestions = [], validate, onInvalid, placeholder, disabled, 'aria-label': ariaLabel,
}: TagChipInputProps) {
  const { t } = useTranslation('common');
  const [draft, setDraft] = useState('');
  const listId = useId();

  const commit = useCallback((raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    if (value.includes(tag)) { setDraft(''); return; }
    if (validate && !validate(tag)) { onInvalid?.(tag); return; }
    onChange([...value, tag]);
    setDraft('');
  }, [value, onChange, validate, onInvalid]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }, [draft, commit, value, onChange]);

  const handleRemove = useCallback((tag: string) => {
    onChange(value.filter((t) => t !== tag));
  }, [value, onChange]);

  const pendingSuggestions = suggestions.filter((s) => !value.includes(s));

  return (
    <div>
      <div
        role="list"
        aria-label={ariaLabel}
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
          padding: '6px 8px', minHeight: 38,
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {value.map((tag) => (
          <span
            key={tag}
            role="listitem"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 'var(--font-sm)', fontWeight: 500, color: 'var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 16%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
              borderRadius: 'var(--radius-sm)', padding: '2px 4px 2px 8px',
            }}
          >
            {tag}
            {!disabled && (
              <button
                type="button"
                onClick={() => handleRemove(tag)}
                aria-label={t('tagChip.removeTag', { tag })}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'inherit', fontSize: 'var(--font-md)', lineHeight: 1, padding: '2px 4px',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <input
          id={listId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => commit(draft)}
          disabled={disabled}
          placeholder={value.length === 0 ? placeholder : undefined}
          aria-label={ariaLabel ? `${ariaLabel} input` : t('tagChip.addTag')}
          style={{
            ...baseInputStyle,
            flex: '1 1 120px', minWidth: 100, width: 'auto',
            padding: '4px 2px', border: 'none', background: 'transparent',
          }}
        />
      </div>
      {pendingSuggestions.length > 0 && !disabled && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {pendingSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => commit(s)}
              style={{
                fontSize: 'var(--font-xs)', color: 'var(--text-dim)', background: 'var(--bg-card)',
                border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', padding: '2px 8px',
                cursor: 'pointer',
              }}
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
