import { useEffect, useState } from 'react';
import { fetchBlob } from '../api/client';

export type BlobUrlState = 'loading' | 'success' | 'error';

interface UseBlobUrlResult {
  url: string | null;
  state: BlobUrlState;
}

export function useBlobUrl(apiPath: string | null, mimeType?: string): UseBlobUrlResult {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<BlobUrlState>(apiPath ? 'loading' : 'error');

  useEffect(() => {
    if (!apiPath) {
      setUrl(null);
      setState('error');
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;
    setState('loading');
    setUrl(null);

    fetchBlob(apiPath)
      .then((blob) => {
        if (cancelled) return;
        const typedBlob = blob.type || !mimeType ? blob : new Blob([blob], { type: mimeType });
        createdUrl = URL.createObjectURL(typedBlob);
        setUrl(createdUrl);
        setState('success');
      })
      .catch(() => {
        if (cancelled) return;
        setState('error');
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [apiPath, mimeType]);

  return { url, state };
}
