export interface KeyStep { key: string; ctrl: boolean; shift: boolean; alt: boolean }
export interface KeySpec { steps: KeyStep[]; windowMs?: number }

export function parseKeySpec(text: string): KeySpec {
  const parts = text.trim().split(/\s+/);
  if (!text.trim() || parts.length > 4) throw new Error('Invalid key specification');
  const steps = parts.map((part): KeyStep => {
    const tokens = part.split('+');
    const key = tokens.pop();
    const modifiers = tokens.map(token => token.toLowerCase());
    if (!key || !/^(?:[a-z0-9]|space|escape|enter|tab|arrowup|arrowdown|arrowleft|arrowright)$/i.test(key) || modifiers.some(m => !['ctrl', 'meta', 'shift', 'alt'].includes(m)) || new Set(modifiers.map(m => m === 'meta' ? 'ctrl' : m)).size !== modifiers.length) throw new Error('Invalid key specification');
    return { key: key.toLowerCase(), ctrl: modifiers.includes('ctrl') || modifiers.includes('meta'), shift: modifiers.includes('shift'), alt: modifiers.includes('alt') };
  });
  return { steps };
}

export function formatKeySpec(spec: KeySpec): string {
  return spec.steps.map(step => [step.ctrl && 'Ctrl', step.shift && 'Shift', step.alt && 'Alt', step.key === 'space' ? 'Space' : step.key.length === 1 ? step.key.toUpperCase() : step.key[0].toUpperCase() + step.key.slice(1)].filter(Boolean).join('+')).join(' ');
}

export function stepMatches(step: KeyStep, e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  const key = e.key === ' ' ? 'space' : e.key.toLowerCase();
  return step.key.toLowerCase() === key && step.ctrl === (e.ctrlKey || e.metaKey) && step.shift === e.shiftKey && step.alt === e.altKey;
}
