// Cross-repo registry of the connection NAMES the user has configured, so Setup
// can offer a pick-list instead of blind free-text. Names only; never tokens
// (those live in SecretStorage) and never manifests (those are per-repo). It is
// persisted in the extension's installation-global Memento (context.globalState),
// so the list spans every repo on THIS machine.
//
// It is deliberately NOT opted into Settings Sync: pruning judges liveness by a
// machine-LOCAL token probe (SecretStorage is per-machine), so syncing the list
// would let one machine's pruning propagate deletions to another. Keeping it
// machine-local makes the list and the tokens it's judged against consistent.
//
// The list is ADDITIVE + RECONCILED, not blindly trusted: a name is kept only
// while it is still "alive" (has a token, or a backup in the current repo), so
// dead names don't pile up. Pruning is reliable despite SecretStorage having no
// "list keys" API: the registry IS the list of names, so we GET each name's
// token by key to test liveness. A name wrongly pruned (e.g. it has a backup in
// a different repo but no token) self-heals; opening that repo re-registers its
// configured connection on activation.
//
// This file stays free of any `vscode` import so the pure list/liveness logic is
// unit-testable; the Memento + secrets I/O that uses it lives in extension.ts.

import { normalizeConnectionName } from "./secrets";

/** globalState key holding the string[] of known connection names. */
export const KNOWN_CONNECTIONS_KEY = "trilkeep.knownConnections";

/** Union two name lists into a normalized, de-duplicated, sorted list. Pure. */
export function mergeConnectionNames(
  existing: readonly string[],
  add: readonly string[]
): string[] {
  const set = new Set<string>();
  for (const raw of [...existing, ...add]) {
    set.add(normalizeConnectionName(raw));
  }
  // Plain code-unit sort, not localeCompare: deterministic across platforms and
  // locales (important for the unit test and a stable picker order).
  return [...set].sort();
}

/** Order names for the Setup step-1 picker: the current connection FIRST (so the
 * quick-pick pre-selects it), then the rest normalized + de-duplicated + sorted.
 * Pure. */
export function orderConnectionNames(
  currentName: string,
  known: readonly string[]
): string[] {
  const current = normalizeConnectionName(currentName);
  const rest = mergeConnectionNames(known, []).filter((n) => n !== current);
  return [current, ...rest];
}

/** A connection is alive, worth keeping in the registry and offering in the
 * picker, if it still has a credential anywhere, or a backup in the current
 * repo. With no token you can't back up to it, so offering it elsewhere is a
 * dead end (and it re-registers if you open the repo that owns it). Pure. */
export function isConnectionAlive(
  hasToken: boolean,
  hasLocalManifest: boolean
): boolean {
  return hasToken || hasLocalManifest;
}
