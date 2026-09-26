/** Opt-in encrypted vault mode — see docs/encrypted-vaults.md. */
export {
  VaultCrypto,
  VaultLockedError,
  WrongVaultKeyError,
  ENCRYPTION_CONFIG_FILE,
  VAULT_PASSPHRASE_ENV,
  generateRecoveryPassphrase,
  decodeKek,
  encodeKek,
} from "./vault-crypto.js";
export type { EncryptionConfig, VaultCryptoOptions } from "./vault-crypto.js";
export {
  MemoryKeyStore,
  InterimFileKeyStore,
  setDefaultVaultKeyStore,
  getDefaultVaultKeyStore,
  kekAccount,
  VAULT_KEY_ENV,
} from "./key-store.js";
export type { VaultKeyStore } from "./key-store.js";
export { DecryptionFailedError, isArmoredText, isSealedBinary } from "./envelope.js";
export type { ScryptParams } from "./envelope.js";
export { encryptVault, decryptVault } from "./migrate.js";
export type { EncryptVaultOptions, EncryptVaultResult, DecryptVaultResult } from "./migrate.js";
