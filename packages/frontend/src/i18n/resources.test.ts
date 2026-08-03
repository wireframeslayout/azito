import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const LOCALES_DIR = join(__dirname, 'locales');

function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectKeys(v as Record<string, unknown>, full));
    } else {
      keys.push(full);
    }
  }
  return keys.sort();
}

function extractInterpolationVars(value: string): string[] {
  const matches = value.match(/\{\{(\w+)\}\}/g) ?? [];
  return matches.map((m) => m.slice(2, -2)).sort();
}

function loadNamespace(lang: string, ns: string): Record<string, unknown> {
  const filePath = join(LOCALES_DIR, lang, `${ns}.json`);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function getNamespaces(): string[] {
  const enFiles = readdirSync(join(LOCALES_DIR, 'en'));
  return enFiles.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
}

function getLeafValues(obj: Record<string, unknown>, prefix = ''): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      entries.push(...getLeafValues(v as Record<string, unknown>, full));
    } else if (typeof v === 'string') {
      entries.push({ key: full, value: v });
    }
  }
  return entries;
}

describe('i18n resources', () => {
  const namespaces = getNamespaces();

  it('en and ja have the same set of namespace files', () => {
    const enNs = readdirSync(join(LOCALES_DIR, 'en')).filter((f) => f.endsWith('.json')).sort();
    const jaNs = readdirSync(join(LOCALES_DIR, 'ja')).filter((f) => f.endsWith('.json')).sort();
    expect(enNs).toEqual(jaNs);
  });

  for (const ns of namespaces) {
    describe(`namespace: ${ns}`, () => {
      it('en and ja have the same key structure', () => {
        const enData = loadNamespace('en', ns);
        const jaData = loadNamespace('ja', ns);
        const enKeys = collectKeys(enData);
        const jaKeys = collectKeys(jaData);
        expect(enKeys).toEqual(jaKeys);
      });

      it('no empty string values in en', () => {
        const enData = loadNamespace('en', ns);
        const leaves = getLeafValues(enData);
        for (const { key, value } of leaves) {
          expect(value, `en/${ns}.json key "${key}" is empty`).not.toBe('');
        }
      });

      it('no empty string values in ja', () => {
        const jaData = loadNamespace('ja', ns);
        const leaves = getLeafValues(jaData);
        for (const { key, value } of leaves) {
          expect(value, `ja/${ns}.json key "${key}" is empty`).not.toBe('');
        }
      });

      it('interpolation variables match between en and ja', () => {
        const enData = loadNamespace('en', ns);
        const jaData = loadNamespace('ja', ns);
        const enLeaves = getLeafValues(enData);
        const jaLeaves = getLeafValues(jaData);

        const jaMap = new Map(jaLeaves.map((l) => [l.key, l.value]));
        for (const { key, value } of enLeaves) {
          const jaValue = jaMap.get(key);
          if (!jaValue) continue;
          const enVars = extractInterpolationVars(value);
          const jaVars = extractInterpolationVars(jaValue);
          expect(enVars, `interpolation mismatch in ${ns}.${key}`).toEqual(jaVars);
        }
      });
    });
  }
});
