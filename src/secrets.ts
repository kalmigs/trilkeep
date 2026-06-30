// Identity + SecretStorage key derivation for ETAPI tokens. Kept free of any
// `vscode` import so the (security-relevant) keying logic can be unit-tested.
//
// A Trilium instance is identified by a stable, user-chosen NAME
// (trilkeep.instanceName), NOT by its serverUrl. serverUrl is just a mutable
// address: on a LAN it churns (DHCP, roaming .local hosts), and ETAPI exposes no
// stable server id to recover from. Keying the token (and the manifest) by a
// name the user controls means changing the URL never loses the token or
// duplicates the backup tree, while distinct names (e.g. "test" vs "real") keep
// distinct instances cleanly isolated.

/** Prefix for per-instance ETAPI token keys in SecretStorage. The full key is
 * `${TOKEN_KEY_PREFIX}:${instanceName}` (see tokenKey). */
export const TOKEN_KEY_PREFIX = 'trilkeep.etapiToken';

/** The name used when the user hasn't set one. Someone backing up a single
 * Trilium never has to set or think about a name. */
export const DEFAULT_INSTANCE_NAME = 'default';

/** Trim an instance name, falling back to "default" when blank. */
export function normalizeInstanceName(name: string): string {
  const trimmed = name.trim();
  return trimmed === '' ? DEFAULT_INSTANCE_NAME : trimmed;
}

/** SecretStorage key for an instance's token. Keyed by instance name so the
 * token survives serverUrl changes and never leaks between named instances. */
export function tokenKey(instanceName: string): string {
  return `${TOKEN_KEY_PREFIX}:${normalizeInstanceName(instanceName)}`;
}
