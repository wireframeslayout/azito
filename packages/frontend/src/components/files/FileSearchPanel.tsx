import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getUiToken } from '../../api/token';
import { Icon } from '../ui/Icon';
import { InlineToggle } from '../ui/InlineToggle';
import { SearchResultList, type SearchResultGroup, type SearchHitItem } from './SearchResultList';

interface FileSearchPanelProps { serverName: string; projectId: number; root: string; onOpenHit: (path: string, line: number) => void; onClose: () => void; }
interface SearchApiResult { nameMatches: string[]; contentHits: SearchHitItem[]; engine: 'rg' | 'grep'; truncated: boolean; elapsedMs: number; }

export function FileSearchPanel({ serverName, projectId, root, onOpenHit, onClose }: FileSearchPanelProps) {
  const { t } = useTranslation('files');
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchApiResult | null>(null);
  const [activeHit, setActiveHit] = useState<{ path: string; line: number } | undefined>();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const abortRef = useRef<AbortController>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const performSearch = useCallback((q: string, cs: boolean, ww: boolean, re: boolean, inc: string, exc: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    if (!q.trim()) { setResult(null); setError(null); setLoading(false); return; }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      const params = new URLSearchParams({ q, project_id: String(projectId), root, case: String(cs), whole_word: String(ww), regex: String(re) });
      if (inc.trim()) params.set('include', inc.trim());
      if (exc.trim()) params.set('exclude', exc.trim());
      try {
        const token = getUiToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`/api/servers/${encodeURIComponent(serverName)}/files/search?${params}`, { headers, signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Unknown error' }));
          setError(res.status === 504 ? t('search.timedOut') : body.error || t('search.failed'));
          setLoading(false);
          return;
        }
        const data: SearchApiResult = await res.json();
        setResult(data); setError(null); setLoading(false);
      } catch (err: unknown) {
        if ((err as Error).name === 'AbortError') return;
        setError(t('search.failed')); setLoading(false);
      }
    }, 300);
  }, [serverName, projectId, root, t]);

  useEffect(() => {
    performSearch(query, caseSensitive, wholeWord, useRegex, include, exclude);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); if (abortRef.current) abortRef.current.abort(); };
  }, [query, caseSensitive, wholeWord, useRegex, include, exclude, performSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Escape') { if (query) setQuery(''); else onClose(); } };
  const handleSelect = (path: string, line: number) => { setActiveHit({ path, line }); onOpenHit(root.endsWith('/') ? root + path : root + '/' + path, line); };
  const groups: SearchResultGroup[] = [];
  if (result) {
    const contentByPath = new Map<string, SearchHitItem[]>();
    for (const hit of result.contentHits) { const hits = contentByPath.get(hit.path) || []; hits.push(hit); contentByPath.set(hit.path, hits); }
    for (const namePath of result.nameMatches) { const hits = contentByPath.get(namePath); groups.push({ path: namePath, isNameMatch: true, hits: hits || [] }); contentByPath.delete(namePath); }
    for (const [path, hits] of contentByPath) groups.push({ path, isNameMatch: false, hits });
  }
  const totalFiles = groups.length;
  const totalHits = result ? result.nameMatches.length + result.contentHits.length : 0;
  const inputStyle = { width: '100%', padding: '4px 8px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-xs)', outline: 'none' };

  return <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button type="button" onClick={() => setDetailsOpen(!detailsOpen)} aria-expanded={detailsOpen} aria-label={t('search.toggleDetails')} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, padding: 0, border: 'none', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', borderRadius: 2, flexShrink: 0, transform: detailsOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}><Icon name="chevron-right" size={14} /></button>
        <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
          <input ref={inputRef} type="text" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={handleKeyDown} placeholder={t('search.placeholder')} aria-label={t('search.placeholder')} style={{ width: '100%', padding: '5px 72px 5px 8px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-sm)', outline: 'none' }} />
          <div style={{ position: 'absolute', right: 4, display: 'flex', gap: 2, alignItems: 'center' }}>
            {loading && <div style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.6s linear infinite', marginRight: 2 }} />}
            <InlineToggle active={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)} title={t('search.caseSensitiveTitle')}>Aa</InlineToggle>
            <InlineToggle active={wholeWord} onClick={() => setWholeWord(!wholeWord)} title={t('search.wholeWordTitle')} style={{ textDecoration: 'underline' }}>ab</InlineToggle>
            <InlineToggle active={useRegex} onClick={() => setUseRegex(!useRegex)} title={t('search.regexTitle')}>.*</InlineToggle>
          </div>
        </div>
      </div>
      {detailsOpen && <div style={{ marginTop: 6, marginLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <input type="text" value={include} onChange={e => setInclude(e.target.value)} placeholder={t('search.includePlaceholder')} aria-label={t('search.include')} style={inputStyle} />
        <input type="text" value={exclude} onChange={e => setExclude(e.target.value)} placeholder={t('search.excludePlaceholder')} aria-label={t('search.exclude')} style={inputStyle} />
      </div>}
    </div>
    <div style={{ flex: 1, overflow: 'auto', opacity: loading && result ? 0.5 : 1, transition: 'opacity 0.15s' }}>
      {error && <div style={{ padding: '16px 12px', color: 'var(--danger)', fontSize: 'var(--font-sm)', textAlign: 'center' }}>{error}</div>}
      {!error && result && groups.length === 0 && <div style={{ padding: '16px 12px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}><p>{t('search.noMatch')}</p><p style={{ fontSize: 'var(--font-xs)', marginTop: 4 }}>{t('search.noMatchHint')}</p></div>}
      {!error && result && groups.length > 0 && <SearchResultList groups={groups} engine={result.engine} truncated={result.truncated} elapsedMs={result.elapsedMs} totalFiles={totalFiles} totalHits={totalHits} activeHit={activeHit} onSelect={handleSelect} />}
    </div>
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </div>;
}
