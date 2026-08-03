import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { baseInputStyle } from './ui';

interface BranchInputProps {
  value: string;
  onChange: (value: string) => void;
  serverName: string;
  projectId: number;
  workingDirectory?: string;
  placeholder?: string;
  style?: React.CSSProperties;
}

export default function BranchInput({ value, onChange, serverName, projectId, workingDirectory, placeholder, style }: BranchInputProps) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const blurRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hasFocusRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  const disabled = !serverName || isNaN(projectId);

  const fetchSuggestions = useCallback(async (q: string) => {
    if (disabled) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    try {
      let url = `/servers/${encodeURIComponent(serverName)}/branches?q=${encodeURIComponent(q)}&project_id=${projectId}`;
      if (workingDirectory) url += `&working_directory=${encodeURIComponent(workingDirectory)}`;
      const result = await api<{ branches: string[] }>(url);
      const items = Array.isArray(result.branches) ? result.branches.slice(0, 20) : [];
      setSuggestions(items);
      setHighlightIdx(0);
      if (hasFocusRef.current) setOpen(items.length > 0);
    } catch {
      setSuggestions([]);
      setOpen(false);
    }
  }, [serverName, projectId, workingDirectory, disabled]);

  const debouncedFetch = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(q), 300);
  }, [fetchSuggestions]);

  useEffect(() => {
    if (value) debouncedFetch(value);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [serverName, projectId, workingDirectory]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectItem = useCallback((item: string) => {
    onChange(item);
    setOpen(false);
  }, [onChange]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);
    debouncedFetch(newValue);
  }, [onChange, debouncedFetch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx(prev => {
        const next = Math.min(prev + 1, suggestions.length - 1);
        scrollToItem(next);
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx(prev => {
        const next = Math.max(prev - 1, 0);
        scrollToItem(next);
        return next;
      });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (open && suggestions.length > 0) {
        e.preventDefault();
        selectItem(suggestions[highlightIdx]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }, [open, suggestions, highlightIdx, selectItem]);

  const scrollToItem = (idx: number) => {
    if (!listRef.current) return;
    const items = listRef.current.children;
    if (items[idx]) (items[idx] as HTMLElement).scrollIntoView({ block: 'nearest' });
  };

  const handleBlur = useCallback(() => {
    hasFocusRef.current = false;
    blurRef.current = setTimeout(() => setOpen(false), 200);
  }, []);

  const handleFocus = useCallback(() => {
    hasFocusRef.current = true;
    if (blurRef.current) clearTimeout(blurRef.current);
    if (value && suggestions.length > 0) setOpen(true);
    else if (value) debouncedFetch(value);
  }, [value, suggestions, debouncedFetch]);

  const renderItem = (item: string, idx: number) => {
    const q = value.toLowerCase();
    const matchLen = item.toLowerCase().startsWith(q) ? q.length : 0;
    const matched = item.substring(0, matchLen);
    const rest = item.substring(matchLen);

    return (
      <div
        key={item}
        onMouseDown={(e) => { e.preventDefault(); selectItem(item); }}
        onMouseEnter={() => setHighlightIdx(idx)}
        style={{
          padding: '6px 10px',
          fontSize: 'var(--font-md)',
          cursor: 'pointer',
          background: idx === highlightIdx ? 'var(--accent-a15)' : 'transparent',
          color: 'var(--text)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <span style={{ color: 'var(--text-dim)' }}>{matched}</span>
        <span style={{ fontWeight: 600 }}>{rest}</span>
      </div>
    );
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onFocus={handleFocus}
        placeholder={placeholder}
        style={{ ...baseInputStyle, ...style }}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <div
          ref={listRef}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 100,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            marginTop: 2,
            maxHeight: 260,
            overflowY: 'auto',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          {suggestions.map((item, idx) => renderItem(item, idx))}
        </div>
      )}
    </div>
  );
}
