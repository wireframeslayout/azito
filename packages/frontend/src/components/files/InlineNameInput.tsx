import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';

export function validateEntryName(name: string, siblingNames: string[]): string | null {
  if (!name.trim()) return 'explorer.nameEmpty';
  if (/[/\\]/.test(name)) return 'explorer.nameInvalidChars';
  if (/[\x00-\x1f]/.test(name)) return 'explorer.nameInvalidChars';
  if (name.startsWith('..')) return 'explorer.nameStartsDotDot';
  if (siblingNames.some((s) => s === name)) return 'explorer.nameDuplicate';
  return null;
}

interface InlineNameInputProps {
  initialValue: string;
  kind: 'file' | 'directory';
  siblingNames: string[];
  onCommit: (name: string) => void;
  onCancel: () => void;
  depth: number;
}

export default function InlineNameInput({ initialValue, kind, siblingNames, onCommit, onCancel, depth }: InlineNameInputProps) {
  const { t } = useTranslation('files');
  const [value, setValue] = useState(initialValue);
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleCommit = useCallback(() => {
    if (committedRef.current) return;
    const trimmed = value.trim();
    const err = validateEntryName(trimmed, siblingNames);
    if (err) {
      setValidationError(err);
      return;
    }
    committedRef.current = true;
    onCommit(trimmed);
  }, [value, siblingNames, onCommit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }, [handleCommit, onCancel]);

  const handleBlur = useCallback(() => {
    if (!committedRef.current) onCancel();
  }, [onCancel]);

  return (
    <div style={{ paddingLeft: 8 + depth * 16, paddingRight: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: 26 }}>
        <span style={{ width: 16, flexShrink: 0 }} />
        <span style={{ width: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={kind === 'directory' ? 'files' : 'file'} size={14} />
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); setValidationError(null); }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          style={{
            flex: 1,
            background: 'var(--bg-input)',
            border: validationError ? '1px solid var(--danger)' : '1px solid var(--accent)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text)',
            fontSize: 'var(--font-md)',
            padding: '1px 6px',
            outline: 'none',
            minWidth: 0,
          }}
          aria-label={kind === 'directory' ? t('explorer.newFolder') : t('explorer.newFile')}
        />
      </div>
      {validationError && (
        <div style={{
          paddingLeft: 38,
          fontSize: 'var(--font-2xs)',
          color: 'var(--danger)',
          marginTop: 1,
        }}>
          {t(validationError)}
        </div>
      )}
    </div>
  );
}
