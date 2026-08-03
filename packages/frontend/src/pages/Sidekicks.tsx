import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../hooks/useApi';
import { useUnitTypes } from '../hooks/useUnitTypes';
import { LoadingState, EmptyState, ListRow, ListRowGroup, Chip, PageContainer, PageHeader, PageBody } from '../components/ui';
import { groupSidekicksByPhase, collectAllTags, type SidekickMeta } from '../lib/sidekicks';

interface SidekicksProps {
  onOpenSidekick: (name: string) => void;
  onCreate: () => void;
}

export default function Sidekicks({ onOpenSidekick, onCreate }: SidekicksProps) {
  const { data: sidekicks, loading, error } = useApi<SidekickMeta[]>('/sidekicks');
  const { unitTypes } = useUnitTypes();
  const { t } = useTranslation(['sidekicks', 'common']);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const allPhaseNames = useMemo(
    () => [...new Set(unitTypes.flatMap((ut) => ut.phases.map((p) => p.name)))],
    [unitTypes],
  );
  const allPhases = useMemo(
    () => {
      const seen = new Set<string>();
      const result: Array<{ name: string; label: string }> = [];
      for (const ut of unitTypes) {
        for (const p of ut.phases) {
          if (!seen.has(p.name)) {
            seen.add(p.name);
            result.push({ name: p.name, label: p.label });
          }
        }
      }
      return result;
    },
    [unitTypes],
  );

  const isPhaseTag = (tag: string) => allPhaseNames.includes(tag);

  const allTags = useMemo(() => collectAllTags(sidekicks ?? [], allPhaseNames), [sidekicks, allPhaseNames]);
  const filtered = useMemo(
    () => (activeTag ? (sidekicks ?? []).filter((s) => s.tags.includes(activeTag)) : (sidekicks ?? [])),
    [sidekicks, activeTag],
  );
  const groups = useMemo(() => groupSidekicksByPhase(filtered, allPhases), [filtered, allPhases]);

  if (loading) return <LoadingState />;

  if (error) {
    return (
      <PageContainer style={{ height: undefined, overflowY: undefined, padding: 0 }}>
        <PageHeader title={t('title')} />
        <PageBody>
          <div role="alert" style={{
            padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--danger-a15)', border: '1px solid var(--danger-a35)',
            color: 'var(--danger)', fontSize: 'var(--font-md)',
          }}>
            {t('list.loadFailed', { error })}
          </div>
        </PageBody>
      </PageContainer>
    );
  }

  return (
    <PageContainer style={{ padding: 0 }}>
      <PageHeader
        title={t('title')}
        count={sidekicks?.length}
        primaryAction={{ label: t('list.newSidekick'), shortLabel: t('list.newSidekickShort'), onClick: onCreate }}
      />
      <PageBody>
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginBottom: 16, maxWidth: 720, lineHeight: 1.5 }}>
        {t('list.description')}
      </p>

      {allTags.length > 0 && (
        <div
          role="group"
          aria-label={t('list.filterByTag')}
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 20 }}
        >
          {allTags.map((tag) => {
            const active = tag === activeTag;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(active ? null : tag)}
                aria-pressed={active}
                style={{
                  fontSize: 'var(--font-sm)', fontWeight: 500, cursor: 'pointer',
                  borderRadius: 'var(--radius-sm)', padding: '3px 10px',
                  color: active ? '#fff' : (isPhaseTag(tag) ? 'var(--accent)' : 'var(--text-dim)'), // lint-allow: hex - white text on solid accent fill; no on-color token yet
                  background: active ? 'var(--accent)' : (isPhaseTag(tag) ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'var(--bg-card)'),
                  border: `1px solid ${active ? 'var(--accent)' : (isPhaseTag(tag) ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border)')}`,
                }}
              >
                {tag}
              </button>
            );
          })}
          {activeTag && (
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: '3px 4px' }}
            >
              {t('list.clearFilter')}
            </button>
          )}
        </div>
      )}

      {!sidekicks?.length ? (
        <EmptyState title={t('list.noSidekicks')} description={t('list.noSidekicksDescription')} />
      ) : !filtered.length ? (
        <EmptyState title={t('list.noSidekicksMatch')} description={t('list.noSidekicksMatchDescription')} />
      ) : (
        groups.map(({ label, items }) => (
          <section key={label} style={{ marginBottom: 28 }}>
            <h2 style={{
              fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text-dim)',
              textTransform: 'uppercase', letterSpacing: 0.5,
              margin: '0 0 12px', paddingBottom: 8, borderBottom: '1px solid var(--border)',
            }}>
              {label}
            </h2>
            <ListRowGroup>
              {items.map((s) => (
                <ListRow
                  key={`${label}-${s.name}`}
                  onClick={() => onOpenSidekick(s.name)}
                  ariaLabel={s.name}
                  icon={<span style={{ fontSize: 'var(--font-xs)', fontWeight: 600, fontFamily: 'monospace' }}>{s.name.slice(0, 2).toUpperCase()}</span>}
                  title={<span style={{ fontFamily: 'monospace' }}>{s.name}</span>}
                  description={s.description}
                  chips={
                    <>
                      <Chip>{s.layer === 'builtin' ? t('list.builtIn') : t('list.custom')}</Chip>
                      {s.isDefault && <Chip tone="green">{t('list.default')}</Chip>}
                      {s.overridesBuiltin && <Chip tone="orange">{t('list.overridden')}</Chip>}
                      {s.hasScripts && <Chip tone="purple">{t('list.scripts')}</Chip>}
                      {s.tags.map((tag) => (
                        <Chip key={tag} tone={isPhaseTag(tag) ? 'accent' : 'default'}>{tag}</Chip>
                      ))}
                    </>
                  }
                />
              ))}
            </ListRowGroup>
          </section>
        ))
      )}
      </PageBody>
    </PageContainer>
  );
}
