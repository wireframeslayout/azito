import { useState, useCallback } from 'react';
import { FormInput, FormSelect, Button } from '../ui';
import FormField from '../FormField';
import { useTranslation } from 'react-i18next';
import type { Task, Unit } from '../../pages/workspace/types';
import { useToast } from '../../hooks/useToast';

interface TaskUnitSetupFormProps {
  task: Task;
  allUnits: Unit[];
  /** The project's default Unit, pre-selected when set (Issue #263 Refine C). */
  defaultUnitId?: number | null;
  onAssignAndExecute: (unitId: number, settings: {
    branchName?: string;
    skipPr?: boolean;
    workingDirectory?: string;
  }) => void;
}

export default function TaskUnitSetupForm({
  task, allUnits, defaultUnitId, onAssignAndExecute,
}: TaskUnitSetupFormProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { showToast } = useToast();
  const [selectedUnitId, setSelectedUnitId] = useState(defaultUnitId ? String(defaultUnitId) : '');
  const projectDefaultUnit = defaultUnitId != null ? allUnits.find((u) => u.id === defaultUnitId) : undefined;
  const [branchName, setBranchName] = useState(task.branch || '');
  const [skipPr, setSkipPr] = useState(task.skipPr ?? false);
  const [workingDirectory, setWorkingDirectory] = useState(task.workingDirectory || '');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!selectedUnitId || submitting) return;
    setSubmitting(true);
    try {
      await onAssignAndExecute(parseInt(selectedUnitId, 10), {
        branchName: branchName || undefined,
        skipPr,
        workingDirectory: workingDirectory || undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('unitSetup.assignFailed');
      showToast(msg);
    } finally {
      setSubmitting(false);
    }
  }, [selectedUnitId, branchName, skipPr, workingDirectory, submitting, onAssignAndExecute]);

  return (
    <div style={{
      height: '100%', overflowY: 'auto', display: 'flex',
      alignItems: 'flex-start', justifyContent: 'center', padding: '32px 24px',
    }}>
      <div style={{ width: '100%', maxWidth: 480 }}>
        <div style={{
          fontSize: 'var(--font-base)', fontWeight: 600, marginBottom: 24,
          color: 'var(--text)',
        }}>
          {t('unitSetup.assignUnit')}
        </div>

        <FormField
          label={t('unitSetup.unit')}
          hint={
            selectedUnitId && selectedUnitId === String(defaultUnitId ?? '')
              ? t('unitSetup.projectDefaultHint')
              : undefined
          }
        >
          <FormSelect
            value={selectedUnitId}
            onChange={(e) => setSelectedUnitId(e.target.value)}
          >
            <option value="">{t('unitSetup.selectUnit')}</option>
            {allUnits.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}{defaultUnitId === u.id ? t('unitSetup.projectDefaultSuffix') : ''}
              </option>
            ))}
          </FormSelect>
        </FormField>
        {!selectedUnitId && !projectDefaultUnit && (
          <div role="alert" style={{ fontSize: 'var(--font-sm)', color: 'var(--warning)', marginTop: -8, marginBottom: 14, lineHeight: 1.4 }}>
            {t('unitSetup.noUnitWarning')}
          </div>
        )}

        <FormField label={t('unitSetup.branchName')} hint={t('unitSetup.branchHint')}>
          <FormInput
            type="text"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder={t('unitSetup.branchPlaceholder')}
          />
        </FormField>

        <FormField label={t('common:labels.options')}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-md)', cursor: 'pointer' }}>
            <label className="toggle">
              <input type="checkbox" checked={skipPr} onChange={(e) => setSkipPr(e.target.checked)} />
              <span className="toggle-slider" />
            </label>
            {t('unitSetup.skipPr')}
          </label>
        </FormField>

        <FormField label={t('unitSetup.workingDirectory')} hint={t('unitSetup.workingDirectoryHint')}>
          <FormInput
            type="text"
            value={workingDirectory}
            onChange={(e) => setWorkingDirectory(e.target.value)}
            placeholder={t('unitSetup.workingDirectoryPlaceholder')}
          />
        </FormField>

        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={!selectedUnitId}
          loading={submitting}
          loadingLabel={t('unitSetup.assigning')}
          style={{ width: '100%', padding: '10px 16px', fontSize: 'var(--font-base)', marginTop: 8 }}
        >
          {t('unitSetup.assignAndExecute')}
        </Button>
      </div>
    </div>
  );
}
