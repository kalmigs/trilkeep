import * as path from 'node:path';

import * as vscode from 'vscode';

import { discoverFiles } from './allowlist';
import {
  buildInstancePickerRows,
  describeInstanceState,
  explicitInstanceFromInspect,
  KNOWN_INSTANCES_KEY,
  mergeInstanceNames,
  orderForgetInstances,
  removeInstanceName,
  shouldWarnNewInstance,
} from './instances';
import { EtapiClient, EtapiError, isInsecureRemoteUrl } from './etapiClient';
import { matchesAllowlist, parseGlobList, toPosix } from './globs';
import {
  deleteInstanceManifest,
  loadManifest,
  Manifest,
  manifestExists,
  saveManifest,
} from './manifest';
import { DEFAULT_INSTANCE_NAME, normalizeInstanceName, tokenKey } from './secrets';
import { planBackup, ProgressReporter, SyncEngine } from './sync';

// ETAPI tokens are keyed by INSTANCE NAME (trilkeep.instanceName), not by
// serverUrl. An instance name is a stable identity the user controls, so the
// token survives serverUrl changes (LAN IPs churn) and distinct names ("test"
// vs "real") never share a credential. See ./secrets for the key derivation.
function getToken(
  context: vscode.ExtensionContext,
  instanceName: string,
): Thenable<string | undefined> {
  return context.secrets.get(tokenKey(instanceName));
}

function storeToken(
  context: vscode.ExtensionContext,
  instanceName: string,
  token: string,
): Thenable<void> {
  return context.secrets.store(tokenKey(instanceName), token);
}

// ── Cross-repo instance-name registry (globalState). See ./instances. ──

/** Add a name to the known-instances registry (no-op if already present). */
async function rememberInstance(context: vscode.ExtensionContext, name: string): Promise<void> {
  const existing = context.globalState.get<string[]>(KNOWN_INSTANCES_KEY, []);
  const merged = mergeInstanceNames(existing, [name]);
  if (merged.length !== existing.length) {
    await context.globalState.update(KNOWN_INSTANCES_KEY, merged);
  }
}

/** Remove a name from the known-instances registry (no-op if absent). Note: if
 * the forgotten name is the CURRENTLY-configured instance and still has a token
 * or a local backup, activation's backfill re-registers it next startup. */
async function forgetInstanceName(context: vscode.ExtensionContext, name: string): Promise<void> {
  const existing = context.globalState.get<string[]>(KNOWN_INSTANCES_KEY, []);
  const remaining = removeInstanceName(existing, name);
  if (remaining.length !== existing.length) {
    await context.globalState.update(KNOWN_INSTANCES_KEY, remaining);
  }
}

/** The known instance names (normalized + de-duplicated + sorted). Names are added
 * by rememberInstance and removed ONLY by Forget Instance — no liveness-based
 * auto-prune (see instances.ts). The pickers annotate each with its live state. */
function knownInstances(context: vscode.ExtensionContext): string[] {
  return mergeInstanceNames(context.globalState.get<string[]>(KNOWN_INSTANCES_KEY, []), []);
}

function configuredServerUrl(): string {
  return vscode.workspace
    .getConfiguration('trilkeep')
    .get<string>('serverUrl', 'http://localhost:8080');
}

function configuredInstanceName(): string {
  return vscode.workspace
    .getConfiguration('trilkeep')
    .get<string>('instanceName', DEFAULT_INSTANCE_NAME);
}

/** The instance name the user has EXPLICITLY set (workspace/global setting), or
 * undefined when only the built-in `default` fallback applies. Used to mark
 * "current" in the pickers, so a fresh/wiped repo's fallback "default" isn't
 * labelled current (there's nothing configured yet). */
function explicitInstanceName(): string | undefined {
  return explicitInstanceFromInspect(
    vscode.workspace.getConfiguration('trilkeep').inspect<string>('instanceName') ?? {},
  );
}

let output: vscode.OutputChannel;

// Guards against overlapping backups (e.g. a save-triggered run racing a manual
// one). Concurrent runs would load the manifest independently and the last
// saveManifest would clobber the other's noteId mappings, creating duplicate
// Trilium notes.
let backupInFlight = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Trilkeep');
  context.subscriptions.push(output);

  // Register commands FIRST so they are always available, even if the
  // SecretStorage / globalState maintenance below fails (e.g. a locked OS keyring
  // makes secrets.get reject; that must not leave the extension command-less).
  context.subscriptions.push(
    vscode.commands.registerCommand('trilkeep.setup', () => setupCommand(context, false)),
    vscode.commands.registerCommand('trilkeep.setupAdvanced', () => setupCommand(context, true)),
    vscode.commands.registerCommand('trilkeep.backup', () => runBackupCommand(context)),
    vscode.commands.registerCommand('trilkeep.previewBackup', () => previewBackupCommand()),
    vscode.commands.registerCommand('trilkeep.setToken', () => setTokenCommand(context)),
    vscode.commands.registerCommand('trilkeep.clearToken', () => clearTokenCommand(context)),
    vscode.commands.registerCommand('trilkeep.forgetInstance', () =>
      forgetInstanceCommand(context),
    ),
    vscode.commands.registerCommand('trilkeep.testConnection', () =>
      testConnectionCommand(context),
    ),
  );

  // Best-effort startup: register THIS repo's configured instance in the
  // (machine-local) registry when it's actually in use (has a token or a backup
  // here), so it shows in the pickers. No pruning — names are removed only by
  // Forget Instance. Wrapped so a SecretStorage failure can't break activation or
  // the command registration above.
  try {
    const startupRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const startupInstance = configuredInstanceName();
    const startupInUse =
      !!(await getToken(context, startupInstance)) ||
      (startupRoot ? await manifestExists(startupRoot, startupInstance) : false);
    if (startupInUse) {
      await rememberInstance(context, startupInstance);
    }
  } catch (e) {
    output.appendLine(
      `Trilkeep: startup instance registration failed (${(e as Error).message}); continuing.`,
    );
  }

  // Optional backup on save: backs up ONLY the saved file(s), not the whole
  // workspace. Saves within the debounce window are batched together.
  let saveTimer: NodeJS.Timeout | undefined;
  const pendingSaves = new Set<string>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (!vscode.workspace.getConfiguration('trilkeep').get('backupOnSave')) {
        return;
      }
      if (doc.uri.scheme !== 'file') {
        return;
      }
      pendingSaves.add(doc.uri.fsPath);
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => {
        const batch = [...pendingSaves];
        pendingSaves.clear();
        void runSavedFilesBackup(context, batch);
      }, 1000);
    }),
  );

  // Optional full backup on activation (opt-in, default off). Catches up offline
  // edits (including deletes/moves) when the project reopens, without a manual
  // run. Fire-and-forget so it never delays activation; quiet so it reuses the
  // manual backup path (lock + allowlist + reconcile) without prompting, and
  // routes failures through the notify-once auto-backup handler. No token →
  // skipped quietly by buildClient; no folder → skipped by firstWorkspaceFolder.
  if (vscode.workspace.getConfiguration('trilkeep').get<boolean>('backupOnActivation', false)) {
    void runBackupCommand(context, true);
  }
}

export function deactivate(): void {
  // no-op
}

async function buildClient(
  context: vscode.ExtensionContext,
  quiet = false,
): Promise<EtapiClient | undefined> {
  const serverUrl = configuredServerUrl();
  const instanceName = configuredInstanceName();
  const token = await getToken(context, instanceName);
  if (!token) {
    // A quiet (save-triggered) run must not pop a modal on every save.
    if (quiet) {
      output.appendLine(`Skipped auto-backup: no ETAPI token set for instance "${instanceName}".`);
      return undefined;
    }
    const pick = await vscode.window.showWarningMessage(
      `No Trilium ETAPI token set for instance "${instanceName}". Set one now?`,
      'Set Token',
    );
    if (pick === 'Set Token') {
      await setTokenCommand(context);
    }
    return undefined;
  }
  if (isInsecureRemoteUrl(serverUrl)) {
    warnInsecureUrl(serverUrl);
  }
  return new EtapiClient(serverUrl, token);
}

// Warn (once per session) before the full-access ETAPI token is sent in
// cleartext to a non-loopback server. Logged every run, toasted only once so
// it doesn't spam on every save.
let insecureUrlWarned = false;
function warnInsecureUrl(serverUrl: string): void {
  output.appendLine(
    `WARNING ETAPI token sent over plaintext HTTP to a non-local server (${serverUrl}); use an https URL to protect it.`,
  );
  if (!insecureUrlWarned) {
    insecureUrlWarned = true;
    void vscode.window.showWarningMessage(
      `Trilkeep: your ETAPI token is being sent over unencrypted HTTP to ${serverUrl}. Use an https URL to protect it.`,
    );
  }
}

function firstWorkspaceFolder(quiet = false): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    // The quiet (save-triggered) path must not toast on every save when the
    // editor has a loose file open with no workspace folder.
    if (!quiet) {
      void vscode.window.showErrorMessage('Trilkeep: open a workspace folder to back up.');
    }
    return undefined;
  }
  return folders[0];
}

interface BackupConfig {
  include: string[];
  exclude: string[];
  rootNoteTitle: string;
  hardDeleteRemovedFiles: boolean;
  group: string;
  parentNoteId: string;
  readOnly: boolean;
}

function readConfig(): BackupConfig {
  const cfg = vscode.workspace.getConfiguration('trilkeep');
  return {
    include: cfg.get<string[]>('include', ['**/*.md']),
    exclude: cfg.get<string[]>('exclude', []),
    rootNoteTitle: cfg.get<string>('rootNoteTitle', ''),
    hardDeleteRemovedFiles: cfg.get<boolean>('hardDeleteRemovedFiles', false),
    group: cfg.get<string>('group', 'Trilkeep'),
    parentNoteId: cfg.get<string>('parentNoteId', ''),
    readOnly: cfg.get<boolean>('readOnly', true),
  };
}

function makeEngine(
  client: EtapiClient,
  manifest: Manifest,
  folder: vscode.WorkspaceFolder,
  cfg: BackupConfig,
  instanceName: string,
): SyncEngine {
  return new SyncEngine(
    client,
    manifest,
    {
      workspaceRoot: folder.uri.fsPath,
      workspaceName: folder.name,
      instanceName,
      rootNoteTitle: cfg.rootNoteTitle,
      hardDeleteRemovedFiles: cfg.hardDeleteRemovedFiles,
      group: cfg.group,
      parentNoteId: cfg.parentNoteId,
      readOnly: cfg.readOnly,
    },
    msg => output.appendLine(msg),
  );
}

/** Serialize backups: a second run while one is in flight is refused, so
 * concurrent runs can't race the manifest. */
async function withBackupLock(quiet: boolean, fn: () => Promise<void>): Promise<void> {
  if (backupInFlight) {
    if (!quiet) {
      void vscode.window.showInformationMessage('Trilkeep: a backup is already in progress.');
    }
    return;
  }
  backupInFlight = true;
  try {
    await fn();
  } finally {
    backupInFlight = false;
  }
}

/** Full backup of the whole workspace (manual command), with reconciliation. */
async function runBackupCommand(context: vscode.ExtensionContext, quiet = false): Promise<void> {
  const folder = firstWorkspaceFolder(quiet);
  if (!folder) {
    return;
  }
  // A quiet run is automatic (activation): route failures through the
  // notify-once handler so a down server doesn't toast on every launch.
  const reportRunError = quiet ? reportAutoBackupError : reportError;
  await withBackupLock(quiet, async () => {
    // Wrap the whole body: this can run fire-and-forget (quiet) from activation
    // (backupOnActivation), so a setup failure before the backup loop
    // (buildClient's keyring read, discoverFiles' fs walk, or loadManifest on a
    // corrupt state.json) would otherwise escape as an unhandled promise
    // rejection instead of routing through reportRunError (notify-once for auto
    // runs, a plain toast for the manual command).
    try {
      const client = await buildClient(context, quiet);
      if (!client) {
        return;
      }
      const cfg = readConfig();
      const instanceName = configuredInstanceName();
      const workspaceRoot = folder.uri.fsPath;
      const files = await discoverFiles(folder, cfg.include, cfg.exclude);
      const manifest = await loadManifest(workspaceRoot, instanceName);
      // An empty match needs care. If nothing was ever backed up, it's just a
      // no-op. But if the manifest HAS entries, proceeding would reconcile every
      // tracked path as removed; hard-delete would erase the whole tree, soft
      // delete would tombstone it. An empty match is almost always a mis-typed
      // include glob (or a transient empty scan), not a real "deleted everything",
      // so require explicit confirmation before a wholesale removal.
      if (files.length === 0) {
        const trackedCount = Object.keys(manifest.entries).length;
        if (trackedCount === 0) {
          if (!quiet) {
            void vscode.window.showInformationMessage(
              'Trilkeep: no files matched the include/exclude allowlist.',
            );
          }
          return;
        }
        if (quiet) {
          output.appendLine(
            `Skipped: 0 files matched but ${trackedCount} note(s) are tracked. Refusing to mass-reconcile on an empty match (likely a misconfigured include glob).`,
          );
          return;
        }
        const action = cfg.hardDeleteRemovedFiles
          ? 'DELETE all of them'
          : 'mark all of them as removed';
        const proceed = await vscode.window.showWarningMessage(
          `Trilkeep: 0 files matched your include globs, but ${trackedCount} note(s) are backed up. Continuing will ${action} in Trilium. This usually means a mis-typed include glob; check trilkeep.include.`,
          { modal: true },
          'Continue anyway',
        );
        if (proceed !== 'Continue anyway') {
          return;
        }
      }

      const engine = makeEngine(client, manifest, folder, cfg, instanceName);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Trilkeep backup',
          cancellable: true,
        },
        async (progress, cancelToken) => {
          const reporter: ProgressReporter = {
            report: message => progress.report({ message }),
            isCancelled: () => cancelToken.isCancellationRequested,
          };
          try {
            const summary = await engine.backup(files, reporter);
            await saveManifest(workspaceRoot, manifest, instanceName);
            await rememberInstance(context, instanceName);
            const line = `Trilkeep backup done. ${summary.created} created, ${summary.updated} updated, ${summary.skipped} unchanged, ${summary.removed} removed${
              summary.errors.length ? `, ${summary.errors.length} errors` : ''
            }.`;
            output.appendLine(line);
            if (!quiet || summary.errors.length) {
              void vscode.window.showInformationMessage(line);
            }
          } catch (e) {
            // Persist whatever progress was made before the failure.
            await saveManifest(workspaceRoot, manifest, instanceName).catch(() => undefined);
            reportRunError(e);
          }
        },
      );
    } catch (e) {
      reportRunError(e);
    }
  });
}

/** Dry run: report what a full backup WOULD do (which files are new/changed/
 * unchanged/skipped/removed) without contacting Trilium or writing anything. No
 * token required, so it works before any instance is configured. */
async function previewBackupCommand(): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    return;
  }
  const cfg = readConfig();
  const instanceName = configuredInstanceName();
  const workspaceRoot = folder.uri.fsPath;
  const files = await discoverFiles(folder, cfg.include, cfg.exclude);
  const manifest = await loadManifest(workspaceRoot, instanceName);
  const plan = await planBackup(workspaceRoot, files, manifest, cfg.hardDeleteRemovedFiles);

  const willWrite = plan.created.length + plan.updated.length;
  const removalNote = cfg.hardDeleteRemovedFiles
    ? 'would be deleted'
    : 'would be kept (soft delete)';

  output.appendLine('');
  output.appendLine(
    `── Trilkeep dry run · instance "${instanceName}" · ${files.length} file(s) matched the allowlist ──`,
  );
  const list = (tag: string, items: string[]) => {
    for (const rel of items) {
      output.appendLine(`  ${tag.padEnd(9)} ${rel}`);
    }
  };
  list('new', plan.created);
  list('changed', plan.updated);
  list('unchanged', plan.unchanged);
  for (const s of plan.skipped) {
    output.appendLine(`  ${'skipped'.padEnd(9)} ${s.rel} (${s.reason})`);
  }
  for (const rel of plan.removed) {
    output.appendLine(`  ${'removed'.padEnd(9)} ${rel} (${removalNote})`);
  }
  output.appendLine(
    `Summary: ${plan.created.length} new, ${plan.updated.length} changed, ${plan.unchanged.length} unchanged, ${plan.skipped.length} skipped, ${plan.removed.length} removed → ${willWrite} note(s) would be written. (Dry run; nothing changed.)`,
  );

  const removedPart = plan.removed.length ? `, ${plan.removed.length} removed` : '';
  const skippedPart = plan.skipped.length ? `, ${plan.skipped.length} skipped` : '';
  const pick = await vscode.window.showInformationMessage(
    `Trilkeep dry run: ${willWrite} of ${files.length} matched file(s) would be written ` +
      `(${plan.created.length} new, ${plan.updated.length} changed, ${plan.unchanged.length} unchanged${skippedPart}${removedPart}). Nothing was changed.`,
    'Show Details',
  );
  if (pick === 'Show Details') {
    output.show(true);
  }
}

/** Incremental backup of just the saved file(s); no full walk, no
 * reconciliation (absent files must NOT be treated as removed here). */
async function runSavedFilesBackup(
  context: vscode.ExtensionContext,
  fsPaths: string[],
): Promise<void> {
  const folder = firstWorkspaceFolder(true);
  if (!folder) {
    return;
  }
  await withBackupLock(true, async () => {
    // Wrap the whole body: this runs fire-and-forget from the save handler, so a
    // setup failure (e.g. a corrupt state.json that loadManifest rethrows, or a
    // secrets.get rejection) outside the inner try would otherwise surface as an
    // unhandled promise rejection.
    try {
      const client = await buildClient(context, true);
      if (!client) {
        return;
      }
      const cfg = readConfig();
      const instanceName = configuredInstanceName();
      const workspaceRoot = folder.uri.fsPath;
      const rels = fsPaths
        .map(fp => toPosix(path.relative(workspaceRoot, fp)))
        .filter(
          rel =>
            rel &&
            !rel.startsWith('../') &&
            !path.isAbsolute(rel) &&
            matchesAllowlist(rel, cfg.include, cfg.exclude),
        );
      if (rels.length === 0) {
        return;
      }

      const manifest = await loadManifest(workspaceRoot, instanceName);
      const engine = makeEngine(client, manifest, folder, cfg, instanceName);
      const reporter: ProgressReporter = {
        report: message => output.appendLine(message),
        isCancelled: () => false,
      };
      try {
        const summary = await engine.backup(rels, reporter, { reconcile: false });
        await saveManifest(workspaceRoot, manifest, instanceName);
        output.appendLine(
          `Auto-backup (save): ${summary.created} created, ${summary.updated} updated, ${summary.skipped} unchanged.`,
        );
      } catch (e) {
        // Persist whatever progress the engine made before the failure.
        await saveManifest(workspaceRoot, manifest, instanceName).catch(() => undefined);
        reportAutoBackupError(e);
      }
    } catch (e) {
      reportAutoBackupError(e);
    }
  });
}

/** Result of the step-1 instance picker: either an existing name was chosen,
 * or "new" with the text the user had typed into the filter (so the follow-up
 * input box can be seeded with it instead of making them retype). */
type InstancePick = { kind: 'existing'; name: string } | { kind: 'new'; seed: string };

/** Quick-pick that also captures the typed filter value; needed because the
 * simple showQuickPick promise API doesn't expose it. Accepting the
 * "enter a new name" item (or accepting with no matching item) returns the typed
 * text as the seed. */
function pickInstance(
  title: string,
  items: vscode.QuickPickItem[],
  enterNewLabel: string,
): Promise<InstancePick | undefined> {
  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick();
    qp.title = title;
    qp.placeholder = 'Pick an instance to configure, or type a new name';
    qp.items = items;
    qp.ignoreFocusOut = true;
    let resolved = false;
    const finish = (value: InstancePick | undefined) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
      qp.hide();
    };
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (sel && sel.label !== enterNewLabel) {
        finish({ kind: 'existing', name: sel.label });
      } else {
        finish({ kind: 'new', seed: qp.value.trim() });
      }
    });
    qp.onDidHide(() => {
      finish(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

/**
 * Guided setup, shared by Quick and Advanced. Advanced (full) walks every
 * Trilkeep setting; Quick asks only the essentials (instance, server URL,
 * token, on-save). Each step is pre-filled with the current value, so it doubles
 * as a "review & edit config" flow that can be re-run any time. Nothing is
 * applied until every step is answered; pressing Escape at any point aborts with
 * no changes (no half-applied config). The ETAPI token is never shown: the step
 * reports only whether one is already set, and a blank answer keeps the existing
 * token.
 */
async function setupCommand(context: vscode.ExtensionContext, full: boolean): Promise<void> {
  // Settings are written at workspace scope (.vscode/settings.json), which
  // requires an open folder. The token still goes to (global) SecretStorage.
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showErrorMessage('Trilkeep: open a workspace folder before running Setup.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('trilkeep');
  const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const effectiveInstance = normalizeInstanceName(
    cfg.get<string>('instanceName', DEFAULT_INSTANCE_NAME),
  );
  const stepCount = full ? 11 : 4;
  const step = (n: number, label: string) => `Trilkeep Setup (${n}/${stepCount}): ${label}`;

  // 1) Instance name: pick a known instance or enter a new name. The token and
  // manifest are keyed by it, so the server URL below can change freely without
  // losing either. Instance names are IMMUTABLE: you pick an existing one or
  // create a new one, but there is no rename (a new name is a new backup tree;
  // an existing one resumes its own state).
  const known = knownInstances(context);
  // buildInstancePickerRows: always OFFER "default" + known, current-first, with the
  // "current" label ONLY for an explicitly-configured instance (see instances.ts).
  const rows = buildInstancePickerRows(explicitInstanceName(), known);
  const ENTER_NEW = '$(add) Enter a new name…';
  const nameItems: vscode.QuickPickItem[] = [
    ...rows.map(row => ({
      label: row.name,
      description: row.isCurrent ? 'current' : undefined,
    })),
    { label: ENTER_NEW, alwaysShow: true },
  ];
  const namePick = await pickInstance(step(1, 'Instance name'), nameItems, ENTER_NEW);
  if (!namePick) {
    return;
  }
  let instanceName: string;
  if (namePick.kind === 'new') {
    const raw = await vscode.window.showInputBox({
      title: step(1, 'New instance name'),
      prompt:
        'A name to identify this Trilium instance (e.g. "real", "test") — keys its token + backup state.',
      // Seed with whatever was typed into the picker filter, so it isn't retyped.
      value: namePick.seed,
      ignoreFocusOut: true,
      validateInput: v => (v.trim() === '' ? 'Enter a name (use "default" if unsure).' : undefined),
    });
    if (raw === undefined) {
      return;
    }
    instanceName = raw.trim();
    // A new name in a repo that already backs up under a DIFFERENT instance
    // starts a SEPARATE tree — and duplicates notes if it points at the same
    // Trilium. Warn (instances are immutable, so this is not a rename), so a typo
    // or a "same server, new name" mistake doesn't silently create a parallel backup.
    const effectiveHasBackup = !!(await loadManifest(workspaceRoot, effectiveInstance)).rootNoteId;
    if (shouldWarnNewInstance(instanceName, effectiveInstance, effectiveHasBackup)) {
      const proceed = await vscode.window.showWarningMessage(
        `This repo already backs up to instance "${effectiveInstance}". Setting up "${instanceName}" starts a SEPARATE backup (a new tree in Trilium); pointing it at the same server would duplicate your notes. Continue with "${instanceName}"?`,
        { modal: true },
        'Continue',
      );
      if (proceed !== 'Continue') {
        return;
      }
    }
  } else {
    instanceName = namePick.name;
  }

  // 2) ETAPI token: keyed to the instance chosen above (not the saved config), so
  // the token follows the instance you're configuring. Asked right after the
  // instance name (and before the server URL) because the name + token are the
  // two things keyed/persisted together as the instance identity; the server URL
  // is just a mutable address that comes after. Never display the existing value;
  // blank keeps it.
  const hasToken = !!(await getToken(context, instanceName));
  const token = await vscode.window.showInputBox({
    title: step(2, 'ETAPI Token'),
    prompt: hasToken
      ? `A token is already set for instance "${instanceName}". Enter a new one to replace it, or leave blank to keep it.`
      : `No token set for instance "${instanceName}" yet. Paste its Trilium ETAPI token (Options → ETAPI).`,
    placeHolder: hasToken ? '•••••••• (leave blank to keep current)' : '',
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) {
    return;
  }

  // 3) Server URL
  const serverUrl = await vscode.window.showInputBox({
    title: step(3, 'Server URL'),
    prompt: 'Trilium server URL (just the address; may change over time)',
    value: cfg.get<string>('serverUrl', 'http://localhost:8080'),
    ignoreFocusOut: true,
    validateInput: v => {
      try {
        new URL(v.trim());
        return undefined;
      } catch {
        return 'Enter a valid URL, e.g. http://localhost:8080';
      }
    },
  });
  if (serverUrl === undefined) {
    return;
  }

  // Back up on save is the one automatic-backup toggle Quick also asks (its step
  // 4/4), because it defines the automatic-vs-manual experience. Advanced asks it
  // (step 8) plus back up on activation (step 9, Advanced-only); each is a helper
  // used by the flow(s) that need it.
  const askOnSave = (n: number) =>
    pickYesNo(
      step(n, 'Back up on save?'),
      cfg.get<boolean>('backupOnSave', false),
      'Also back up each file right after you save it',
      'Only back up when you run the command (default)',
    );
  const askOnActivation = (n: number) =>
    pickYesNo(
      step(n, 'Back up when the workspace opens?'),
      cfg.get<boolean>('backupOnActivation', false),
      'Also run a full backup each time this workspace opens',
      'Only back up when you run the command (default)',
    );
  let onSave: 'Yes' | 'No' = cfg.get<boolean>('backupOnSave', false) ? 'Yes' : 'No';
  let onActivation: 'Yes' | 'No' = cfg.get<boolean>('backupOnActivation', false) ? 'Yes' : 'No';
  if (!full) {
    const os = await askOnSave(4);
    if (!os) {
      return;
    }
    onSave = os;
  }

  // The remaining settings are FULL setup only. Quick stops after on-save and
  // applies just its essentials (instance, server URL, token, on-save), leaving
  // every advanced setting (including on-activation) at its current value/default.
  // Collected before any apply so the wizard stays atomic (Esc anywhere = no
  // changes).
  let rootNoteTitle = '';
  let group = '';
  let includeRaw = '';
  let excludeRaw = '';
  let hardDelete: 'Yes' | 'No' = 'No';
  let readOnly: 'Yes' | 'No' = 'No';
  if (full) {
    // 4) Root note title: this workspace's own root note title; blank = the
    // folder name. (The "Trilkeep" grouping/branding lives in trilkeep.group.)
    const rt = await vscode.window.showInputBox({
      title: step(4, 'Root Note Title'),
      prompt:
        "Title for this workspace's root note in Trilium (leave blank to use the folder name)",
      value: cfg.get<string>('rootNoteTitle', ''),
      ignoreFocusOut: true,
    });
    if (rt === undefined) {
      return;
    }
    rootNoteTitle = rt;

    // 5) Group: container path to nest this backup under (blank = Trilium root).
    const g = await vscode.window.showInputBox({
      title: step(5, 'Group'),
      prompt:
        'Container path to nest this backup under, e.g. "Trilkeep" or "Trilkeep/work" (Trilkeep creates/reuses the containers). Leave blank to place it directly under Trilium\'s root. (To nest under one of your own notes instead, set trilkeep.parentNoteId in settings.)',
      value: cfg.get<string>('group', 'Trilkeep'),
      ignoreFocusOut: true,
    });
    if (g === undefined) {
      return;
    }
    group = g;

    // 6) Include globs (comma-separated)
    const inc = await vscode.window.showInputBox({
      title: step(6, 'Include globs'),
      prompt: 'Comma-separated globs of files to back up',
      value: cfg.get<string[]>('include', ['**/*.md']).join(', '),
      ignoreFocusOut: true,
      validateInput: v =>
        parseGlobList(v).length === 0 ? 'Enter at least one glob, e.g. **/*.md' : undefined,
    });
    if (inc === undefined) {
      return;
    }
    includeRaw = inc;

    // 7) Exclude globs (comma-separated; may be empty)
    const exc = await vscode.window.showInputBox({
      title: step(7, 'Exclude globs'),
      prompt: 'Comma-separated globs to skip (leave blank for none)',
      value: cfg.get<string[]>('exclude', []).join(', '),
      ignoreFocusOut: true,
    });
    if (exc === undefined) {
      return;
    }
    excludeRaw = exc;

    // 8) Back up on save?
    const os = await askOnSave(8);
    if (!os) {
      return;
    }
    onSave = os;

    // 9) Back up when the workspace opens?
    const oa = await askOnActivation(9);
    if (!oa) {
      return;
    }
    onActivation = oa;

    // 10) Hard-delete removed files?
    const hd = await pickYesNo(
      step(10, 'Hard-delete removed files?'),
      cfg.get<boolean>('hardDeleteRemovedFiles', false),
      'Permanently delete the Trilium note when its file is removed',
      'Keep removed files in Trilium (soft delete, default)',
    );
    if (!hd) {
      return;
    }
    hardDelete = hd;

    // 11) Read-only mirror?
    const ro = await pickYesNo(
      step(11, 'Read-only mirror?'),
      cfg.get<boolean>('readOnly', true),
      'Mark the mirrored tree read-only in Trilium (discourage edits there, default)',
      'Leave the mirrored tree editable in Trilium',
    );
    if (!ro) {
      return;
    }
    readOnly = ro;
  }

  // All answered. Apply to this workspace's .vscode/settings.json.
  const target = vscode.ConfigurationTarget.Workspace;
  await cfg.update('instanceName', instanceName, target);
  await cfg.update('serverUrl', serverUrl.trim(), target);
  await cfg.update('backupOnSave', onSave === 'Yes', target);
  // Quick setup writes only the essentials above; the advanced settings below are
  // left untouched (existing value / default) so a quick re-run never clobbers them.
  if (full) {
    await cfg.update('backupOnActivation', onActivation === 'Yes', target);
    await cfg.update('rootNoteTitle', rootNoteTitle.trim(), target);
    await cfg.update('group', group.trim(), target);
    await cfg.update('include', parseGlobList(includeRaw), target);
    await cfg.update('exclude', parseGlobList(excludeRaw), target);
    await cfg.update('hardDeleteRemovedFiles', hardDelete === 'Yes', target);
    await cfg.update('readOnly', readOnly === 'Yes', target);
  }
  if (token.trim()) {
    await storeToken(context, instanceName, token.trim());
  }
  // Register the configured instance so it appears in this and other repos'
  // pickers. (A dead, token-less instance is pruned on the next activation.)
  await rememberInstance(context, instanceName);

  const tokenState = token.trim() ? 'token saved' : hasToken ? 'token kept' : 'no token set';
  const next = await vscode.window.showInformationMessage(
    `Trilkeep setup saved (${tokenState}). Back up the workspace now?`,
    'Back Up Now',
    'Test Connection',
    'Dry Run',
    'Not Now',
  );
  if (next === 'Back Up Now') {
    await runBackupCommand(context); // a real backup also verifies the instance
  } else if (next === 'Test Connection') {
    await testConnectionCommand(context); // verify the token/URL without writing
  } else if (next === 'Dry Run') {
    await previewBackupCommand(); // offline preview; needs no token
  }
}

/** Yes/No quick pick with the current value listed first. Returns "Yes"/"No",
 * or undefined if the user escaped. */
async function pickYesNo(
  title: string,
  current: boolean,
  yesDescription: string,
  noDescription: string,
): Promise<'Yes' | 'No' | undefined> {
  const yes = { label: 'Yes', description: yesDescription };
  const no = { label: 'No', description: noDescription };
  const pick = await vscode.window.showQuickPick(current ? [yes, no] : [no, yes], {
    title,
    ignoreFocusOut: true,
  });
  return pick ? (pick.label as 'Yes' | 'No') : undefined;
}

/** Annotated quick-pick items for a manage-an-instance command (Forget, Clear
 * Token): each name labelled with its state ("has token · has backup here", …),
 * the current one marked "current". Shared so the pickers stay consistent. */
async function annotatedInstanceItems(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
  ordered: readonly string[],
  currentName: string | undefined,
): Promise<vscode.QuickPickItem[]> {
  const items: vscode.QuickPickItem[] = [];
  for (const name of ordered) {
    let hasToken = false;
    let hasManifest = false;
    try {
      hasToken = !!(await getToken(context, name));
      hasManifest = workspaceRoot ? await manifestExists(workspaceRoot, name) : false;
    } catch {
      // Best-effort annotation; a locked keyring shouldn't break the picker.
    }
    const state = describeInstanceState(hasToken, hasManifest);
    items.push({
      label: name,
      description: name === currentName ? `current · ${state}` : state,
    });
  }
  return items;
}

// Set the ETAPI token for the CURRENT (configured) instance. To set a different
// instance's token, switch to it in Setup first — kept current-only (unlike the
// Clear/Forget pickers) since setting a token is normally part of configuring one.
async function setTokenCommand(context: vscode.ExtensionContext): Promise<void> {
  const instanceName = configuredInstanceName();
  const token = await vscode.window.showInputBox({
    title: `Set ETAPI Token — current instance "${instanceName}"`,
    prompt: `Token for the CURRENT instance "${instanceName}" (Options → ETAPI in Trilium). To set another instance's token, switch to it in Setup first.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) {
    return;
  }
  await storeToken(context, instanceName, token.trim());
  await rememberInstance(context, instanceName);
  void vscode.window.showInformationMessage(
    `Trilium ETAPI token stored for instance "${instanceName}".`,
  );
}

// Clear an instance's (global) ETAPI token. Shows the instance picker (current
// first) like Forget, so you can clear ANY instance's token, not just the current.
async function clearTokenCommand(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = firstWorkspaceFolder(true)?.uri.fsPath;
  const known = knownInstances(context);
  if (known.length === 0) {
    void vscode.window.showInformationMessage('Trilkeep: no known instances to clear a token for.');
    return;
  }
  const currentName = explicitInstanceName();
  const ordered = orderForgetInstances(currentName, known);
  const items = await annotatedInstanceItems(context, workspaceRoot, ordered, currentName);
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Trilkeep: Clear ETAPI Token',
    placeHolder: 'Pick an instance to clear the ETAPI token for',
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  await context.secrets.delete(tokenKey(picked.label));
  void vscode.window.showInformationMessage(
    `Trilium ETAPI token cleared for instance "${picked.label}".`,
  );
}

// Stop tracking an instance: drop it from the cross-repo picker registry and
// clear its (global) token, optionally discarding this repo's backup state.
// Trilium is never touched. Complements Clear ETAPI Token, which only acts on
// the currently-configured instance; this can manage any known instance.
async function forgetInstanceCommand(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = firstWorkspaceFolder(true)?.uri.fsPath;
  const known = knownInstances(context);
  if (known.length === 0) {
    void vscode.window.showInformationMessage('Trilkeep: no known instances to forget.');
    return;
  }

  // Annotate each name with its state (token? backup here?), current marked first,
  // so the choice is informed (forgetting the current one re-registers on the next
  // activation, so it's rarely intended).
  const currentName = explicitInstanceName();
  const ordered = orderForgetInstances(currentName, known);
  const items = await annotatedInstanceItems(context, workspaceRoot, ordered, currentName);
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Trilkeep: Forget Instance',
    placeHolder: 'Pick an instance to stop tracking',
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  const name = picked.label;

  // Modal confirm carrying the cross-repo token warning: the token is in
  // installation-global SecretStorage, so clearing it affects every repo that
  // uses this name, and we can't enumerate them. Hence the unconditional warning.
  const proceed = await vscode.window.showWarningMessage(
    `Forget instance "${name}"? Its ETAPI token is stored globally, so any other repo using "${name}" will need it re-entered. Trilium notes are left intact.`,
    { modal: true },
    'Forget',
  );
  if (proceed !== 'Forget') {
    return;
  }

  // Backup-state choice. Retaining is the safe default: a kept manifest lets a
  // later re-add resume with no duplicates; deleting it means re-adding rebuilds
  // child notes under new ids (the root re-attaches by stamp, but per-note ids
  // live only in the manifest). Only offered when a backup actually exists here.
  let deleteManifest = false;
  if (workspaceRoot && (await manifestExists(workspaceRoot, name))) {
    const KEEP = 'Keep backup state (recommended)';
    const DELETE = 'Delete backup state';
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: KEEP,
          description:
            "Leave this repo's state on disk so re-adding resumes cleanly (no duplicates).",
        },
        {
          label: DELETE,
          description: 'Also delete it; re-adding later will DUPLICATE child notes in Trilium.',
        },
      ],
      { title: `Forget "${name}": backup state in this repo`, ignoreFocusOut: true },
    );
    if (!choice) {
      return;
    }
    deleteManifest = choice.label === DELETE;
  }

  await forgetInstanceName(context, name);
  await context.secrets.delete(tokenKey(name));
  if (deleteManifest && workspaceRoot) {
    await deleteInstanceManifest(workspaceRoot, name);
  }

  const tail = deleteManifest ? " and deleted this repo's backup state" : '';
  void vscode.window.showInformationMessage(
    `Trilkeep: forgot instance "${name}"${tail}. Trilium notes were left intact.`,
  );
}

async function testConnectionCommand(context: vscode.ExtensionContext): Promise<void> {
  const client = await buildClient(context);
  if (!client) {
    return;
  }
  try {
    const info = await client.appInfo();
    void vscode.window.showInformationMessage(
      `Connected to Trilium ${info.appVersion} (db ${info.dbVersion}).`,
    );
  } catch (e) {
    reportError(e);
  }
}

function formatError(e: unknown): string {
  return e instanceof EtapiError
    ? e.body
      ? `${e.message}: ${e.body}`
      : e.message
    : e instanceof Error
      ? e.message
      : String(e);
}

// Error from a user-invoked action (a manual command): always toast, since the
// user is waiting on the result.
function reportError(e: unknown): void {
  const msg = formatError(e);
  output.appendLine(`ERROR ${msg}`);
  void vscode.window.showErrorMessage(`Trilkeep: ${msg}`);
}

// Error from an AUTOMATIC run (backup on activation / on save). Always logged to
// the output channel, but toasts only the FIRST time per session so repeated
// auto-runs (every save, every launch) don't nag. The flag lives in the
// extension-host process, so a new session (reload window, reopen folder, restart
// VS Code) resets it. Same warn-once pattern as insecureUrlWarned.
let autoBackupErrorWarned = false;
function reportAutoBackupError(e: unknown): void {
  const msg = formatError(e);
  output.appendLine(`ERROR (auto-backup) ${msg}`);
  if (!autoBackupErrorWarned) {
    autoBackupErrorWarned = true;
    void vscode.window.showErrorMessage(`Trilkeep: automatic backup failed: ${msg}`);
  }
}
