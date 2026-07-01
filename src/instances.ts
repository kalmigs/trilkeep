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

import { DEFAULT_INSTANCE_NAME, normalizeInstanceName } from './secrets';

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
  const token = hasToken ? 'has token' : 'no token';
  const backup = hasLocalManifest ? 'has backup here' : 'no backup here';
  return `${token} · ${backup}`;
}

/** The explicitly-set instance name from a VS Code `inspect()` result, using the
 * workspace-folder > workspace > global precedence, normalized; or undefined when
 * only the schema default applies (the package.json `default` is NOT read here, so
 * a defaulted setting reads as "not explicit"). Pure — the `inspect()` call stays
 * in extension.ts. Guards the "false default = current on a wiped repo" footgun. */
export function explicitInstanceFromInspect(scopes: {
  workspaceFolderValue?: string;
  workspaceValue?: string;
  globalValue?: string;
}): string | undefined {
  const value = scopes.workspaceFolderValue ?? scopes.workspaceValue ?? scopes.globalValue;
  return value && value.trim() ? normalizeInstanceName(value) : undefined;
}

/** A row of the Setup step-1 instance picker (the "enter a new name" action is
 * presentation and stays in extension.ts). */
export interface InstancePickerRow {
  name: string;
  isCurrent: boolean;
}

/** Rows for the Setup step-1 picker. ALWAYS offers the built-in default name, plus
 * every known instance, ordered current-first. `isCurrent` is true only for the
 * EXPLICITLY-configured instance (`explicitCurrent`), so a fresh/wiped repo still
 * LISTS "default" without falsely marking it current. Pure. */
export function buildInstancePickerRows(
  explicitCurrent: string | undefined,
  known: readonly string[],
): InstancePickerRow[] {
  const ordered = orderInstanceNames(explicitCurrent ?? DEFAULT_INSTANCE_NAME, [
    ...known,
    DEFAULT_INSTANCE_NAME,
  ]);
  return ordered.map(name => ({ name, isCurrent: name === explicitCurrent }));
}

/** Order the Forget picker's known instances current-first, but ONLY when the
 * current is explicitly set AND actually tracked (in `known`). Unlike the Setup
 * picker this does NOT inject "default" — Forget lists only trackable instances.
 * Pure. */
export function orderForgetInstances(
  explicitCurrent: string | undefined,
  known: readonly string[],
): string[] {
  return explicitCurrent && known.includes(explicitCurrent)
    ? [explicitCurrent, ...known.filter(n => n !== explicitCurrent)]
    : [...known];
}

/** Whether Setup should warn that a newly-typed instance name starts a SEPARATE
 * backup: only when the name differs from the effective current instance AND that
 * instance already has a backup in this repo. Pure; the manifest read (hasBackup)
 * stays in extension.ts. Guards accidental duplicate trees. */
export function shouldWarnNewInstance(
  typedName: string,
  effectiveInstance: string,
  effectiveHasBackup: boolean,
): boolean {
  return (
    effectiveHasBackup &&
    normalizeInstanceName(typedName) !== normalizeInstanceName(effectiveInstance)
  );
}
