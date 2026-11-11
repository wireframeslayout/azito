import type { IconName } from '../ui/Icon';

export function fileIconFor(name: string): { icon: IconName; color: string } {
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name)) return { icon: 'image', color: 'var(--purple)' };
  if (/\.(xlsx?|csv|ods)$/i.test(name)) return { icon: 'file-spreadsheet', color: 'var(--success)' };
  if (/\.(pptx?|odp)$/i.test(name)) return { icon: 'presentation', color: 'var(--warning)' };
  if (/\.pdf$/i.test(name)) return { icon: 'file-type', color: 'var(--danger)' };
  if (/\.(docx?|odt|rtf|txt|md)$/i.test(name)) return { icon: 'file-text', color: 'var(--accent)' };
  if (/\.(tsx?|jsx?|json|css|html|py|rs|sh)$/i.test(name)) return { icon: 'file-code', color: 'var(--text-dim)' };
  return { icon: 'file', color: 'var(--text-dim)' };
}
