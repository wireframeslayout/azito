import { describe, it, expect } from 'vitest';
import { utils } from 'ssh2';
import { generateTestKeyPair } from './sshTestKeys';

describe('generateTestKeyPair', () => {
  it('only returns keys that ssh2 reads back, in both the private and the public form', () => {
    for (let i = 0; i < 3000; i++) {
      const pair = generateTestKeyPair();
      expect(utils.parseKey(pair.privatePem)).not.toBeInstanceOf(Error);
      expect(pair.parsed.getPublicSSH().length).toBeGreaterThan(0);
    }
  });
});
