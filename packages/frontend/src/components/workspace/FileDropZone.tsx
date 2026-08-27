import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uploadAndGetUrl } from '../StoragePanel';

interface FileDropZoneProps {
  style: React.CSSProperties;
  onPointerDownCapture?: () => void;
  projectId: number | null;
  projectName: string | null;
  showToast: (msg: string) => void;
  mobile: boolean;
  children: React.ReactNode;
}

const isFileDrag = (e: React.DragEvent) =>
  e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('application/x-azito-tab');

export default function FileDropZone({
  style,
  onPointerDownCapture,
  projectId,
  projectName,
  showToast,
  mobile,
  children,
}: FileDropZoneProps): React.JSX.Element {
  const { t } = useTranslation('workspace');
  const [fileHover, setFileHover] = useState(false);
  const dragCounterRef = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (mobile || !isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setFileHover(true);
  }, [mobile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (mobile || !isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }, [mobile]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (mobile) return;
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setFileHover(false);
    }
  }, [mobile]);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    if (mobile) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setFileHover(false);
    if (!projectId) return;
    const droppedFiles = Array.from(e.dataTransfer.files);
    for (const f of droppedFiles) {
      const url = await uploadAndGetUrl(projectId, f);
      if (url) {
        await navigator.clipboard.writeText(url).catch(() => {});
        showToast(`Uploaded ${f.name} — URL copied`);
      } else {
        showToast(`Failed to upload ${f.name}`);
      }
    }
  }, [mobile, projectId, showToast]);

  const hasProject = projectId != null;

  return (
    <div
      style={style}
      onPointerDownCapture={onPointerDownCapture}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {fileHover && !mobile && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 100,
          background: hasProject ? 'var(--accent-a08)' : 'var(--orange-a15)',
          border: `2px dashed ${hasProject ? 'var(--accent)' : 'var(--orange)'}`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 6, pointerEvents: 'none',
        }}>
          <span style={{
            background: 'var(--bg-card)', padding: '10px 20px', borderRadius: 'var(--radius-md)',
            fontSize: 'var(--font-base)', fontWeight: 600,
            color: hasProject ? 'var(--accent)' : 'var(--orange)',
            border: `1px solid ${hasProject ? 'var(--accent)' : 'var(--orange)'}`,
            textAlign: 'center', maxWidth: '80%',
          }}>
            {hasProject
              ? t('dropZone.uploadToProject', { name: projectName })
              : t('dropZone.noProject')}
          </span>
          <span style={{
            fontSize: 'var(--font-xs)', color: hasProject ? 'var(--text-dim)' : 'var(--orange)',
            textAlign: 'center', maxWidth: '80%',
          }}>
            {hasProject
              ? t('dropZone.uploadHint')
              : t('dropZone.noProjectHint')}
          </span>
        </div>
      )}
    </div>
  );
}
