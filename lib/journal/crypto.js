import { createKeyringCipher } from '../crypto/keyring.js';

export function createJournalCipher(serializedKeyring) {
  return createKeyringCipher({
    serializedKeyring,
    label: 'journal',
    subject: 'Journal',
    variableName: 'JOURNAL_ENCRYPTION_KEYS',
  });
}
