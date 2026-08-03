import FormField from './FormField';
import { useTranslation } from 'react-i18next';
import { FormInput, FormTextarea, FormSelect, SubagentConfigCard } from './ui';
import BranchInput from './BranchInput';
import DirectoryInput from './DirectoryInput';
import type { TaskFormValue } from '../lib/taskForm';

interface TaskFormFieldsProps {
  value: TaskFormValue;
  onChange: (next: TaskFormValue) => void;
  mode: 'create' | 'edit';
  projects?: { id: number; name: string }[];
  units: {
    id: number; name: string; workerType?: string | null;
    reviewSubagent?: { enabled: boolean; provider: string; model: string } | null;
    implementSubagent?: { enabled: boolean; provider: string; model: string } | null;
  }[];
  showAdvanced?: boolean;
  projectId?: number;
  descriptionRows?: number;
  projectServers?: { serverName: string; workingDirectory: string | null }[];
  /** プロジェクトのデフォルト Unit。未選択（空文字）のとき、これが使われる旨を表示する。 */
  defaultUnitId?: number | null;
}

function set<K extends keyof TaskFormValue>(
  v: TaskFormValue,
  key: K,
  val: TaskFormValue[K],
  onChange: (next: TaskFormValue) => void,
) {
  onChange({ ...v, [key]: val });
}

const STATUS_KEY_MAP: Record<string, string> = {
  waiting_input: 'waitingInput',
  phase_review: 'phaseReview',
  in_progress: 'inProgress',
};

export default function TaskFormFields({ value, onChange, mode, projects, units, showAdvanced, projectId: projectIdProp, descriptionRows = 4, projectServers, defaultUnitId }: TaskFormFieldsProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const selectedUnit = units.find((s) => String(s.id) === value.unitId);
  const serverName = value.serverName || '';
  const projectId = projectIdProp ?? parseInt(value.projectId, 10);
  const projectDefaultUnit = defaultUnitId != null
    ? units.find((u) => u.id === defaultUnitId)
    : undefined;

  return (
    <>
      {projects !== undefined && (
        <FormField label={t('fields.project')}>
          <FormSelect value={value.projectId} onChange={(e) => set(value, 'projectId', e.target.value, onChange)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </FormSelect>
        </FormField>
      )}

      <FormField label={t('fields.title')}>
        <FormInput
          value={value.title}
          onChange={(e) => set(value, 'title', e.target.value, onChange)}
          placeholder={t('fields.titlePlaceholder')}
        />
      </FormField>

      <FormField label={t('fields.description')}>
        <FormTextarea
          value={value.description}
          onChange={(e) => set(value, 'description', e.target.value, onChange)}
          rows={descriptionRows}
          placeholder={t('fields.descriptionPlaceholder')}
          style={{ resize: 'vertical', minHeight: 60 }}
        />
      </FormField>

      {projectServers && projectServers.length > 1 && (
        <FormField label={t('fields.serverEnvironment')} hint={t('fields.serverHintMultiple')}>
          <FormSelect value={value.serverName} onChange={(e) => set(value, 'serverName', e.target.value, onChange)} aria-required>
            <option value="" disabled>{t('fields.selectServer')}</option>
            {projectServers.map((ps) => <option key={ps.serverName} value={ps.serverName}>{ps.serverName}</option>)}
          </FormSelect>
        </FormField>
      )}

      {projectServers && projectServers.length === 1 && (
        <FormField label={t('fields.serverEnvironment')}>
          <div style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', padding: '6px 0' }}>{projectServers[0].serverName}</div>
        </FormField>
      )}

      <FormField
        label={t('fields.assignToUnit')}
        hint={
          value.unitId
            ? (value.unitId === String(defaultUnitId ?? '') ? t('fields.projectDefaultHint') : undefined)
            : (projectDefaultUnit ? t('fields.usesProjectDefault', { name: projectDefaultUnit.name }) : undefined)
        }
      >
        <FormSelect value={value.unitId} onChange={(e) => set(value, 'unitId', e.target.value, onChange)}>
          <option value="">{projectDefaultUnit ? t('fields.projectDefault', { name: projectDefaultUnit.name }) : t('fields.unitNone')}</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}{defaultUnitId === u.id ? t('fields.unitProjectDefaultSuffix') : ''}
            </option>
          ))}
        </FormSelect>
      </FormField>
      {!value.unitId && !projectDefaultUnit && (
        <div role="alert" style={{
          fontSize: 'var(--font-sm)', color: 'var(--warning)', marginTop: -10, marginBottom: 14, lineHeight: 1.4,
        }}>
          {t('fields.noUnitWarning')}
        </div>
      )}

      {serverName && (
        <FormField label={t('fields.workingDirectory')} hint={t('fields.workingDirectoryHint')}>
          <DirectoryInput
            value={value.workingDirectory}
            onChange={(v) => set(value, 'workingDirectory', v, onChange)}
            serverName={serverName}
            placeholder={t('fields.workingDirectoryPlaceholder')}
          />
        </FormField>
      )}

      {mode === 'edit' && (
        <FormField label={t('common:labels.status')}>
          <FormSelect value={value.status} onChange={(e) => set(value, 'status', e.target.value, onChange)}>
            {['open', 'in_progress', 'done', 'failed'].map((s) => {
              const key = STATUS_KEY_MAP[s] ?? s;
              return <option key={s} value={s}>{t(`common:status.${key}`)}</option>;
            })}
          </FormSelect>
        </FormField>
      )}

      {showAdvanced && (
        <>
          <FormField label={t('fields.selfReviewMax')}>
            <FormSelect value={value.selfReviewMax} onChange={(e) => set(value, 'selfReviewMax', e.target.value, onChange)}>
              <option value="0">{t('fields.selfReviewSkip')}</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </FormSelect>
          </FormField>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <input
              type="checkbox"
              id="task-require-plan-approval"
              checked={value.requirePlanApproval}
              onChange={(e) => set(value, 'requirePlanApproval', e.target.checked, onChange)}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            <label htmlFor="task-require-plan-approval" style={{ fontSize: 'var(--font-md)', cursor: 'pointer', color: 'var(--text)' }}>
              {t('fields.requirePlanApproval')}
            </label>
          </div>
        </>
      )}

      <FormField label={t('common:labels.priority')}>
        <FormSelect value={value.priority} onChange={(e) => set(value, 'priority', e.target.value, onChange)}>
          <option value="0">{t('common:priority.normal')}</option>
          <option value="1">{t('common:priority.high')}</option>
          <option value="2">{t('common:priority.urgent')}</option>
        </FormSelect>
      </FormField>

      <FormField label={t('fields.tmuxWindow')}>
        <FormInput
          value={value.tmuxWindow}
          onChange={(e) => set(value, 'tmuxWindow', e.target.value, onChange)}
          placeholder={t('fields.tmuxWindowPlaceholder')}
        />
      </FormField>

      <FormField label="" hint={value.skipPr ? t('fields.skipPrHintSkip') : t('fields.skipPrHintCreate')}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <label className="toggle">
            <input
              type="checkbox"
              checked={value.skipPr}
              onChange={(e) => set(value, 'skipPr', e.target.checked, onChange)}
            />
            <span className="toggle-slider" />
          </label>
          <span style={{ fontSize: 'var(--font-md)', color: 'var(--text)' }}>{t('fields.skipPr')}</span>
        </label>
      </FormField>

      <FormField label={t('fields.baseBranch')} hint={value.skipPr ? t('fields.baseBranchHintSkipPr') : t('fields.baseBranchHint')}>
        <BranchInput
          value={value.baseBranch}
          onChange={(v) => set(value, 'baseBranch', v, onChange)}
          serverName={serverName}
          projectId={projectId}
          workingDirectory={value.workingDirectory}
          placeholder={t('fields.baseBranchPlaceholder')}
        />
      </FormField>

      {value.skipPr ? (
        <FormField label={t('fields.workingBranch')} hint={t('fields.workingBranchHint')}>
          <BranchInput
            value={value.workingBranch}
            onChange={(v) => set(value, 'workingBranch', v, onChange)}
            serverName={serverName}
            projectId={projectId}
            workingDirectory={value.workingDirectory}
            placeholder={t('fields.workingBranchPlaceholder')}
          />
        </FormField>
      ) : (
        <FormField label={t('fields.targetBranch')} hint={t('fields.targetBranchHint')}>
          <BranchInput
            value={value.targetBranch}
            onChange={(v) => set(value, 'targetBranch', v, onChange)}
            serverName={serverName}
            projectId={projectId}
            workingDirectory={value.workingDirectory}
            placeholder={t('fields.targetBranchPlaceholder')}
          />
        </FormField>
      )}

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>{t('subagent.overrideTitle')}</div>
        <FormField label="" hint={t('subagent.overrideHint')}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={value.overrideSubagents}
                onChange={(e) => set(value, 'overrideSubagents', e.target.checked, onChange)}
              />
              <span className="toggle-slider" />
            </label>
            <span style={{ fontSize: 'var(--font-md)', color: 'var(--text)' }}>{t('subagent.overrideLabel')}</span>
          </label>
        </FormField>
        {!value.overrideSubagents && selectedUnit && (
          (selectedUnit.reviewSubagent?.enabled || selectedUnit.implementSubagent?.enabled) ? (
            <div style={{ marginTop: 8, padding: 12, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontSize: 'var(--font-md)', color: 'var(--text-dim)' }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>{t('subagent.unitDefaults')}</div>
              {selectedUnit.reviewSubagent?.enabled && (
                <div>{t('subagent.review', { provider: selectedUnit.reviewSubagent.provider, model: selectedUnit.reviewSubagent.model })}</div>
              )}
              {selectedUnit.implementSubagent?.enabled && (
                <div>{t('subagent.implement', { provider: selectedUnit.implementSubagent.provider, model: selectedUnit.implementSubagent.model })}</div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
              {t('subagent.noConfig')}
            </div>
          )
        )}
        {value.overrideSubagents && (
          <>
            <SubagentConfigCard
              title={t('subagent.reviewTitle')}
              description={t('subagent.reviewDescription')}
              value={value.reviewSubagent}
              onChange={(v) => set(value, 'reviewSubagent', v, onChange)}
              workerType={selectedUnit?.workerType ?? undefined}
            />
            <SubagentConfigCard
              title={t('subagent.implementTitle')}
              description={t('subagent.implementDescription')}
              value={value.implementSubagent}
              onChange={(v) => set(value, 'implementSubagent', v, onChange)}
              workerType={selectedUnit?.workerType ?? undefined}
            />
          </>
        )}
      </div>
    </>
  );
}
