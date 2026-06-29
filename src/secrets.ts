// Identity + SecretStorage key derivation for ETAPI tokens. Kept free of any
// `vscode` import so the (security-relevant) keying logic can be unit-tested.
//
// A Trilium instance is identified by a stable, user-chosen CONNECTION NAME
// (trilkeep.connectionName), NOT by its serverUrl. serverUrl is just a mutable
// address: on a LAN it churns (DHCP, roaming .local hosts), and ETAPI exposes no
// stable instance id to recover from. Keying the token (and the manifest) by a
// name the user controls means changing the URL never loses the token or
// duplicates the backup tree, while distinct names (e.g. "test" vs "real") keep
// distinct instances cleanly isolated.

/** The pre-per-connection token location: a single global slot, shared by every
 * server. migrateLegacyToken moves it onto a per-connection key. */
export const LEGACY_TOKEN_KEY = 'trilkeep.etapiToken';

/** The connection name used when the user hasn't set one. Single-instance users
 * never need to think about connection names. */
export const DEFAULT_CONNECTION_NAME = 'default';

/** Trim a connection name, falling back to "default" when blank. */
export function normalizeConnectionName(name: string): string {
  const trimmed = name.trim();
  return trimmed === '' ? DEFAULT_CONNECTION_NAME : trimmed;
}

/** SecretStorage key for a connection's token. Keyed by connection name so the
 * token survives serverUrl changes and never leaks between named instances. */
export function tokenKey(connectionName: string): string {
  return `${LEGACY_TOKEN_KEY}:${normalizeConnectionName(connectionName)}`;
}
