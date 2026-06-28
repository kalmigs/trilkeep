import * as path from "node:path";

import * as vscode from "vscode";

import { discoverFiles } from "./allowlist";
import {
  isConnectionAlive,
  KNOWN_CONNECTIONS_KEY,
  mergeConnectionNames,
} from "./connections";
import { EtapiClient, EtapiError, isInsecureRemoteUrl } from "./etapiClient";
import { matchesAllowlist, parseGlobList, toPosix } from "./globs";
import {
  loadManifest,
  Manifest,
  manifestExists,
  renameConnectionManifest,
  saveManifest,
} from "./manifest";
import {
  DEFAULT_CONNECTION_NAME,
  LEGACY_TOKEN_KEY,
  tokenKey,
} from "./secrets";
import {
  planBackup,
  ProgressReporter,
  renameRootConnectionLabel,
  SyncEngine,
} from "./sync";

// ETAPI tokens are keyed by CONNECTION NAME (trilkeep.connectionName), not by
// serverUrl. A connection name is a stable identity the user controls, so the
// token survives serverUrl changes (LAN IPs churn) and distinct names ("test"
// vs "real") never share a credential. See ./secrets for the key derivation.
function getToken(
  context: vscode.ExtensionContext,
  connectionName: string
): Thenable<string | undefined> {
  return context.secrets.get(tokenKey(connectionName));
}

function storeToken(
  context: vscode.ExtensionContext,
  connectionName: string,
  token: string
): Thenable<void> {
  return context.secrets.store(tokenKey(connectionName), token);
}

// ── Cross-repo connection-name registry (globalState). See ./connections. ──

/** Add a name to the known-connections registry (no-op if already present). */
async function rememberConnection(
  context: vscode.ExtensionContext,
  name: string
): Promise<void> {
  const existing = context.globalState.get<string[]>(KNOWN_CONNECTIONS_KEY, []);
  const merged = mergeConnectionNames(existing, [name]);
  if (merged.length !== existing.length) {
    await context.globalState.update(KNOWN_CONNECTIONS_KEY, merged);
  }
}

/** Prune registry names that are no longer alive (no token AND no backup in this
 * repo), then return the surviving, sorted list. Reliable despite SecretStorage
 * being non-enumerable: we probe each KNOWN name's token by key. Pruning is
 * non-destructive — a name re-registers when its repo is opened or a token is
 * set. */
async function reconcileKnownConnections(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined
): Promise<string[]> {
  const known = context.globalState.get<string[]>(KNOWN_CONNECTIONS_KEY, []);
  const alive: string[] = [];
  for (const name of known) {
    const hasToken = !!(await getToken(context, name));
    const hasLocalManifest = workspaceRoot
      ? await manifestExists(workspaceRoot, name)
      : false;
    if (isConnectionAlive(hasToken, hasLocalManifest)) {
      alive.push(name);
    }
  }
  const result = mergeConnectionNames(alive, []);
  if (result.length !== known.length) {
    await context.globalState.update(KNOWN_CONNECTIONS_KEY, result);
  }
  return result;
}

function configuredServerUrl(): string {
  return vscode.workspace
    .getConfiguration("trilkeep")
    .get<string>("serverUrl", "http://localhost:8080");
}

function configuredConnectionName(): string {
  return vscode.workspace
    .getConfiguration("trilkeep")
    .get<string>("connectionName", DEFAULT_CONNECTION_NAME);
}

/** One-time upgrade from the old single global token to the per-connection key.
 * Adopts the legacy token for the currently-configured connection (unless it
 * already has one), then drops the legacy key. No-op once migrated. */
async function migrateLegacyToken(
  context: vscode.ExtensionContext
): Promise<void> {
  const legacy = await context.secrets.get(LEGACY_TOKEN_KEY);
  if (!legacy) {
    return;
  }
  const key = tokenKey(configuredConnectionName());
  if (!(await context.secrets.get(key))) {
    await context.secrets.store(key, legacy);
  }
  await context.secrets.delete(LEGACY_TOKEN_KEY);
}

let output: vscode.OutputChannel;

// Guards against overlapping backups (e.g. a save-triggered run racing a manual
// one). Concurrent runs would load the manifest independently and the last
// saveManifest would clobber the other's noteId mappings, creating duplicate
// Trilium notes.
let backupInFlight = false;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  output = vscode.window.createOutputChannel("Trilkeep");
  context.subscriptions.push(output);

  // Upgrade any pre-per-server token before the first backup can read it.
  await migrateLegacyToken(context);

  // Keep the connection registry healthy across windows/machines: sync it, prune
  // dead names, and re-register the current connection if it has a token or a
  // backup here (this is what self-heals a name pruned while another repo was
  // open). See ./connections.
  context.globalState.setKeysForSync([KNOWN_CONNECTIONS_KEY]);
  const startupRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  await reconcileKnownConnections(context, startupRoot);
  const startupConnection = configuredConnectionName();
  const startupAlive =
    !!(await getToken(context, startupConnection)) ||
    (startupRoot ? await manifestExists(startupRoot, startupConnection) : false);
  if (startupAlive) {
    await rememberConnection(context, startupConnection);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("trilkeep.setup", () =>
      setupCommand(context)
    ),
    vscode.commands.registerCommand("trilkeep.backup", () =>
      runBackupCommand(context)
    ),
    vscode.commands.registerCommand("trilkeep.previewBackup", () =>
      previewBackupCommand()
    ),
    vscode.commands.registerCommand("trilkeep.setToken", () =>
      setTokenCommand(context)
    ),
    vscode.commands.registerCommand("trilkeep.clearToken", () =>
      clearTokenCommand(context)
    ),
    vscode.commands.registerCommand("trilkeep.testConnection", () =>
      testConnectionCommand(context)
    )
  );

  // Optional backup on save: backs up ONLY the saved file(s), not the whole
  // workspace. Saves within the debounce window are batched together.
  let saveTimer: NodeJS.Timeout | undefined;
  const pendingSaves = new Set<string>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!vscode.workspace.getConfiguration("trilkeep").get("backupOnSave")) {
        return;
      }
      if (doc.uri.scheme !== "file") {
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
    })
  );
}

export function deactivate(): void {
  // no-op
}

async function buildClient(
  context: vscode.ExtensionContext,
  quiet = false
): Promise<EtapiClient | undefined> {
  const serverUrl = configuredServerUrl();
  const connectionName = configuredConnectionName();
  const token = await getToken(context, connectionName);
  if (!token) {
    // A quiet (save-triggered) run must not pop a modal on every save.
    if (quiet) {
      output.appendLine(
        `Skipped auto-backup: no ETAPI token set for connection "${connectionName}".`
      );
      return undefined;
    }
    const pick = await vscode.window.showWarningMessage(
      `No Trilium ETAPI token set for connection "${connectionName}". Set one now?`,
      "Set Token"
    );
    if (pick === "Set Token") {
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
    `WARNING ETAPI token sent over plaintext HTTP to a non-local server (${serverUrl}); use an https URL to protect it.`
  );
  if (!insecureUrlWarned) {
    insecureUrlWarned = true;
    void vscode.window.showWarningMessage(
      `Trilkeep: your ETAPI token is being sent over unencrypted HTTP to ${serverUrl}. Use an https URL to protect it.`
    );
  }
}

function firstWorkspaceFolder(
  quiet = false
): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    // The quiet (save-triggered) path must not toast on every save when the
    // editor has a loose file open with no workspace folder.
    if (!quiet) {
      void vscode.window.showErrorMessage(
        "Trilkeep: open a workspace folder to back up."
      );
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
}

function readConfig(): BackupConfig {
  const cfg = vscode.workspace.getConfiguration("trilkeep");
  return {
    include: cfg.get<string[]>("include", ["**/*.md"]),
    exclude: cfg.get<string[]>("exclude", []),
    rootNoteTitle: cfg.get<string>("rootNoteTitle", "Trilkeep"),
    hardDeleteRemovedFiles: cfg.get<boolean>("hardDeleteRemovedFiles", false),
  };
}

function makeEngine(
  client: EtapiClient,
  manifest: Manifest,
  folder: vscode.WorkspaceFolder,
  cfg: BackupConfig,
  connectionName: string
): SyncEngine {
  return new SyncEngine(
    client,
    manifest,
    {
      workspaceRoot: folder.uri.fsPath,
      workspaceName: folder.name,
      connectionName,
      rootNoteTitle: cfg.rootNoteTitle,
      hardDeleteRemovedFiles: cfg.hardDeleteRemovedFiles,
    },
    (msg) => output.appendLine(msg)
  );
}

/** Serialize backups: a second run while one is in flight is refused, so
 * concurrent runs can't race the manifest. */
async function withBackupLock(
  quiet: boolean,
  fn: () => Promise<void>
): Promise<void> {
  if (backupInFlight) {
    if (!quiet) {
      void vscode.window.showInformationMessage(
        "Trilkeep: a backup is already in progress."
      );
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
async function runBackupCommand(
  context: vscode.ExtensionContext,
  quiet = false
): Promise<void> {
  const folder = firstWorkspaceFolder(quiet);
  if (!folder) {
    return;
  }
  await withBackupLock(quiet, async () => {
    const client = await buildClient(context, quiet);
    if (!client) {
      return;
    }
    const cfg = readConfig();
    const connectionName = configuredConnectionName();
    const workspaceRoot = folder.uri.fsPath;
    const files = await discoverFiles(folder, cfg.include, cfg.exclude);
    const manifest = await loadManifest(workspaceRoot, connectionName);
    // Only short-circuit when there's also nothing previously backed up. If the
    // manifest has entries, an empty file list still needs reconciliation —
    // e.g. every tracked file was deleted, so hard-delete must remove the notes
    // (and soft-delete must tombstone them). The engine handles backup([]).
    if (files.length === 0 && Object.keys(manifest.entries).length === 0) {
      if (!quiet) {
        void vscode.window.showInformationMessage(
          "Trilkeep: no files matched the include/exclude allowlist."
        );
      }
      return;
    }

    const engine = makeEngine(client, manifest, folder, cfg, connectionName);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Trilkeep backup",
        cancellable: true,
      },
      async (progress, cancelToken) => {
        const reporter: ProgressReporter = {
          report: (message) => progress.report({ message }),
          isCancelled: () => cancelToken.isCancellationRequested,
        };
        try {
          const summary = await engine.backup(files, reporter);
          await saveManifest(workspaceRoot, manifest, connectionName);
          await rememberConnection(context, connectionName);
          const line = `Trilkeep backup done — ${summary.created} created, ${summary.updated} updated, ${summary.skipped} unchanged, ${summary.removed} removed${
            summary.errors.length ? `, ${summary.errors.length} errors` : ""
          }.`;
          output.appendLine(line);
          if (!quiet || summary.errors.length) {
            void vscode.window.showInformationMessage(line);
          }
        } catch (e) {
          // Persist whatever progress was made before the failure.
          await saveManifest(workspaceRoot, manifest, connectionName).catch(
            () => undefined
          );
          reportError(e);
        }
      }
    );
  });
}

/** Dry run: report what a full backup WOULD do — which files are new/changed/
 * unchanged/skipped/removed — without contacting Trilium or writing anything. No
 * token required, so it works before any connection is configured. */
async function previewBackupCommand(): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    return;
  }
  const cfg = readConfig();
  const connectionName = configuredConnectionName();
  const workspaceRoot = folder.uri.fsPath;
  const files = await discoverFiles(folder, cfg.include, cfg.exclude);
  const manifest = await loadManifest(workspaceRoot, connectionName);
  const plan = await planBackup(workspaceRoot, files, manifest);

  const willWrite = plan.created.length + plan.updated.length;
  const removalNote = cfg.hardDeleteRemovedFiles
    ? "would be deleted"
    : "kept in Trilium (soft delete)";

  output.appendLine("");
  output.appendLine(
    `── Trilkeep dry run · connection "${connectionName}" · ${files.length} file(s) matched the allowlist ──`
  );
  const list = (tag: string, items: string[]) => {
    for (const rel of items) {
      output.appendLine(`  ${tag.padEnd(9)} ${rel}`);
    }
  };
  list("new", plan.created);
  list("changed", plan.updated);
  list("unchanged", plan.unchanged);
  for (const s of plan.skipped) {
    output.appendLine(`  ${"skipped".padEnd(9)} ${s.rel} (${s.reason})`);
  }
  for (const rel of plan.removed) {
    output.appendLine(`  ${"removed".padEnd(9)} ${rel} (${removalNote})`);
  }
  output.appendLine(
    `Summary: ${plan.created.length} new, ${plan.updated.length} changed, ${plan.unchanged.length} unchanged, ${plan.skipped.length} skipped, ${plan.removed.length} removed → ${willWrite} note(s) would be written. (Dry run — nothing changed.)`
  );

  const removedPart = plan.removed.length ? `, ${plan.removed.length} removed` : "";
  const skippedPart = plan.skipped.length ? `, ${plan.skipped.length} skipped` : "";
  const pick = await vscode.window.showInformationMessage(
    `Trilkeep dry run — ${willWrite} of ${files.length} matched file(s) would be written ` +
      `(${plan.created.length} new, ${plan.updated.length} changed, ${plan.unchanged.length} unchanged${skippedPart}${removedPart}). Nothing was changed.`,
    "Show Details"
  );
  if (pick === "Show Details") {
    output.show(true);
  }
}

/** Incremental backup of just the saved file(s) — no full walk, no
 * reconciliation (absent files must NOT be treated as removed here). */
async function runSavedFilesBackup(
  context: vscode.ExtensionContext,
  fsPaths: string[]
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
      const connectionName = configuredConnectionName();
      const workspaceRoot = folder.uri.fsPath;
      const rels = fsPaths
        .map((fp) => toPosix(path.relative(workspaceRoot, fp)))
        .filter(
          (rel) =>
            rel &&
            !rel.startsWith("../") &&
            !path.isAbsolute(rel) &&
            matchesAllowlist(rel, cfg.include, cfg.exclude)
        );
      if (rels.length === 0) {
        return;
      }

      const manifest = await loadManifest(workspaceRoot, connectionName);
      const engine = makeEngine(client, manifest, folder, cfg, connectionName);
      const reporter: ProgressReporter = {
        report: (message) => output.appendLine(message),
        isCancelled: () => false,
      };
      try {
        const summary = await engine.backup(rels, reporter, { reconcile: false });
        await saveManifest(workspaceRoot, manifest, connectionName);
        output.appendLine(
          `Auto-backup (save) — ${summary.created} created, ${summary.updated} updated, ${summary.skipped} unchanged.`
        );
      } catch (e) {
        // Persist whatever progress the engine made before the failure.
        await saveManifest(workspaceRoot, manifest, connectionName).catch(
          () => undefined
        );
        reportError(e);
      }
    } catch (e) {
      reportError(e);
    }
  });
}

/**
 * Guided setup: walks every Trilkeep setting, pre-filled with the current
 * value, so it doubles as a "review & edit config" flow that can be re-run any
 * time. Nothing is applied until every step is answered — pressing Escape at any
 * point aborts with no changes (no half-applied config). The ETAPI token is
 * never shown: the step reports only whether one is already set, and a blank
 * answer keeps the existing token.
 */
async function setupCommand(context: vscode.ExtensionContext): Promise<void> {
  // Settings are written at workspace scope (.vscode/settings.json), which
  // requires an open folder. The token still goes to (global) SecretStorage.
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showErrorMessage(
      "Trilkeep: open a workspace folder before running Setup."
    );
    return;
  }
  const cfg = vscode.workspace.getConfiguration("trilkeep");
  const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const oldConnectionName = cfg
    .get<string>("connectionName", DEFAULT_CONNECTION_NAME)
    .trim();
  const step = (n: number, label: string) => `Trilkeep Setup (${n}/8) — ${label}`;

  // 1) Connection name — pick a known connection or enter a new name. The token
  // and manifest are keyed by it, so the server URL below can change freely
  // without losing either. Picking an existing name is an unambiguous "use this"
  // and never a rename; only TYPING a new name can trigger carry-over.
  const known = await reconcileKnownConnections(context, workspaceRoot);
  const ENTER_NEW = "$(add) Enter a new name…";
  const nameItems: vscode.QuickPickItem[] = [
    ...mergeConnectionNames(known, [oldConnectionName]).map((name) => ({
      label: name,
      description: name === oldConnectionName ? "current" : undefined,
    })),
    { label: ENTER_NEW, alwaysShow: true },
  ];
  const namePick = await vscode.window.showQuickPick(nameItems, {
    title: step(1, "Connection name"),
    placeHolder: "Pick a connection to configure, or add a new one",
    ignoreFocusOut: true,
  });
  if (!namePick) {
    return;
  }
  let connectionName: string;
  let enteredNewName = false;
  if (namePick.label === ENTER_NEW) {
    const raw = await vscode.window.showInputBox({
      title: step(1, "New connection name"),
      prompt:
        'A stable name for this Trilium instance (e.g. "real", "test"). The token and backup state are keyed by it, so the URL can change without losing them.',
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim() === "" ? 'Enter a name (use "default" if unsure).' : undefined,
    });
    if (raw === undefined) {
      return;
    }
    connectionName = raw.trim();
    enteredNewName = connectionName !== oldConnectionName;
  } else {
    connectionName = namePick.label;
  }

  // Carry-over (rename) is offered ONLY when the user typed a NEW name AND the
  // current connection has a backup IN THIS REPO. We gate on the repo-local
  // manifest's rootNoteId, NOT on a token: a bare global token is not "this
  // repo's backup", and moving it would steal another repo's credential.
  let renaming = false;
  let renameRootId: string | undefined;
  if (enteredNewName) {
    const oldManifest = await loadManifest(workspaceRoot, oldConnectionName);
    if (oldManifest.rootNoteId) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: `Rename "${oldConnectionName}" → "${connectionName}"`,
            description:
              "Keep the existing backup — move its state + token to the new name",
            value: "rename",
          },
          {
            label: `Start fresh under "${connectionName}"`,
            description: `Leave "${oldConnectionName}" as-is and begin a new backup tree`,
            value: "fresh",
          },
        ],
        { title: "Trilkeep Setup — connection name changed", ignoreFocusOut: true }
      );
      if (!choice) {
        return;
      }
      renaming = choice.value === "rename";
      if (renaming) {
        renameRootId = oldManifest.rootNoteId;
      }
    }
  }

  // 2) Server URL
  const serverUrl = await vscode.window.showInputBox({
    title: step(2, "Server URL"),
    prompt: "TriliumNext server URL (just the address — may change over time)",
    value: cfg.get<string>("serverUrl", "http://localhost:8080"),
    ignoreFocusOut: true,
    validateInput: (v) => {
      try {
        new URL(v.trim());
        return undefined;
      } catch {
        return "Enter a valid URL, e.g. http://localhost:8080";
      }
    },
  });
  if (serverUrl === undefined) {
    return;
  }

  // 3) ETAPI token — keyed to the connection entered above (not the saved
  // config), so the token follows the instance you're configuring. When
  // renaming, the existing token lives under the old name and carries over.
  // Never display the existing value; blank keeps it.
  const hasToken = !!(await getToken(
    context,
    renaming ? oldConnectionName : connectionName
  ));
  const token = await vscode.window.showInputBox({
    title: step(3, "ETAPI Token"),
    prompt: renaming
      ? `The token for "${oldConnectionName}" will move to "${connectionName}". Enter a new one to replace it, or leave blank to keep it.`
      : hasToken
        ? `A token is already set for connection "${connectionName}". Enter a new one to replace it, or leave blank to keep it.`
        : `No token set for connection "${connectionName}" yet. Paste its Trilium ETAPI token (Options → ETAPI).`,
    placeHolder: hasToken ? "•••••••• (leave blank to keep current)" : "",
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) {
    return;
  }

  // 4) Root note title
  const rootNoteTitle = await vscode.window.showInputBox({
    title: step(4, "Root Note Title"),
    prompt: "Title of the top-level Trilium note your backups live under",
    value: cfg.get<string>("rootNoteTitle", "Trilkeep"),
    ignoreFocusOut: true,
  });
  if (rootNoteTitle === undefined) {
    return;
  }

  // 5) Include globs (comma-separated)
  const includeRaw = await vscode.window.showInputBox({
    title: step(5, "Include globs"),
    prompt: "Comma-separated globs of files to back up",
    value: cfg.get<string[]>("include", ["**/*.md"]).join(", "),
    ignoreFocusOut: true,
    validateInput: (v) =>
      parseGlobList(v).length === 0 ? "Enter at least one glob, e.g. **/*.md" : undefined,
  });
  if (includeRaw === undefined) {
    return;
  }

  // 6) Exclude globs (comma-separated; may be empty)
  const excludeRaw = await vscode.window.showInputBox({
    title: step(6, "Exclude globs"),
    prompt: "Comma-separated globs to skip (leave blank for none)",
    value: cfg.get<string[]>("exclude", []).join(", "),
    ignoreFocusOut: true,
  });
  if (excludeRaw === undefined) {
    return;
  }

  // 7) Back up on save?
  const onSave = await pickYesNo(
    step(7, "Back up on save?"),
    cfg.get<boolean>("backupOnSave", false),
    "Also back up each file right after you save it",
    "Only back up when you run the command (default)"
  );
  if (!onSave) {
    return;
  }

  // 8) Hard-delete removed files?
  const hardDelete = await pickYesNo(
    step(8, "Hard-delete removed files?"),
    cfg.get<boolean>("hardDeleteRemovedFiles", false),
    "Permanently delete the Trilium note when its file is removed",
    "Keep removed files in Trilium (soft delete, default)"
  );
  if (!hardDelete) {
    return;
  }

  // Carry an existing backup over to the new name first (state + token + the
  // root's connection label), so nothing is orphaned by the settings change.
  if (renaming) {
    await renameConnectionManifest(workspaceRoot, oldConnectionName, connectionName);
    const carried = await getToken(context, oldConnectionName);
    if (carried) {
      await storeToken(context, connectionName, carried);
      await context.secrets.delete(tokenKey(oldConnectionName));
    }
    if (renameRootId) {
      const effectiveToken = token.trim() || (await getToken(context, connectionName));
      if (effectiveToken) {
        try {
          await renameRootConnectionLabel(
            new EtapiClient(serverUrl.trim(), effectiveToken),
            renameRootId,
            connectionName
          );
        } catch (e) {
          output.appendLine(
            `Trilkeep: could not update the backup root's connection label (${(e as Error).message}); backups still work, but manifest-loss recovery uses the old name until the next stamp.`
          );
        }
      }
    }
  }

  // All answered — apply to this workspace's .vscode/settings.json.
  const target = vscode.ConfigurationTarget.Workspace;
  await cfg.update("connectionName", connectionName, target);
  await cfg.update("serverUrl", serverUrl.trim(), target);
  await cfg.update("rootNoteTitle", rootNoteTitle.trim(), target);
  await cfg.update("include", parseGlobList(includeRaw), target);
  await cfg.update("exclude", parseGlobList(excludeRaw), target);
  await cfg.update("backupOnSave", onSave === "Yes", target);
  await cfg.update("hardDeleteRemovedFiles", hardDelete === "Yes", target);
  if (token.trim()) {
    await storeToken(context, connectionName, token.trim());
  }
  // Register the configured connection so it appears in this and other repos'
  // pickers. (A dead, token-less connection is pruned on the next activation.)
  await rememberConnection(context, connectionName);

  const tokenState = token.trim()
    ? "token saved"
    : renaming
      ? "token moved"
      : hasToken
        ? "token kept"
        : "no token set";
  const next = await vscode.window.showInformationMessage(
    `Trilkeep setup saved (${tokenState}${renaming ? `, renamed from "${oldConnectionName}"` : ""}). Test the connection now?`,
    "Test Connection",
    "Done"
  );
  if (next === "Test Connection") {
    await testConnectionCommand(context);
  }
}

/** Yes/No quick pick with the current value listed first. Returns "Yes"/"No",
 * or undefined if the user escaped. */
async function pickYesNo(
  title: string,
  current: boolean,
  yesDescription: string,
  noDescription: string
): Promise<"Yes" | "No" | undefined> {
  const yes = { label: "Yes", description: yesDescription };
  const no = { label: "No", description: noDescription };
  const pick = await vscode.window.showQuickPick(current ? [yes, no] : [no, yes], {
    title,
    ignoreFocusOut: true,
  });
  return pick ? (pick.label as "Yes" | "No") : undefined;
}

async function setTokenCommand(context: vscode.ExtensionContext): Promise<void> {
  const connectionName = configuredConnectionName();
  const token = await vscode.window.showInputBox({
    prompt: `Trilium ETAPI token for connection "${connectionName}" (Options → ETAPI in Trilium)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) {
    return;
  }
  await storeToken(context, connectionName, token.trim());
  await rememberConnection(context, connectionName);
  void vscode.window.showInformationMessage(
    `Trilium ETAPI token stored for connection "${connectionName}".`
  );
}

async function clearTokenCommand(context: vscode.ExtensionContext): Promise<void> {
  const connectionName = configuredConnectionName();
  await context.secrets.delete(tokenKey(connectionName));
  void vscode.window.showInformationMessage(
    `Trilium ETAPI token cleared for connection "${connectionName}".`
  );
}

async function testConnectionCommand(
  context: vscode.ExtensionContext
): Promise<void> {
  const client = await buildClient(context);
  if (!client) {
    return;
  }
  try {
    const info = await client.appInfo();
    void vscode.window.showInformationMessage(
      `Connected to Trilium ${info.appVersion} (db ${info.dbVersion}).`
    );
  } catch (e) {
    reportError(e);
  }
}

function reportError(e: unknown): void {
  const msg =
    e instanceof EtapiError
      ? e.body
        ? `${e.message} — ${e.body}`
        : e.message
      : e instanceof Error
        ? e.message
        : String(e);
  output.appendLine(`ERROR ${msg}`);
  void vscode.window.showErrorMessage(`Trilkeep: ${msg}`);
}
