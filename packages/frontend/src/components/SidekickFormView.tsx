import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useApi } from '../hooks/useApi';
import FormField from './FormField';
import { FormInput, FormTextarea, LoadingState, Badge, TagChipInput, Button, FormPage } from './ui';
import { isValidSidekickName } from '../lib/sidekicks';
import { useUnitTypes } from '../hooks/useUnitTypes';
import { useConfirm } from '../hooks/useConfirm';

interface SidekickDetail {
  name: string;
  description: string;
  tags: string[];
  isDefault: boolean;
  layer: 'builtin' | 'user';
  overridesBuiltin: boolean;
  dir: string;
  body: string;
  hasScripts: boolean;
  hasReferences: boolean;
}

interface ScriptDraft {
  filename: string;
  content: string;
}

interface SidekickFormViewProps {
  mode: 'create' | 'edit';
  sidekickName?: string;
  onSaved: (name?: string) => void;
  onCancel: () => void;
  backLabel?: string;
  onBack?: () => void;
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text-dim)',
  margin: '24px 0 12px', paddingBottom: 8,
  borderBottom: '1px solid var(--border)',
  textTransform: 'uppercase', letterSpacing: 0.5,
};

const monoTextareaStyle: React.CSSProperties = {
  resize: 'vertical', minHeight: 320, fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace",
  fontSize: 'var(--font-md)', lineHeight: 1.5,
};

function assertSidekickApiOk(res: unknown): void {
  if (typeof res !== 'object' || res === null) throw new Error('Unexpected empty response from server');
  const obj = res as Record<string, unknown>;
  if (typeof obj.error === 'string') throw new Error(obj.error);
  if (obj.ok !== true) throw new Error('Unexpected response from server');
}

export default function SidekickFormView({ mode, sidekickName, onSaved, onCancel, backLabel, onBack }: SidekickFormViewProps) {
  const isEdit = mode === 'edit' && !!sidekickName;
  const { t } = useTranslation(['sidekicks', 'common']);

  const { data: sidekick, loading, error: loadError, refresh } = useApi<SidekickDetail>(isEdit ? `/sidekicks/${sidekickName}` : null);
  const { unitTypes } = useUnitTypes();
  const allPhaseNames = [...new Set(unitTypes.flatMap((ut) => ut.phases.map((p) => p.name)))];
  const confirm = useConfirm();

  const [newName, setNewName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [isDefault, setIsDefault] = useState(false);
  const [body, setBody] = useState('');
  const [scripts, setScripts] = useState<ScriptDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [acknowledgedCopyOnWrite, setAcknowledgedCopyOnWrite] = useState(false);

  useEffect(() => {
    if (sidekick) {
      setDescription(sidekick.description);
      setTags(sidekick.tags);
      setIsDefault(sidekick.isDefault);
      setBody(sidekick.body);
    }
  }, [sidekick]);

  const nameValid = isEdit || (newName.trim().length > 0 && isValidSidekickName(newName.trim()));
  const isBuiltinUnedited = isEdit && sidekick?.layer === 'builtin';
  const hasPhaseTag = tags.some((tg) => allPhaseNames.includes(tg));

  const handleTagsChange = (next: string[]) => {
    setTags(next);
    setIsDefault((prev) => (next.some((tg) => allPhaseNames.includes(tg)) ? prev : false));
  };

  const handleAddScript = useCallback(() => {
    setScripts((prev) => [...prev, { filename: '', content: '' }]);
  }, []);

  const handleScriptChange = useCallback((index: number, field: keyof ScriptDraft, value: string) => {
    setScripts((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  }, []);

  const handleRemoveScript = useCallback((index: number) => {
    setScripts((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSave = useCallback(async () => {
    setSaveError(null);
    if (!description.trim()) { setSaveError(t('validation.descriptionRequired')); return; }
    if (!isEdit) {
      const trimmed = newName.trim();
      if (!trimmed) { setSaveError(t('validation.nameRequired')); return; }
      if (!isValidSidekickName(trimmed)) {
        setSaveError(t('validation.nameFormat'));
        return;
      }
    }
    if (isBuiltinUnedited && !acknowledgedCopyOnWrite) {
      const proceed = await confirm({
        title: t('confirm.copyBuiltIn'),
        message: t('confirm.copyBuiltInMessage', { name: sidekickName }),
      });
      if (!proceed) return;
      setAcknowledgedCopyOnWrite(true);
    }
    const invalidTag = tags.find((tg) => !isValidSidekickName(tg));
    if (invalidTag) {
      setSaveError(t('validation.invalidTag', { tag: invalidTag }));
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        const res = await api(`/sidekicks/${sidekickName}`, {
          method: 'PUT',
          body: JSON.stringify({ description: description.trim(), tags, isDefault, body }),
        });
        assertSidekickApiOk(res);
        refresh();
        onSaved(sidekickName);
      } else {
        const invalidScript = scripts.find((s) => !s.filename.trim());
        if (invalidScript) { setSaveError(t('validation.scriptFilenameRequired')); setSaving(false); return; }
        const res = await api('/sidekicks', {
          method: 'POST',
          body: JSON.stringify({
            name: newName.trim(),
            description: description.trim(),
            tags,
            isDefault,
            body: body.trim() || undefined,
            scripts: scripts.length ? scripts.map((s) => ({ filename: s.filename.trim(), content: s.content })) : undefined,
          }),
        });
        assertSidekickApiOk(res);
        onSaved(newName.trim());
      }
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [isEdit, sidekickName, description, tags, isDefault, body, newName, scripts, isBuiltinUnedited, acknowledgedCopyOnWrite, refresh, onSaved, confirm]);

  const handleDelete = useCallback(async () => {
    if (!sidekick) return;
    const isRevert = sidekick.overridesBuiltin;
    const ok = isRevert
      ? await confirm({ title: t('confirm.revert'), message: t('confirm.revertMessage', { name: sidekick.name }), danger: true })
      : await confirm({ title: t('confirm.delete'), message: t('confirm.deleteMessage', { name: sidekick.name }), danger: true });
    if (!ok) return;
    setSaveError(null);
    try {
      const res = await api(`/sidekicks/${sidekick.name}`, { method: 'DELETE' });
      assertSidekickApiOk(res);
      onCancel();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [sidekick, onCancel, confirm]);

  if (isEdit && loading) return <LoadingState />;
  if (isEdit && loadError) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px' }}>
        <div role="alert" style={{ padding: '10px 14px', borderRadius: 'var(--radius-md)', background: 'var(--danger-a15)', border: '1px solid var(--danger-a35)', color: 'var(--danger)', fontSize: 'var(--font-md)' }}>
          {t('errors.loadFailed', { error: loadError })}
        </div>
      </div>
    );
  }

  return (
    <FormPage
      title={isEdit ? <span style={{ fontFamily: 'monospace' }}>{sidekickName}</span> : t('form.newSidekick')}
      submitLabel={isEdit ? t('common:actions.save') : t('common:actions.create')}
      onSubmit={handleSave}
      onCancel={onCancel}
      loading={saving}
      loadingLabel={t('common:actions.saving')}
      disabled={isEdit ? false : !nameValid}
      error={saveError}
      backLabel={backLabel}
      onBack={onBack}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        {isEdit && sidekick && (
          <>
            <Badge tone={sidekick.layer === 'builtin' ? 'neutral' : 'accent'}>{sidekick.layer === 'builtin' ? t('list.builtIn') : t('list.custom')}</Badge>
            {sidekick.isDefault && <Badge tone="green">{t('list.default')}</Badge>}
            {sidekick.overridesBuiltin && <Badge tone="orange">{t('list.overridden')}</Badge>}
          </>
        )}
      </div>

      {isBuiltinUnedited && (
        <div style={{ padding: '10px 14px', marginBottom: 16, borderRadius: 'var(--radius-md)', background: 'var(--warning-a15)', border: '1px solid var(--warning-a35)', color: 'var(--warning)', fontSize: 'var(--font-md)', lineHeight: 1.5 }}>
          {t('form.builtInWarning')}
        </div>
      )}

      {!isEdit && (
        <FormField
          label={t('form.name')}
          hint={t('form.nameHint')}
        >
          <FormInput
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('form.namePlaceholder')}
            aria-invalid={newName.length > 0 && !isValidSidekickName(newName.trim())}
          />
        </FormField>
      )}

      <FormField label={t('form.description')}>
        <FormInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('form.descriptionPlaceholder')} />
      </FormField>

      <FormField
        label={t('form.tags')}
        hint={t('form.tagsHint')}
      >
        <TagChipInput
          value={tags}
          onChange={handleTagsChange}
          suggestions={allPhaseNames}
          validate={isValidSidekickName}
          onInvalid={(tag) => setSaveError(t('validation.invalidTag', { tag }))}
          placeholder={t('form.tagsPlaceholder')}
          aria-label={t('form.tags')}
        />
      </FormField>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <label className="toggle">
          <input
            type="checkbox"
            id="sidekick-is-default"
            checked={isDefault}
            disabled={!hasPhaseTag}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
        <label
          htmlFor="sidekick-is-default"
          style={{ fontSize: 'var(--font-md)', cursor: hasPhaseTag ? 'pointer' : 'not-allowed', color: hasPhaseTag ? 'var(--text)' : 'var(--text-dim)' }}
        >
          {t('form.defaultForPhase')}
        </label>
      </div>
      {!hasPhaseTag && (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: -10, marginBottom: 14 }}>
          {t('form.addPhaseTagHint')}
        </div>
      )}

      <h3 style={sectionHeaderStyle}>{t('form.skillBody')}</h3>
      <FormField label="" hint={t('form.skillBodyHint')}>
        <FormTextarea value={body} onChange={(e) => setBody(e.target.value)} rows={16} style={monoTextareaStyle} />
      </FormField>

      {isEdit && sidekick && (
        <>
          <h3 style={sectionHeaderStyle}>{t('form.packageContents')}</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <Badge tone={sidekick.hasScripts ? 'purple' : 'neutral'}>{sidekick.hasScripts ? t('form.hasScripts') : t('form.noScripts')}</Badge>
            <Badge tone={sidekick.hasReferences ? 'purple' : 'neutral'}>{sidekick.hasReferences ? t('form.hasReferences') : t('form.noReferences')}</Badge>
          </div>
        </>
      )}

      {!isEdit && (
        <>
          <h3 style={sectionHeaderStyle}>{t('form.scriptsTitle')}</h3>
          <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', margin: '-8px 0 12px' }}>
            {t('form.scriptsDescription')}
          </p>
          {scripts.map((s, i) => (
            <div key={i} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <FormInput
                  value={s.filename}
                  onChange={(e) => handleScriptChange(i, 'filename', e.target.value)}
                  placeholder={t('form.scriptFilenamePlaceholder')}
                  style={{ flex: 1 }}
                />
                <Button variant="danger" size="sm" onClick={() => handleRemoveScript(i)} aria-label={t('form.removeScriptLabel', { index: i + 1 })}>{t('common:actions.remove')}</Button>
              </div>
              <FormTextarea
                value={s.content}
                onChange={(e) => handleScriptChange(i, 'content', e.target.value)}
                rows={4}
                placeholder={t('form.scriptContentPlaceholder')}
                style={{ fontFamily: 'monospace', fontSize: 'var(--font-sm)' }}
              />
            </div>
          ))}
          <Button size="sm" onClick={handleAddScript}>{t('form.addScript')}</Button>
        </>
      )}

      {isEdit && sidekick && (sidekick.overridesBuiltin || sidekick.layer === 'user') && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20, marginTop: 32, marginBottom: 40 }}>
          <Button variant="danger" onClick={handleDelete}>
            {sidekick.overridesBuiltin ? t('form.revertToBuiltIn') : t('form.deleteSidekick')}
          </Button>
        </div>
      )}
    </FormPage>
  );
}
