import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../hooks/useApi';
import { useUnitTypes, findUnitType } from '../hooks/useUnitTypes';
import ProviderSection from '../components/settings/ProviderSection';
import { LoadingState, EmptyState, ListRow, ListRowGroup, Chip, PageContainer, PageHeader, PageBody } from '../components/ui';
import { summarizePhaseConfig, getPhaseLabel, type PhaseConfigEntryLike } from '../lib/taskPhases';
import type { RunningOperation } from './workspace/types';

interface Unit {
  id: number; name: string; unitType: string; systemPrompt?: string; selfReviewMaxAttempts?: number;
  phaseConfig?: Record<string, PhaseConfigEntryLike> | null;
  workerType?: string | null; workerModel?: string | null;
}

interface UnitsProps {
  onOpenUnit: (unitId: number, name: string) => void;
  onCreate: () => void;
}

export default function Units({ onOpenUnit, onCreate }: UnitsProps) {
  const { t } = useTranslation(['units', 'common']);
  const { data: unitsList, loading } = useApi<Unit[]>('/units');
  const { data: runningList } = useApi<RunningOperation[]>('/operations');
  const { unitTypes } = useUnitTypes();
  const [providersOpen, setProvidersOpen] = useState(false);

  if (loading) return <LoadingState />;

  return (
    <PageContainer style={{ height: undefined, overflowY: undefined, padding: 0 }}>
      <PageHeader
        title={t('title')}
        count={unitsList?.length}
        primaryAction={{ label: t('list.newUnit'), shortLabel: t('list.newUnitShort'), onClick: onCreate }}
        secondaryActions={[
          { label: t('list.providers'), onClick: () => setProvidersOpen(true) },
        ]}
      />
      <ProviderSection layout="modal" open={providersOpen} onClose={() => setProvidersOpen(false)} />
      <PageBody>
      {!unitsList?.length ? (
        <EmptyState title={t('list.noUnits')} description={t('list.noUnitsDescription')} />
      ) : (
        <ListRowGroup>
          {unitsList.map((s) => {
            const ut = findUnitType(unitTypes, s.unitType);
            const phases = ut?.phases ?? [];
            const { disabledPhases, customizedPhases } = summarizePhaseConfig(s.phaseConfig, phases);
            const running = (runningList || []).filter((r) => r.unitId === s.id).length;
            const kicker = [
              s.workerType ? `${s.workerType}${s.workerModel ? ` / ${s.workerModel}` : ''}` : null,
            ].filter(Boolean).join(' · ');
            const description = [kicker, s.systemPrompt].filter(Boolean).join(' — ');
            return (
              <ListRow
                key={s.id}
                onClick={() => onOpenUnit(s.id, s.name)}
                ariaLabel={s.name}
                icon={<span style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>{s.name.slice(0, 2).toUpperCase()}</span>}
                title={s.name}
                description={description || undefined}
                chips={
                  <>
                    {running > 0 && <Chip tone="orange">{t('list.running', { count: running })}</Chip>}
                    <Chip>{t('list.selfReview', { count: s.selfReviewMaxAttempts ?? 2 })}</Chip>
                    {disabledPhases.map((p) => (
                      <Chip key={`disabled-${p}`} tone="red">{t('list.phaseOff', { phase: getPhaseLabel(phases, p) })}</Chip>
                    ))}
                    {customizedPhases.map((p) => (
                      <Chip key={`custom-${p}`} tone="purple">{t('list.phaseCustom', { phase: getPhaseLabel(phases, p) })}</Chip>
                    ))}
                  </>
                }
              />
            );
          })}
        </ListRowGroup>
      )}
      </PageBody>
    </PageContainer>
  );
}
