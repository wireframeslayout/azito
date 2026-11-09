import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { preparePptx } from './preparePptx';

interface Props { bytes: Uint8Array }
export function PptxView({ bytes }: Props) {
  const { t } = useTranslation('files');
  const [result, setResult] = useState<{ slides: string[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<'large' | 'invalid' | null>(null);
  const [slide, setSlide] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null); setError(null); setSlide(0);
    void (async () => {
      const prepared = await preparePptx(bytes.slice().buffer);
      const [{ pptxToHtml }, { default: DOMPurify }] = await Promise.all([import('@jvmr/pptx-to-html'), import('dompurify')]);
      const slides = await pptxToHtml(prepared.data);
      return { slides: slides.map((html) => DOMPurify.sanitize(html, { FORBID_TAGS: ['script', 'iframe', 'object', 'embed'], FORBID_ATTR: ['href', 'xlink:href'] })), truncated: prepared.truncated };
    })().then((value) => { if (active) setResult(value); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error && /limit|too many entries/i.test(reason.message) ? 'large' : 'invalid'); });
    return () => { active = false; };
  }, [bytes]);
  if (error) return <div role="alert"><p>{t(error === 'large' ? 'office.tooLarge' : 'preview.loadError')}</p><p>{t('office.pptxLimit')}</p></div>;
  if (!result) return <p role="status">{t('preview.loading')}</p>;
  if (!result.slides.length) return <p>{t('office.empty')}</p>;
  const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'"></head><body>${result.slides[slide]}</body></html>`;
  return <section><p>{t('office.pptxLimit')}</p>{result.truncated && <p role="status">{t('office.slidesTruncated')}</p>}<iframe title={`${t('office.slide')} ${slide + 1}`} sandbox="" srcDoc={html} style={{ width: '100%', minHeight: '60vh', border: 0 }} /><div><button disabled={slide === 0} onClick={() => setSlide(slide - 1)}>{t('office.previous')}</button> {slide + 1} / {result.slides.length} <button disabled={slide + 1 >= result.slides.length} onClick={() => setSlide(slide + 1)}>{t('office.next')}</button></div></section>;
}
