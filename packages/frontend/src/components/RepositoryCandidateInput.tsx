import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { Badge, Spinner, baseInputStyle } from './ui';
import { createRequestGuard } from './repoDiscoveryDialogLogic';
import {
  groupRepositoryCandidates, fetchCandidatesGuarded, beginCandidateEditRequest,
  type RepositoryCandidate, type RepositoryCandidatesResult, type RepositoryCandidateGroupKey,
} from './repositoryCandidateInputLogic';

interface RepositoryCandidateInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Fired only when the operator picks a candidate from the dropdown (never for free-hand typing). */
  onSelectCandidate: (candidate: RepositoryCandidate) => void;
  placeholder?: string;
  /** Accessible name for the combobox + its listbox (this input has no associated <label for>, matching FormField's existing labels — see FormField.tsx). */
  ariaLabel: string;
  style?: React.CSSProperties;
}

const DEBOUNCE_MS = 300;

/**
 * URL input with repository-candidate suggestions for the project wizard's
 * "clone a repository" step (`GET /api/repository-candidates`). Mirrors
 * `DirectoryInput`'s structure/keyboard handling/debounce so the two
 * inputs feel identical, but layers on combobox ARIA semantics (this is a
 * new component, not a retrofit of DirectoryInput, so the improvement is
 * not a deviation from an existing convention) and never blocks free-hand
 * entry of a URL that matches no candidate (e.g. someone else's private repo).
 */
export default function RepositoryCandidateInput({ value, onChange, onSelectCandidate, placeholder, ariaLabel, style }: RepositoryCandidateInputProps) {
  const { t } = useTranslation('projects');
  const [result, setResult] = useState<RepositoryCandidatesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const blurRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hasFocusRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const guardRef = useRef(createRequestGuard());
  const listboxId = useId();

  const groups = result ? groupRepositoryCandidates(result.candidates) : [];
  const flatCandidates = groups.flatMap((g) => g.candidates);

  const fetchCandidates = useCallback(async (query: string, requestId: number) => {
    setLoading(true);
    try {
      const data = await fetchCandidatesGuarded(
        query,
        requestId,
        guardRef.current,
        (q) => api<RepositoryCandidatesResult>(`/repository-candidates?q=${encodeURIComponent(q)}`),
      );
      if (data === null) return; // superseded by a later request
      setResult(data);
      setHighlightIdx(0);
      if (hasFocusRef.current) setOpen(true);
    } catch {
      if (!guardRef.current.isCurrent(requestId)) return;
      setResult(null);
      setOpen(false);
    } finally {
      if (guardRef.current.isCurrent(requestId)) setLoading(false);
    }
  }, []);

  /**
   * Advances the request guard synchronously (before the debounce delay),
   * clearing/closing any stale candidates from a superseded query
   * immediately. Fixes a bug where editing the input right after opening
   * the dropdown left the *previous* query's candidates open and
   * selectable until the 300ms debounce fired — pressing Enter in that
   * window replaced the just-typed URL with a stale candidate, and a
   * slow in-flight response for the old query could still be adopted as
   * "latest". The request id is captured here and threaded through to the
   * delayed fetch so `fetchCandidatesGuarded` compares against the id that
   * was current at edit time, not at debounce-fire time.
   */
  const debouncedFetch = useCallback((query: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const { requestId, result, open } = beginCandidateEditRequest(guardRef.current, hasFocusRef.current);
    setResult(result);
    setOpen(open);
    debounceRef.current = setTimeout(() => fetchCandidates(query, requestId), DEBOUNCE_MS);
  }, [fetchCandidates]);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const selectCandidate = useCallback((candidate: RepositoryCandidate) => {
    onChange(candidate.httpsUrl);
    onSelectCandidate(candidate);
    setOpen(false);
  }, [onChange, onSelectCandidate]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);
    debouncedFetch(newValue);
  }, [onChange, debouncedFetch]);

  const scrollToItem = (idx: number) => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[role="option"]');
    const el = items[idx];
    if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  };

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      if (flatCandidates.length === 0) return;
      e.preventDefault();
      setHighlightIdx((prev) => {
        const next = Math.min(prev + 1, flatCandidates.length - 1);
        scrollToItem(next);
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      if (flatCandidates.length === 0) return;
      e.preventDefault();
      setHighlightIdx((prev) => {
        const next = Math.max(prev - 1, 0);
        scrollToItem(next);
        return next;
      });
    } else if (e.key === 'Enter') {
      if (flatCandidates.length > 0 && flatCandidates[highlightIdx]) {
        e.preventDefault();
        selectCandidate(flatCandidates[highlightIdx]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }, [open, flatCandidates, highlightIdx, selectCandidate]);

  const handleBlur = useCallback(() => {
    hasFocusRef.current = false;
    blurRef.current = setTimeout(() => setOpen(false), 200);
  }, []);

  const handleFocus = useCallback(() => {
    hasFocusRef.current = true;
    if (blurRef.current) clearTimeout(blurRef.current);
    if (result) setOpen(true);
    else debouncedFetch(value);
  }, [result, value, debouncedFetch]);

  const groupLabel = (key: RepositoryCandidateGroupKey): string => {
    if (key === 'registered') return t('wizard.code.repoCandidates.groupRegistered');
    if (key === 'github') return t('wizard.code.repoCandidates.groupGithub');
    if (key === 'gitlab') return t('wizard.code.repoCandidates.groupGitlab');
    return t('wizard.code.repoCandidates.groupOther');
  };

  const activeOptionId = open && flatCandidates.length > 0 ? `${listboxId}-opt-${highlightIdx}` : undefined;

  return (
    <div style={{ position: 'relative' }}>
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        aria-label={ariaLabel}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onFocus={handleFocus}
        placeholder={placeholder}
        style={{ ...baseInputStyle, ...style }}
        autoComplete="off"
      />
      {open && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
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
            maxHeight: 320,
            overflowY: 'auto',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          {loading && !result && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
              <Spinner size={13} trackColor="var(--accent-a35)" />
              {t('wizard.code.repoCandidates.loading')}
            </div>
          )}

          {!loading && result && result.providerErrors.map((pe) => (
            <div
              key={pe.provider}
              role="alert"
              style={{ padding: '8px 12px', fontSize: 'var(--font-xs)', color: 'var(--danger)', background: 'var(--danger-a08)' }}
            >
              {t('wizard.code.repoCandidates.providerError', { provider: groupLabel(pe.provider), message: pe.message })}
            </div>
          ))}

          {!loading && result && result.candidates.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
              {t('wizard.code.repoCandidates.empty')}
            </div>
          )}

          {!loading && result && groups.map((group) => {
            const headingId = `${listboxId}-group-${group.groupKey}`;
            return (
              <div key={group.groupKey} role="group" aria-labelledby={headingId}>
                <div
                  id={headingId}
                  style={{
                    padding: '6px 12px 2px', fontSize: 'var(--font-2xs)', fontWeight: 600, letterSpacing: '0.03em',
                    color: 'var(--text-dim)', textTransform: 'uppercase',
                  }}
                >
                  {groupLabel(group.groupKey)}
                </div>
                {group.candidates.map((candidate) => {
                  const idx = flatCandidates.indexOf(candidate);
                  const label = candidate.owner && candidate.repoName ? `${candidate.owner}/${candidate.repoName}` : candidate.httpsUrl;
                  return (
                    <div
                      key={`${group.groupKey}:${candidate.httpsUrl}`}
                      id={`${listboxId}-opt-${idx}`}
                      role="option"
                      aria-selected={idx === highlightIdx}
                      onMouseDown={(e) => { e.preventDefault(); selectCandidate(candidate); }}
                      onMouseEnter={() => setHighlightIdx(idx)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 12px',
                        fontSize: 'var(--font-md)',
                        cursor: 'pointer',
                        background: idx === highlightIdx ? 'var(--accent-a15)' : 'transparent',
                        color: 'var(--text)',
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                      {candidate.private && <Badge tone="orange">{t('wizard.code.repoCandidates.privateBadge')}</Badge>}
                      {/*
                        Review finding (Issue #87 review round 2, Important finding 3): a
                        "資格情報あり" chip used to render here whenever `candidate.hasToken`
                        was true, implying selecting this candidate carries its token over.
                        But `hasToken` only means SOME project (searched across all projects)
                        has a token for this URL — in 'create' mode `existingRepositories` is
                        always empty (the project doesn't exist yet), so the match is always a
                        DIFFERENT project, and tokens are intentionally not copied across
                        projects (Issue #28/#29 credential separation). Selecting such a
                        candidate still required a fresh token below, so the chip was actively
                        misleading. The accurate, scope-correct signal already exists — see
                        `CodeStep`'s `repoReusedBadge`/`repoReusedHint`, driven by
                        `reusableRepo` (scoped to the CURRENT project's own
                        `existingRepositories`) — so no replacement chip is added here.
                        Cross-project credential reuse (copying/duplicating a token
                        server-side into the new project) is a real future option but is out
                        of scope for this fix.
                      */}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {!loading && result && result.truncated && (
            <div style={{ padding: '8px 12px', fontSize: 'var(--font-xs)', color: 'var(--text-dim)', borderTop: '1px solid var(--border)' }}>
              {t('wizard.code.repoCandidates.truncated')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
