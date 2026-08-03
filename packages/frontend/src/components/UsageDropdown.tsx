import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { LoadingState } from './ui';
import { Icon } from './ui/Icon';

interface ClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

interface ClaudeUsage extends ClaudeModelUsage {
  byModel: Record<string, ClaudeModelUsage>;
}

interface CodexRateLimits {
  primary?: { usedPercent: number };
  secondary?: { usedPercent: number };
  planType?: string;
}

interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  rateLimits?: CodexRateLimits;
}

// サーバー側は `/api/agents` に登録されたエージェント種別ごとに使用量を返す
// (Record<string, unknown>)。現状トークン使用量を計測できるのは claude/codex のみ。
type UsageResponse = Record<string, unknown>;

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function TokenRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
      <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>{label}</span>
      <span style={{ color: 'var(--text)', fontSize: 'var(--font-sm)', fontVariantNumeric: 'tabular-nums' }}>
        {formatTokens(value)}
      </span>
    </div>
  );
}

function SectionHeader({ title, color }: { title: string; color: string }) {
  return (
    <div style={{
      fontSize: 'var(--font-xs)', fontWeight: 600, color, textTransform: 'uppercase' as const,
      letterSpacing: '0.05em', marginBottom: 4, paddingBottom: 4,
      borderBottom: '1px solid var(--border)',
    }}>
      {title}
    </div>
  );
}

function ClaudeSection({ usage }: { usage: ClaudeUsage }) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const models = Object.entries(usage.byModel);

  return (
    <div style={{ padding: '8px 12px' }}>
      <SectionHeader title="Claude Code" color="var(--accent)" />
      <TokenRow label={t('usage.input')} value={usage.inputTokens} />
      <TokenRow label={t('usage.output')} value={usage.outputTokens} />
      <TokenRow label={t('usage.cacheRead')} value={usage.cacheReadTokens} />
      <TokenRow label={t('usage.cacheWrite')} value={usage.cacheCreationTokens} />
      <div style={{
        display: 'flex', justifyContent: 'space-between', padding: '4px 0',
        borderTop: '1px solid var(--border)', marginTop: 4,
      }}>
        <span style={{ color: 'var(--text)', fontSize: 'var(--font-sm)', fontWeight: 600 }}>{t('usage.total')}</span>
        <span style={{ color: 'var(--text)', fontSize: 'var(--font-sm)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {formatTokens(usage.totalTokens)}
        </span>
      </div>
      {models.length > 0 && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            background: 'none', border: 'none', color: 'var(--text-dim)',
            fontSize: 'var(--font-xs)', cursor: 'pointer', padding: '4px 0 0', width: '100%', textAlign: 'left',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="chevron-right" size={14} rotate={expanded ? 90 : 0} />
            {t('usage.models', { count: models.length })}
          </span>
        </button>
      )}
      {expanded && models.map(([model, mu]) => (
        <div key={model} style={{ paddingLeft: 8, marginTop: 4 }}>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--purple)', marginBottom: 2 }}>{model}</div>
          <TokenRow label={t('usage.inOut')} value={mu.inputTokens + mu.outputTokens} />
        </div>
      ))}
    </div>
  );
}

function CodexSection({ usage }: { usage: CodexUsage }) {
  const { t } = useTranslation('common');
  return (
    <div style={{ padding: '8px 12px' }}>
      <SectionHeader title="Codex" color="var(--success)" />
      <TokenRow label={t('usage.input')} value={usage.inputTokens} />
      <TokenRow label={t('usage.cachedInput')} value={usage.cachedInputTokens} />
      <TokenRow label={t('usage.output')} value={usage.outputTokens} />
      <TokenRow label={t('usage.reasoning')} value={usage.reasoningOutputTokens} />
      <div style={{
        display: 'flex', justifyContent: 'space-between', padding: '4px 0',
        borderTop: '1px solid var(--border)', marginTop: 4,
      }}>
        <span style={{ color: 'var(--text)', fontSize: 'var(--font-sm)', fontWeight: 600 }}>{t('usage.total')}</span>
        <span style={{ color: 'var(--text)', fontSize: 'var(--font-sm)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {formatTokens(usage.totalTokens)}
        </span>
      </div>
      {usage.rateLimits?.primary && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginBottom: 4 }}>Rate Limit (5h)</div>
          <div style={{
            height: 4, borderRadius: 'var(--radius-sm)', background: 'var(--bg)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', borderRadius: 'var(--radius-sm)',
              width: `${Math.min(usage.rateLimits.primary.usedPercent, 100)}%`,
              background: usage.rateLimits.primary.usedPercent > 80 ? 'var(--warning)' : 'var(--success)',
              transition: 'width 0.3s ease',
            }} />
          </div>
          <div style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', marginTop: 2, textAlign: 'right' }}>
            {usage.rateLimits.primary.usedPercent.toFixed(1)}%
          </div>
        </div>
      )}
    </div>
  );
}

function EmptySection({ title }: { title: string }) {
  const { t } = useTranslation('common');
  return (
    <div style={{ padding: '8px 12px' }}>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{title}: {t('usage.notMeasured')}</div>
    </div>
  );
}

interface UsageDropdownProps {
  /** パネルをトリガーのどちら基準で開くか。'right' = 右端基準（従来のヘッダー用途）、'left' = 左端基準（左側サイドバー等の埋め込み用途） */
  align?: 'right' | 'left';
}

export default function UsageDropdown({ align = 'right' }: UsageDropdownProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    api<UsageResponse>('/usage')
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open]);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      if (align === 'left') {
        const panelWidth = 260;
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - panelWidth - 8);
        setPanelPos({ top: rect.bottom + 4, left });
      } else {
        setPanelPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
      }
    }
    setOpen(!open);
  };

  const claudeUsage = data?.['claude'] as ClaudeUsage | undefined;
  const codexUsage = data?.['codex'] as CodexUsage | undefined;
  const totalTokens = (claudeUsage?.totalTokens ?? 0) + (codexUsage?.totalTokens ?? 0);

  return (
    <div ref={ref}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={t('usage.ariaLabel')}
        className="icon-btn"
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px',
          border: '1px solid var(--border)', background: open ? 'var(--bg)' : 'transparent',
          color: 'var(--text-dim)', cursor: 'pointer', fontSize: 'var(--font-sm)', whiteSpace: 'nowrap',
        }}
      >
        <Icon name="chip" size={14} />
        {data && totalTokens > 0 && (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatTokens(totalTokens)}</span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'fixed', top: panelPos.top,
            ...(panelPos.left !== undefined ? { left: panelPos.left } : { right: panelPos.right }),
            zIndex: 300,
            minWidth: 'min(260px, calc(100vw - 16px))', maxWidth: 'min(320px, calc(100vw - 16px))', borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            overflow: 'hidden',
          }}
        >
          <div style={{
            padding: '8px 12px', borderBottom: '1px solid var(--border)',
            fontSize: 'var(--font-xs)', color: 'var(--text-dim)',
          }}>
            {t('usage.title')}
          </div>

          {loading && <LoadingState />}

          {error && (
            <div style={{ padding: '12px', color: 'var(--danger)', fontSize: 'var(--font-sm)' }}>
              {error}
            </div>
          )}

          {!loading && !error && data && (
            <>
              {claudeUsage ? <ClaudeSection usage={claudeUsage} /> : <EmptySection title="Claude Code" />}
              <div style={{ borderTop: '1px solid var(--border)' }} />
              {codexUsage ? <CodexSection usage={codexUsage} /> : <EmptySection title="Codex" />}
            </>
          )}

          {!loading && !error && !data && (
            <div style={{ padding: '16px 12px', textAlign: 'center' }}>
              <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>{t('usage.notMeasured')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
