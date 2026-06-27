// SecretStorage key derivation for ETAPI tokens. Kept free of any `vscode`
// import so the (security-relevant) keying logic can be unit-tested.

/** The pre-per-server token location: a single global slot, shared by every
 * server. migrateLegacyToken moves it onto a per-server key. */
export const LEGACY_TOKEN_KEY = "trilkeep.etapiToken";

/** SecretStorage key for a given server's token. Tokens are keyed by serverUrl
 * so distinct Trilium instances (e.g. a test and a real server) never share a
 * credential — the safety property that keeps a test run from carrying the real
 * instance's token. Trailing slashes and surrounding whitespace are normalised
 * so `http://x:8081` and `http://x:8081/ ` resolve to the same key. */
export function tokenKey(serverUrl: string): string {
  return `${LEGACY_TOKEN_KEY}:${serverUrl.trim().replace(/\/+$/, "")}`;
}
