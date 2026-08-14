import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chip } from '../ui/Chip';
import { Icon } from '../ui/Icon';

export interface SearchHitItem {
  path: string;
  line: number;
  column: number;
  text: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchResultGroup {
  path: string;
  isNameMatch: boolean;
  hits: SearchHitItem[];
}

interface SearchResultListProps {
  groups: SearchResultGroup[];
  engine: 'rg' | 'grep';
  truncated: boolean;
  elapsedMs: number;
  totalFiles: number;
  totalHits: number;
  activeHit?: { path: string; line: number };
  onSelect: (path: string, line: number) => void;
}

function HighlightedText({ text, matchStart, matchEnd }: { text: string; matchStart: number; matchEnd: number }) {
  if (matchStart >= matchEnd || matchStart < 0 || matchEnd > text.length) {
    return <span>{text}</span>;
  }
  return (
    <span>
      {text.slice(0, matchStart)}
      <span style={{ background: 'var(--accent-a35)', borderRadius: 2 }}>
        {text.slice(matchStart, matchEnd)}
      </span>
      {text.slice(matchEnd)}
    </span>
  );
}

export function SearchResultList({
  groups,
  engine,
  truncated,
  elapsedMs,
  totalFiles,
  totalHits,
  activeHit,
  onSelect,
}: SearchResultListProps) {
  const { t } = useTranslation('files');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggleCollapse = (path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-sm)' }}>
      {/* Summary */}
      <div style={{
        padding: '6px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color: 'var(--text-dim)',
        fontSize: 'var(--font-xs)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <span>{t('search.summary', { files: totalFiles, hits: totalHits, engine, time: elapsedMs })}</span>
        <Chip tone="default" style={{ marginLeft: 'auto' }}>{engine}</Chip>
      </div>

      {/* Truncation warning */}
      {truncated && (
        <div style={{
          padding: '6px 12px',
          fontSize: 'var(--font-xs)',
          color: 'var(--warning)',
          background: 'var(--warning-a08)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          {t('search.truncated')}
        </div>
      )}

      {/* Groups */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {groups.map(group => {
          const isCollapsed = collapsed.has(group.path);
          return (
            <div key={`${group.path}:${group.isNameMatch ? 'name' : 'content'}`}>
              {/* Group header */}
              <button
                onClick={() => toggleCollapse(group.path)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px 4px 4px',
                  background: 'var(--bg-card)',
                  border: 'none',
                  borderBottom: '1px solid var(--border)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  fontSize: 'var(--font-xs)',
                  textAlign: 'left',
                  fontWeight: 500,
                }}
              >
                <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                <Icon name="file" size={14} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {group.path}
                </span>
                {group.isNameMatch && (
                  <Chip tone="accent" style={{ fontSize: 'var(--font-xxs)' }}>{t('search.nameMatch')}</Chip>
                )}
                {!group.isNameMatch && (
                  <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>{group.hits.length}</span>
                )}
              </button>

              {/* Hits */}
              {!isCollapsed && group.hits.map((hit, i) => {
                const isActive = activeHit?.path === hit.path && activeHit?.line === hit.line;
                return (
                  <button
                    key={`${hit.line}:${i}`}
                    onClick={() => onSelect(hit.path, hit.line)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      padding: '2px 12px 2px 24px',
                      background: isActive ? 'var(--accent-a15)' : 'transparent',
                      border: 'none',
                      borderBottom: '1px solid var(--hairline)',
                      color: 'var(--text)',
                      cursor: 'pointer',
                      fontSize: 'var(--font-xs)',
                      textAlign: 'left',
                      fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'Consolas', monospace",
                      lineHeight: 1.6,
                    }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ color: 'var(--text-dim)', opacity: 0.6, minWidth: 32, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                      {hit.line}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      <HighlightedText text={hit.text} matchStart={hit.matchStart} matchEnd={hit.matchEnd} />
                    </span>
                  </button>
                );
              })}

              {/* Name-only match: clickable row */}
              {!isCollapsed && group.isNameMatch && group.hits.length === 0 && (
                <button
                  onClick={() => onSelect(group.path, 1)}
                  style={{
                    width: '100%',
                    padding: '4px 12px 4px 24px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--hairline)',
                    color: 'var(--text-dim)',
                    cursor: 'pointer',
                    fontSize: 'var(--font-xs)',
                    textAlign: 'left',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {group.path}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
