import assert from 'node:assert/strict';
import test from 'node:test';

import { createKeyringCipher } from '../lib/crypto/keyring.js';

const KEY_ONE = Buffer.alloc(32, 1).toString('base64');
const KEY_TWO = Buffer.alloc(32, 2).toString('base64');

function cipher(serialized = `1:${KEY_ONE}`) {
  return createKeyringCipher({
    serializedKeyring: serialized,
    label: 'connector',
    subject: 'Connector',
    variableName: 'CONNECTOR_ENCRYPTION_KEYS',
  });
}

test('round trips through the newest key version', () => {
  const subject = cipher(`1:${KEY_ONE},2:${KEY_TWO}`);
  const sealed = subject.encrypt('hello');
  assert.equal(sealed.keyVersion, 2);
  assert.equal(subject.decrypt(sealed), 'hello');
});

test('decrypts a value sealed under an older key version', () => {
  const sealed = cipher(`1:${KEY_ONE}`).encrypt('hello');
  assert.equal(cipher(`1:${KEY_ONE},2:${KEY_TWO}`).decrypt(sealed), 'hello');
});

test('accepts base64 strings back from the database', () => {
  const subject = cipher();
  const sealed = subject.encrypt('hello');
  assert.equal(
    subject.decrypt({
      ciphertext: sealed.ciphertext.toString('base64'),
      nonce: sealed.nonce.toString('base64'),
      authTag: sealed.authTag.toString('base64'),
      keyVersion: sealed.keyVersion,
    }),
    'hello',
  );
});

test('rejects a ciphertext sealed under a different label', () => {
  const sealed = createKeyringCipher({
    serializedKeyring: `1:${KEY_ONE}`,
    label: 'journal',
    subject: 'Journal',
    variableName: 'JOURNAL_ENCRYPTION_KEYS',
  }).encrypt('hello');
  assert.throws(() => cipher().decrypt(sealed));
});

test('names the missing variable when the keyring is empty', () => {
  assert.throws(() => cipher(''), /CONNECTOR_ENCRYPTION_KEYS/);
});

test('reports an unavailable key version using the subject', () => {
  const sealed = cipher(`1:${KEY_ONE}`).encrypt('hello');
  assert.throws(
    () => cipher(`2:${KEY_TWO}`).decrypt(sealed),
    /Connector encryption key version 1 is unavailable/,
  );
});
