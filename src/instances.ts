// Cross-repo registry of the instance NAMES the user has configured, so Setup
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
// configured instance on activation.
//
// This file stays free of any `vscode` import so the pure list/liveness logic is
// unit-testable; the Memento + secrets I/O that uses it lives in extension.ts.

import { normalizeInstanceName } from './secrets';

/** globalState key holding the string[] of known instance names. */
export const KNOWN_INSTANCES_KEY = 'trilkeep.knownInstances';

/** Union two name lists into a normalized, de-duplicated, sorted list. Pure. */
export function mergeInstanceNames(existing: readonly string[], add: readonly string[]): string[] {
  const set = new Set<string>();
  for (const raw of [...existing, ...add]) {
    set.add(normalizeInstanceName(raw));
  }
  // Plain code-unit sort, not localeCompare: deterministic across platforms and
  // locales (important for the unit test and a stable picker order).
  return [...set].sort();
}

/** Order names for the Setup step-1 picker: the current instance FIRST (so the
 * quick-pick pre-selects it), then the rest normalized + de-duplicated + sorted.
 * Pure. */
export function orderInstanceNames(currentName: string, known: readonly string[]): string[] {
  const current = normalizeInstanceName(currentName);
  const rest = mergeInstanceNames(known, []).filter(n => n !== current);
  return [current, ...rest];
}

/** An instance is alive, worth keeping in the registry and offering in the
 * picker, if it still has a credential anywhere, or a backup in the current
 * repo. With no token you can't back up to it, so offering it elsewhere is a
 * dead end (and it re-registers if you open the repo that owns it). Pure. */
export function isInstanceAlive(hasToken: boolean, hasLocalManifest: boolean): boolean {
  return hasToken || hasLocalManifest;
}

/** Drop a name from the registry (normalized compare), returning the normalized,
 * de-duplicated, sorted remainder. No-op if the name isn't present. Used by the
 * Forget Instance command to stop tracking an instance. Pure. */
export function removeInstanceName(existing: readonly string[], remove: string): string[] {
  const target = normalizeInstanceName(remove);
  return mergeInstanceNames(existing, []).filter(n => n !== target);
}

/** One-line state annotation for an instance in the Forget picker: whether it
 * has a token (usable from any repo) and whether it has a backup in the current
 * repo. Pure. */
export function describeInstanceState(hasToken: boolean, hasLocalManifest: boolean): string {
  const token = hasToken ? 'token' : 'no token';
  const backup = hasLocalManifest ? 'backup here' : 'no backup here';
  return `${token} · ${backup}`;
}

/** How a Setup rename should treat the ETAPI token when carrying an instance
 * over to a new name. The token is installation-GLOBAL (shared across every repo
 * using a name), so the rename must never silently clobber another repo's
 * credential:
 *  - `skip`: the old name has no token, so there is nothing to carry;
 *  - `store`: the new name has no token, or already the same one — safe to write;
 *  - `confirm`: the new name already has a DIFFERENT token (another repo's
 *    instance) — overwriting it needs explicit confirmation.
 * Pure so this security-relevant "don't silently overwrite" rule is unit-tested;
 * the interactive confirm + the SecretStorage writes stay in extension.ts. */
export type RenameTokenAction = 'skip' | 'store' | 'confirm';
export function renameTokenAction(
  carried: string | undefined,
  existingNew: string | undefined,
): RenameTokenAction {
  if (carried === undefined) {
    return 'skip';
  }
  if (existingNew === undefined || existingNew === carried) {
    return 'store';
  }
  return 'confirm';
}
