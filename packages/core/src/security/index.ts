// Security domain: secret scrubbing, vault encryption, permission policies
export { DefaultSecretScrubber } from './secret-scrubber.js';
export {
  DefaultSecretVault,
  type SecretVaultOptions,
  decryptConfigSecrets,
  encryptConfigSecrets,
  rewriteConfigEncrypted,
  migratePlaintextSecrets,
} from './secret-vault.js';
export { isSecretField } from './secret-vault.js';
export {
  DefaultPermissionPolicy,
  AutoApprovePermissionPolicy,
  type PermissionPolicyOptions,
} from './permission-policy.js';

export {
  ToolCapabilities,
  DANGEROUS_FOR_SUBAGENTS,
  type ToolCapability,
  hasDangerousCapabilityForSubagents,
  hasCapability,
  getDangerousCapabilities,
} from './capabilities.js';
