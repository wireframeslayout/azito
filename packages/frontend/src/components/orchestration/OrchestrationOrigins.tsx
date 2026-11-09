import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { paths } from '../../paths';
import { Icon } from '../ui/Icon';

export function OrchestrationOrigins({ projectId, onSelect }: { projectId: number; onSelect?: () => void }) {
  const { t } = useTranslation('workspace');
  const { windows, status } = useOrchestrators();
  const navigate = useNavigate();
  if (status !== 'ready') return null;
  const origins = windows.filter((window) => window.originProjectId === projectId);
  if (!origins.length) return null;
  return <div>
    {origins.map((window) => <button key={window.id} type="button" className="glass-popover-item" onClick={() => { navigate(paths.orchestration(window.id)); onSelect?.(); }} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', width: '100%', padding: 'var(--space-3)', background: 'var(--bg-elevated)', color: 'var(--purple)', border: 0, borderRadius: 'var(--radius-md)', cursor: 'pointer', textAlign: 'left' }}>
      <Icon name="operations" size={16} /><span>{t('orchestration.origin', { name: window.label || window.tmuxTarget })}</span>
    </button>)}
  </div>;
}
