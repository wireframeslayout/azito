import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import type { BinaryFilesBackend } from '../files/backend/FilesBackend';

interface Props { backend: BinaryFilesBackend; path: string; type: 'video' | 'audio' }
export function MediaView({ backend, path, type }: Props) {
  const { t } = useTranslation('files');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const media = useRef<HTMLMediaElement | null>(null);
  const position = useRef(0);
  const expires = useRef(0);
  const generation = useRef(0);
  const restoring = useRef(false);
  const refreshing = useRef(false);
  const refresh = async () => {
    if (refreshing.current) return;
    const current = generation.current;
    refreshing.current = true;
    setLoading(true); setError(false);
    try { const next = await backend.mediaUrl(path); if (generation.current === current) { restoring.current = true; expires.current = Date.now() + 590_000; setUrl(next); } }
    catch { if (generation.current === current) { restoring.current = false; setError(true); } }
    finally { if (generation.current === current) { refreshing.current = false; setLoading(false); } }
  };
  useEffect(() => { const current = ++generation.current; setUrl(null); setLoading(true); setError(false); position.current = 0; restoring.current = false; refreshing.current = false; backend.mediaUrl(path).then((value) => { if (generation.current === current) { setUrl(value); expires.current = Date.now() + 590_000; } }).catch(() => { if (generation.current === current) setError(true); }).finally(() => { if (generation.current === current) setLoading(false); }); return () => { generation.current++; }; }, [backend, path]);
  const common = { controls: true, src: url ?? undefined, onLoadedMetadata: () => { if (media.current && restoring.current) media.current.currentTime = position.current; restoring.current = false; }, onTimeUpdate: () => { if (media.current && !refreshing.current && !restoring.current) position.current = media.current.currentTime; }, onError: () => { if (Date.now() >= expires.current) void refresh(); else setError(true); }, style: { maxWidth: '100%' } };
  return <section>{loading && <p role="status">{t('preview.loading')}</p>}{error && <p role="alert">{t('office.mediaError')} <Button onClick={() => void refresh()}>{t('office.retry')}</Button></p>}{url && (type === 'video' ? <video {...common} ref={(node) => { media.current = node; }} /> : <audio {...common} ref={(node) => { media.current = node; }} />)}</section>;
}
