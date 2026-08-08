import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getUiToken } from '../../api/token';
import { Chip } from '../ui/Chip';
import { Icon } from '../ui/Icon';
import { SearchResultList, type SearchResultGroup, type SearchHitItem } from './SearchResultList';

interface FileSearchPanelProps {
  serverName: string;
  projectId: number;
  root: string;
  onOpenHit: (path: string, line: number) => void;
  onClose: () => void;
}

interface SearchApiResult {
  nameMatches: string[];
  contentHits: SearchHitItem[];
  engine: 'rg' | 'grep';
  truncated: boolean;
  elapsedMs: number;
}

export function FileSearchPanel({ serverName, projectId, root, onOpenHit, onClose }: FileSearchPanelProps) {
  const { t } = useTranslation('files');
  const [query, setQuery] = useState('');
  const [matchName, setMatchName] = useState(true);
  const [matchContent, setMatchContent] = useState(true);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchApiResult | null>(null);
  const [activeHit, setActiveHit] = useState<{ path: string; line: number } | undefined>();

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const abortRef = useRef<AbortController>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const performSearch = useCallback((q: string, name: boolean, content: boolean, cs: boolean, re: boolean) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    if (!q.trim()) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;

      const params = new URLSearchParams({
        q,
        project_id: String(projectId),
        root,
        name: String(name),
        content: String(content),
        case: String(cs),
        regex: String(re),
      });

      try {
        const token = getUiToken();
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(
          `/api/servers/${encodeURIComponent(serverName)}/files/search?${params}`,
          { headers, signal: controller.signal },
        );

        if (controller.signal.aborted) return;

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Unknown error' }));
          if (res.status === 504) {
            setError(t('search.timedOut'));
          } else {
            setError(body.error || t('search.failed'));
          }
          setLoading(false);
          return;
        }

        const data: SearchApiResult = await res.json();
        setResult(data);
        setError(null);
        setLoading(false);
      } catch (err: unknown) {
        if ((err as Error).name === 'AbortError') return;
        setError(t('search.failed'));
        setLoading(false);
      }
    }, 300);
  }, [serverName, projectId, root, t]);

  useEffect(() => {
    performSearch(query, matchName, matchContent, caseSensitive, useRegex);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query, matchName, matchContent, caseSensitive, useRegex, performSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (query) {
        setQuery('');
      } else {
        onClose();
      }
    }
  };

  const toggleName = () => {
    if (matchName && !matchContent) return;
    setMatchName(!matchName);
  };

  const toggleContent = () => {
    if (matchContent && !matchName) return;
    setMatchContent(!matchContent);
  };

  const handleSelect = (path: string, line: number) => {
    const fullPath = root.endsWith('/') ? root + path : root + '/' + path;
    setActiveHit({ path, line });
    onOpenHit(fullPath, line);
  };

  const groups: SearchResultGroup[] = [];
  if (result) {
    const contentByPath = new Map<string, SearchHitItem[]>();
    for (const hit of result.contentHits) {
      const arr = contentByPath.get(hit.path) || [];
      arr.push(hit);
      contentByPath.set(hit.path, arr);
    }

    for (const namePath of result.nameMatches) {
      const contentHits = contentByPath.get(namePath);
      groups.push({ path: namePath, isNameMatch: true, hits: contentHits || [] });
      contentByPath.delete(namePath);
    }

    for (const [path, hits] of contentByPath) {
      groups.push({ path, isNameMatch: false, hits });
    }
  }

  const totalFiles = groups.length;
  const totalHits = result ? result.nameMatches.length + result.contentHits.length : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Search input */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Icon name="search" size={14} style={{ position: 'absolute', left: 8, color: 'var(--text-dim)', pointerEvents: 'none' }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('search.placeholder')}
            style={{
              width: '100%',
              padding: '6px 32px 6px 28px',
              background: 'var(--input-bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text)',
              fontSize: 'var(--font-sm)',
              outline: 'none',
            }}
            aria-label={t('search.placeholder')}
          />
          {loading && (
            <div style={{
              position: 'absolute',
              right: 8,
              width: 14,
              height: 14,
              border: '2px solid var(--border)',
              borderTopColor: 'var(--accent)',
              borderRadius: '50%',
              animation: 'spin 0.6s linear infinite',
            }} />
          )}
        </div>

        {/* Toggles */}
        <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <ToggleChip active={matchName} onClick={toggleName} label={t('search.byName')} />
          <ToggleChip active={matchContent} onClick={toggleContent} label={t('search.byContent')} />
          <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 2px', flexShrink: 0 }} />
          <ToggleChip active={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)} label={t('search.caseSensitive')} />
          <ToggleChip active={useRegex} onClick={() => setUseRegex(!useRegex)} label={t('search.regex')} />
        </div>

        {/* Excluded info */}
        <div style={{ fontSize: 'var(--font-xxs)', color: 'var(--text-dim)', opacity: 0.6, marginTop: 4 }}>
          {t('search.excluded')}
        </div>
      </div>

      {/* Results area */}
      <div style={{ flex: 1, overflow: 'auto', opacity: loading && result ? 0.5 : 1, transition: 'opacity 0.15s' }}>
        {error && (
          <div style={{ padding: '16px 12px', color: 'var(--danger)', fontSize: 'var(--font-sm)', textAlign: 'center' }}>
            {error}
          </div>
        )}
        {!error && result && groups.length === 0 && (
          <div style={{ padding: '16px 12px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>
            <p>{t('search.noMatch')}</p>
            <p style={{ fontSize: 'var(--font-xs)', marginTop: 4 }}>{t('search.noMatchHint')}</p>
          </div>
        )}
        {!error && result && groups.length > 0 && (
          <SearchResultList
            groups={groups}
            engine={result.engine}
            truncated={result.truncated}
            elapsedMs={result.elapsedMs}
            totalFiles={totalFiles}
            totalHits={totalHits}
            activeHit={activeHit}
            onSelect={handleSelect}
          />
        )}
      </div>

      {/* Spinner keyframes */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ToggleChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <Chip
      tone={active ? 'accent' : 'default'}
      style={{ cursor: 'pointer', userSelect: 'none' }}
    >
      <span onClick={onClick} role="checkbox" aria-checked={active} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
        {label}
      </span>
    </Chip>
  );
}
