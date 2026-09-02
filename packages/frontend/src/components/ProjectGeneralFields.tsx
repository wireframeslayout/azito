import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import FormField from './FormField';
import { FormInput, FormTextarea } from './ui';

// User-facing project color picker presets — data-driven project colors, excluded from the token rule (ui-surface-policy.md).
const COLOR_PRESETS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9']; // lint-allow: hex

export interface ProjectGeneralFieldsProps {
  name: string;
  setName: (v: string) => void;
  slug: string;
  setSlug: (v: string) => void;
  slugManuallyEdited?: boolean;
  setSlugManuallyEdited?: (v: boolean) => void;
  description: string;
  setDescription: (v: string) => void;
  icon: string;
  setIcon: (v: string) => void;
  color: string;
  setColor: (v: string) => void;
  /**
   * Repository URL / default-branch fields are shown only when both value and
   * setter are supplied (ProjectSettings edits them; the create wizard's step 1
   * no longer collects them — repository choice now happens in the wizard's
   * "code" step, see ProjectWizard.tsx).
   */
  projectRepoUrl?: string;
  setProjectRepoUrl?: (v: string) => void;
  defaultBranch?: string;
  setDefaultBranch?: (v: string) => void;
  sidekickPrompt: string;
  setSidekickPrompt: (v: string) => void;
}

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/* ------------------------------------------------------------------ */
/*  Icon Image Editor (crop / scale / pan)                            */
/* ------------------------------------------------------------------ */

function IconImageEditor({ onApply, onCancel }: { onApply: (dataUrl: string) => void; onCancel: () => void }) {
  const { t } = useTranslation(['projects', 'common']);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const offsetStart = useRef({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement | null>(null);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      setImageSrc(src);
      setScale(1);
      setOffset({ x: 0, y: 0 });
      const img = new Image();
      img.onload = () => {
        setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
        imgRef.current = img;
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    offsetStart.current = { ...offset };
  }, [offset]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setOffset({
        x: offsetStart.current.x + (e.clientX - dragStart.current.x),
        y: offsetStart.current.y + (e.clientY - dragStart.current.y),
      });
    };
    const handleMouseUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleApply = useCallback(() => {
    if (!imgRef.current || !naturalSize.w) return;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    // Map preview (200x200) transform to 64x64 canvas
    const ratio = 64 / 200;
    const img = imgRef.current;
    const fitScale = 200 / Math.max(naturalSize.w, naturalSize.h);
    const drawW = naturalSize.w * fitScale * scale;
    const drawH = naturalSize.h * fitScale * scale;
    const drawX = (200 - drawW) / 2 + offset.x;
    const drawY = (200 - drawH) / 2 + offset.y;
    ctx.drawImage(img, drawX * ratio, drawY * ratio, drawW * ratio, drawH * ratio);
    onApply(canvas.toDataURL('image/png'));
  }, [naturalSize, scale, offset, onApply]);

  const previewBg = imageSrc && naturalSize.w ? (() => {
    const fitScale = 200 / Math.max(naturalSize.w, naturalSize.h);
    const w = naturalSize.w * fitScale * scale;
    const h = naturalSize.h * fitScale * scale;
    const x = (200 - w) / 2 + offset.x;
    const y = (200 - h) / 2 + offset.y;
    return {
      backgroundImage: `url(${imageSrc})`,
      backgroundSize: `${w}px ${h}px`,
      backgroundPosition: `${x}px ${y}px`,
      backgroundRepeat: 'no-repeat',
    } as React.CSSProperties;
  })() : {};

  const btnStyle: React.CSSProperties = {
    padding: '6px 16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
    background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer', fontSize: 'var(--font-md)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <input type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp" onChange={handleFile}
        style={{ fontSize: 'var(--font-sm)', color: 'var(--text)' }} />
      {imageSrc && naturalSize.w > 0 && (
        <>
          <div
            onMouseDown={handleMouseDown}
            style={{
              width: 200, height: 200, borderRadius: 'var(--radius-lg)', overflow: 'hidden',
              border: '2px solid var(--border)', cursor: 'grab', userSelect: 'none',
              background: 'var(--bg)', ...previewBg,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
            <span>{t('general.scale')}</span>
            <input type="range" min={0.5} max={3} step={0.05} value={scale}
              onChange={(e) => setScale(parseFloat(e.target.value))}
              style={{ flex: 1 }} />
            <span>{scale.toFixed(2)}x</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={handleApply}
              style={{ ...btnStyle, background: 'var(--accent)', color: '#fff' /* lint-allow: hex - white text on solid accent fill; no on-color token yet */, borderColor: 'var(--accent)' }}>
              {t('common:actions.apply')}
            </button>
            <button type="button" onClick={onCancel} style={btnStyle}>{t('common:actions.cancel')}</button>
          </div>
        </>
      )}
      {!imageSrc && (
        <button type="button" onClick={onCancel} style={btnStyle}>{t('common:actions.cancel')}</button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export default function ProjectGeneralFields({ name, setName, slug, setSlug, slugManuallyEdited, setSlugManuallyEdited, description, setDescription, icon, setIcon, color, setColor, projectRepoUrl, setProjectRepoUrl, defaultBranch, setDefaultBranch, sidekickPrompt, setSidekickPrompt }: ProjectGeneralFieldsProps) {
  const [iconMode, setIconMode] = useState<'emoji' | 'image'>('emoji');
  const { t } = useTranslation(['projects', 'common']);

  const handleNameChange = useCallback((value: string) => {
    setName(value);
    if (!slugManuallyEdited) {
      setSlug(generateSlug(value));
    }
  }, [setName, setSlug, slugManuallyEdited]);

  const handleSlugChange = useCallback((value: string) => {
    const sanitized = value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    setSlug(sanitized);
    setSlugManuallyEdited?.(true);
  }, [setSlug, setSlugManuallyEdited]);

  return (
    <>
      <FormField label={t('general.projectName')}>
        <FormInput value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder={t('general.projectNamePlaceholder')} />
      </FormField>
      <FormField label={t('general.slug')} hint={t('general.slugHint')}>
        <FormInput value={slug} onChange={(e) => handleSlugChange(e.target.value)} placeholder={t('general.slugPlaceholder')} />
      </FormField>
      <FormField label={t('general.description')}>
        <FormTextarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder={t('general.descriptionPlaceholder')} style={{ resize: 'vertical', minHeight: 60 }} />
      </FormField>
      <FormField label={t('general.icon')} hint={t('general.iconHint')}>
        {iconMode === 'emoji' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FormInput value={icon.startsWith('data:') ? '' : icon} onChange={(e) => setIcon(e.target.value)} placeholder={t('general.iconPlaceholder')} style={{ maxWidth: 120 }} />
              <button type="button" onClick={() => setIconMode('image')}
                style={{ fontSize: 'var(--font-sm)', padding: '6px 12px', background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {t('general.uploadImage')}
              </button>
            </div>
            {icon.startsWith('data:') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
                <img src={icon} alt="icon" style={{ width: 32, height: 32, borderRadius: 'var(--radius-sm)', objectFit: 'cover' }} />
                <span>{t('general.imageIconSet')}</span>
                <button type="button" onClick={() => setIcon('')}
                  style={{ fontSize: 'var(--font-xs)', padding: '2px 8px', background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)', cursor: 'pointer' }}>
                  {t('common:actions.clear')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <IconImageEditor
            onApply={(dataUrl) => { setIcon(dataUrl); setIconMode('emoji'); }}
            onCancel={() => setIconMode('emoji')}
          />
        )}
      </FormField>
      <FormField label={t('general.color')} hint={t('general.colorHint')}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {COLOR_PRESETS.map((c) => (
            <button key={c} type="button" onClick={() => setColor(c)}
              style={{
                width: 28, height: 28, borderRadius: 'var(--radius-sm)', background: c,
                border: color === c ? '2px solid var(--text)' : '2px solid transparent',
                cursor: 'pointer', transition: 'border-color 0.15s',
              }} />
          ))}
          {color && (
            <button type="button" onClick={() => setColor('')}
              style={{ fontSize: 'var(--font-xs)', padding: '4px 8px', background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)', cursor: 'pointer' }}>
              {t('common:actions.clear')}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <input type="color" value={color || '#000000' /* lint-allow: hex - default value for a native color input; data-driven project color */} onChange={(e) => setColor(e.target.value)}
            style={{ width: 36, height: 28, padding: 0, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: 'var(--bg)' }} />
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', fontFamily: 'monospace' }}>{color || t('general.colorNone')}</span>
        </div>
      </FormField>
      {setProjectRepoUrl && (
        <FormField label={t('general.repositoryUrl')}>
          <FormInput value={projectRepoUrl ?? ''} onChange={(e) => setProjectRepoUrl(e.target.value)} placeholder={t('general.repositoryUrlPlaceholder')} />
        </FormField>
      )}
      {setDefaultBranch && (
        <FormField label={t('general.defaultBranch')}>
          <FormInput value={defaultBranch ?? ''} onChange={(e) => setDefaultBranch(e.target.value)} placeholder={t('general.defaultBranchPlaceholder')} />
        </FormField>
      )}
      <FormField label={t('general.unitPrompt')} hint={t('general.unitPromptHint')}>
        <FormTextarea value={sidekickPrompt} onChange={(e) => setSidekickPrompt(e.target.value)} rows={5}
          placeholder={t('general.unitPromptPlaceholder')}
          style={{ resize: 'vertical', minHeight: 100 }} />
      </FormField>
    </>
  );
}
