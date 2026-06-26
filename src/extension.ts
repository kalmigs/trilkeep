import * as path from "node:path";

import * as vscode from "vscode";

import { discoverFiles } from "./allowlist";
import { EtapiClient, EtapiError } from "./etapiClient";
import { matchesAllowlist, toPosix } from "./globs";
import { loadManifest, Manifest, saveManifest } from "./manifest";
import { ProgressReporter, SyncEngine } from "./sync";

const SECRET_TOKEN_KEY = "trilkeep.etapiToken";

let output: vscode.OutputChannel;

// Guards against overlapping backups (e.g. a save-triggered run racing a manual
// one). Concurrent runs would load the manifest independently and the last
// saveManifest would clobber the other's noteId mappings, creating duplicate
// Trilium notes.
let backupInFlight = false;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Trilkeep");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("trilkeep.backup", () =>
      runBackupCommand(context)
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
  const cfg = vscode.workspace.getConfiguration("trilkeep");
  const serverUrl = cfg.get<string>("serverUrl", "http://localhost:8080");
  const token = await context.secrets.get(SECRET_TOKEN_KEY);
  if (!token) {
    // A quiet (save-triggered) run must not pop a modal on every save.
    if (quiet) {
      output.appendLine("Skipped auto-backup: no ETAPI token set.");
      return undefined;
    }
    const pick = await vscode.window.showWarningMessage(
      "No Trilium ETAPI token set. Set one now?",
      "Set Token"
    );
    if (pick === "Set Token") {
      await setTokenCommand(context);
    }
    return undefined;
  }
  return new EtapiClient(serverUrl, token);
}

function firstWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showErrorMessage(
      "Trilkeep: open a workspace folder to back up."
    );
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
    rootNoteTitle: cfg.get<string>("rootNoteTitle", "VSCode Backup"),
    hardDeleteRemovedFiles: cfg.get<boolean>("hardDeleteRemovedFiles", false),
  };
}

function makeEngine(
  client: EtapiClient,
  manifest: Manifest,
  folder: vscode.WorkspaceFolder,
  cfg: BackupConfig
): SyncEngine {
  return new SyncEngine(
    client,
    manifest,
    {
      workspaceRoot: folder.uri.fsPath,
      workspaceName: folder.name,
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
  const folder = firstWorkspaceFolder();
  if (!folder) {
    return;
  }
  await withBackupLock(quiet, async () => {
    const client = await buildClient(context, quiet);
    if (!client) {
      return;
    }
    const cfg = readConfig();
    const workspaceRoot = folder.uri.fsPath;
    const files = await discoverFiles(folder, cfg.include, cfg.exclude);
    const manifest = await loadManifest(workspaceRoot);
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

    const engine = makeEngine(client, manifest, folder, cfg);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Trilium backup",
        cancellable: true,
      },
      async (progress, cancelToken) => {
        const reporter: ProgressReporter = {
          report: (message) => progress.report({ message }),
          isCancelled: () => cancelToken.isCancellationRequested,
        };
        try {
          const summary = await engine.backup(files, reporter);
          await saveManifest(workspaceRoot, manifest);
          const line = `Trilium backup done — ${summary.created} created, ${summary.updated} updated, ${summary.skipped} unchanged, ${summary.removed} removed${
            summary.errors.length ? `, ${summary.errors.length} errors` : ""
          }.`;
          output.appendLine(line);
          if (!quiet || summary.errors.length) {
            void vscode.window.showInformationMessage(line);
          }
        } catch (e) {
          // Persist whatever progress was made before the failure.
          await saveManifest(workspaceRoot, manifest).catch(() => undefined);
          reportError(e);
        }
      }
    );
  });
}

/** Incremental backup of just the saved file(s) — no full walk, no
 * reconciliation (absent files must NOT be treated as removed here). */
async function runSavedFilesBackup(
  context: vscode.ExtensionContext,
  fsPaths: string[]
): Promise<void> {
  const folder = firstWorkspaceFolder();
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

      const manifest = await loadManifest(workspaceRoot);
      const engine = makeEngine(client, manifest, folder, cfg);
      const reporter: ProgressReporter = {
        report: (message) => output.appendLine(message),
        isCancelled: () => false,
      };
      try {
        const summary = await engine.backup(rels, reporter, { reconcile: false });
        await saveManifest(workspaceRoot, manifest);
        output.appendLine(
          `Auto-backup (save) — ${summary.created} created, ${summary.updated} updated, ${summary.skipped} unchanged.`
        );
      } catch (e) {
        // Persist whatever progress the engine made before the failure.
        await saveManifest(workspaceRoot, manifest).catch(() => undefined);
        reportError(e);
      }
    } catch (e) {
      reportError(e);
    }
  });
}

async function setTokenCommand(context: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    prompt: "Trilium ETAPI token (Options → ETAPI in Trilium)",
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) {
    return;
  }
  await context.secrets.store(SECRET_TOKEN_KEY, token.trim());
  void vscode.window.showInformationMessage("Trilium ETAPI token stored.");
}

async function clearTokenCommand(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_TOKEN_KEY);
  void vscode.window.showInformationMessage("Trilium ETAPI token cleared.");
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
      : (e as Error).message;
  output.appendLine(`ERROR ${msg}`);
  void vscode.window.showErrorMessage(`Trilkeep: ${msg}`);
}
