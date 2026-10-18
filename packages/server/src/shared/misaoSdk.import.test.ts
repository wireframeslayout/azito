import { describe, expect, it } from 'vitest';
import type { MisaoClient } from '@misao/sdk' with { 'resolution-mode': 'import' };

// @misao/sdk is ESM-only while the server compiles to CJS (module Node16): a static
// value import is TS1479, so types come via resolution-mode and values via dynamic import().
describe('@misao/sdk import from a CJS package', () => {
  it('loads the ESM SDK through dynamic import', async () => {
    const sdk = await import('@misao/sdk');
    const ctor: typeof MisaoClient = sdk.MisaoClient;
    expect(typeof ctor).toBe('function');
    expect(typeof sdk.resolveSocketPath).toBe('function');
  });
});
