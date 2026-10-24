import { utils, type ParsedKey } from 'ssh2';

/**
 * ed25519 keys for the ssh2 tests. `utils.generateKeyPairSync('ed25519')` writes the OpenSSH text from the raw key bytes
 * and drops a leading zero byte of the key, so about 1 key in 300 is one that ssh2 itself then refuses to read back
 * ("Malformed OpenSSH private / public key"). Such a key is unusable for any test, so it is discarded here and a new one
 * generated; a key that is returned has been read back through the same parser the code under test uses.
 */
export interface TestKeyPair {
  /** OpenSSH PEM, as written to an identity file or given to `Server({ hostKeys })`. */
  privatePem: string;
  parsed: ParsedKey;
}

const MAX_ATTEMPTS = 20;

export function generateTestKeyPair(): TestKeyPair {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519');
    const parsed = utils.parseKey(pair.private);
    if (parsed instanceof Error || utils.parseKey(pair.public) instanceof Error) continue;
    return { privatePem: pair.private, parsed };
  }
  throw new Error(`ssh2 produced no readable ed25519 key in ${MAX_ATTEMPTS} attempts`);
}
