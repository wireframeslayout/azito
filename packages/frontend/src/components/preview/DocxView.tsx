import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inspectOfficeZip } from './officeZip';

interface Props { bytes: Uint8Array }
export function DocxView({ bytes }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState<'large' | 'invalid' | null>(null);
  const { t } = useTranslation('files');
  useEffect(() => {
    if (!ready || !frame.current?.contentDocument) return;
    let active = true;
    setRendered(false); setError(null);
    const doc = frame.current.contentDocument;
    let styles: HTMLDivElement | undefined;
    void (async () => {
      await inspectOfficeZip(bytes.slice().buffer);
      const [{ renderAsync }, { default: DOMPurify }] = await Promise.all([import('docx-preview'), import('dompurify')]);
      const create = (value: unknown): Node => {
        if (typeof value === 'string') return doc.createTextNode(value);
        if (value && typeof value === 'object' && 'nodeType' in value) return value as Node;
        const item = value as { ns?: string; tagName: string; className?: string; style?: string | Record<string, string>; children?: unknown[]; [key: string]: unknown };
        if (item.tagName === '#fragment') { const fragment = doc.createDocumentFragment(); item.children?.forEach((child) => fragment.appendChild(create(child))); return fragment; }
        if (item.tagName === '#comment') return doc.createComment(String(item.children?.[0] ?? ''));
        const element = item.ns ? doc.createElementNS(item.ns, item.tagName) : doc.createElement(item.tagName);
        if (item.className) element.setAttribute('class', item.className);
        if (typeof item.style === 'string') element.setAttribute('style', item.style);
        else if (item.style && 'style' in element) Object.assign((element as HTMLElement).style, item.style);
        for (const [key, prop] of Object.entries(item)) {
          if (['ns', 'tagName', 'className', 'style', 'children'].includes(key) || prop == null || key.toLowerCase().startsWith('on')) continue;
          if (typeof prop === 'string' || typeof prop === 'number' || typeof prop === 'boolean') element.setAttribute(key, String(prop));
        }
        item.children?.forEach((child) => element.appendChild(create(child)));
        return element;
      };
      if (!active) return;
      styles = doc.createElement('div');
      doc.head.appendChild(styles);
      await renderAsync(bytes.slice().buffer, doc.body, styles, { h: create as never, ignoreFonts: true, renderAltChunks: false, useBase64URL: true });
      if (active) {
        if (!doc.defaultView) throw new Error('Preview frame is unavailable');
        const sanitize = DOMPurify(doc.defaultView);
        doc.body.innerHTML = sanitize.sanitize(doc.body.innerHTML, { FORBID_TAGS: ['iframe', 'object', 'embed', 'script'], FORBID_ATTR: ['href', 'xlink:href'] });
        setError(null); setRendered(true);
      }
    })().catch((reason: unknown) => { if (active) setError(reason instanceof Error && /limit|too many entries/i.test(reason.message) ? 'large' : 'invalid'); });
    return () => { active = false; styles?.remove(); };
  }, [bytes, ready]);
  return <>{error && <p role="alert">{t(error === 'large' ? 'office.tooLarge' : 'preview.loadError')}</p>}{!rendered && !error && <p role="status">{t('preview.loading')}</p>}<iframe ref={frame} title={t('office.document')} sandbox="allow-same-origin" onLoad={() => setReady(true)} srcDoc={'<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src \'none\'; base-uri \'none\'; form-action \'none\'"></head><body></body></html>'} style={{ width: '100%', minHeight: '60vh', border: 0, display: rendered ? 'block' : 'none' }} /></>;
}
