import { useEffect, useState } from 'react';
import { KEYBOARD_HEIGHT_THRESHOLD } from '../../hooks/useVirtualKeyboard';

interface MarkdownKeyRowProps { onInsert: (value: string) => void }
const keys = ['#', '-', '`', '|', '⇥', '[', ']'];

export function MarkdownKeyRow({ onInsert }: MarkdownKeyRowProps) {
  const [bottom, setBottom] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setBottom(window.innerHeight - viewport.height >= KEYBOARD_HEIGHT_THRESHOLD ? Math.max(window.innerHeight - viewport.offsetTop - viewport.height, 0) : 0);
    update(); viewport.addEventListener('resize', update); viewport.addEventListener('scroll', update); window.addEventListener('resize', update);
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, []);
  return <div style={{ position: 'fixed', left: 0, right: 0, bottom, zIndex: 20, display: 'flex', gap: 0, padding: 0, paddingBottom: bottom ? 'var(--space-1)' : 'max(var(--space-1), env(safe-area-inset-bottom))', background: 'var(--bg-solid)', borderTop: '1px solid var(--hairline)' }}>
    {keys.map((key) => <button key={key} aria-label={key === '⇥' ? 'Tab' : key} onPointerDown={(event) => event.preventDefault()} onClick={() => onInsert(key === '⇥' ? '\t' : key)} style={{ minWidth: 44, minHeight: 44, flex: '1 0 44px', background: 'var(--input-bg)', border: '1px solid var(--hairline)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>{key}</button>)}
  </div>;
}
