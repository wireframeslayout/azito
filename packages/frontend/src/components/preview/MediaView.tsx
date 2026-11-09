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
  const refresh = async () => {
    setLoading(true); setError(false);
    try { const next = await backend.mediaUrl(path); expires.current = Date.now() + 590_000; setUrl(next); }
    catch { setError(true); }
    finally { setLoading(false); }
  };
  useEffect(() => { let active = true; setUrl(null); setLoading(true); setError(false); position.current = 0; backend.mediaUrl(path).then((value) => { if (active) { setUrl(value); expires.current = Date.now() + 590_000; } }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [backend, path]);
  const common = { controls: true, src: url ?? undefined, onLoadedMetadata: () => { if (media.current) media.current.currentTime = position.current; }, onTimeUpdate: () => { if (media.current) position.current = media.current.currentTime; }, onError: () => { if (Date.now() >= expires.current) void refresh(); else setError(true); }, style: { maxWidth: '100%' } };
  return <section>{loading && <p role="status">{t('preview.loading')}</p>}{error && <p role="alert">{t('office.mediaError')} <Button onClick={() => void refresh()}>{t('office.retry')}</Button></p>}{url && (type === 'video' ? <video {...common} ref={(node) => { media.current = node; }} /> : <audio {...common} ref={(node) => { media.current = node; }} />)}</section>;
}
