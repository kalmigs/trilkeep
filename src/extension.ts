import * as vscode from "vscode";

import { discoverFiles } from "./allowlist";
import { EtapiClient, EtapiError } from "./etapiClient";
import { loadManifest, saveManifest } from "./manifest";
import { ProgressReporter, SyncEngine } from "./sync";

const SECRET_TOKEN_KEY = "triliumBridge.etapiToken";

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Trilium Bridge");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("triliumBridge.backup", () =>
      runBackupCommand(context)
    ),
    vscode.commands.registerCommand("triliumBridge.setToken", () =>
      setTokenCommand(context)
    ),
    vscode.commands.registerCommand("triliumBridge.clearToken", () =>
      clearTokenCommand(context)
    ),
    vscode.commands.registerCommand("triliumBridge.testConnection", () =>
      testConnectionCommand(context)
    )
  );

  // Optional incremental backup on save. The hash-diff means only the file
  // that actually changed gets uploaded.
  let saveTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      if (!vscode.workspace.getConfiguration("triliumBridge").get("backupOnSave")) {
        return;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => void runBackupCommand(context, true), 1000);
    })
  );
}

export function deactivate(): void {
  // no-op
}

async function buildClient(
  context: vscode.ExtensionContext
): Promise<EtapiClient | undefined> {
  const cfg = vscode.workspace.getConfiguration("triliumBridge");
  const serverUrl = cfg.get<string>("serverUrl", "http://localhost:8080");
  const token = await context.secrets.get(SECRET_TOKEN_KEY);
  if (!token) {
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
      "Trilium Bridge: open a workspace folder to back up."
    );
    return undefined;
  }
  return folders[0];
}

async function runBackupCommand(
  context: vscode.ExtensionContext,
  quiet = false
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    return;
  }
  const client = await buildClient(context);
  if (!client) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration("triliumBridge");
  const include = cfg.get<string[]>("include", ["**/*.md"]);
  const exclude = cfg.get<string[]>("exclude", []);
  const rootNoteTitle = cfg.get<string>("rootNoteTitle", "VSCode Backup");
  const hardDeleteRemovedFiles = cfg.get<boolean>("hardDeleteRemovedFiles", false);

  const workspaceRoot = folder.uri.fsPath;
  const files = await discoverFiles(folder, include, exclude);
  if (files.length === 0) {
    if (!quiet) {
      void vscode.window.showInformationMessage(
        "Trilium Bridge: no files matched the include/exclude allowlist."
      );
    }
    return;
  }

  const manifest = await loadManifest(workspaceRoot);
  const engine = new SyncEngine(
    client,
    manifest,
    {
      workspaceRoot,
      workspaceName: folder.name,
      rootNoteTitle,
      hardDeleteRemovedFiles,
    },
    (msg) => output.appendLine(msg)
  );

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
  void vscode.window.showErrorMessage(`Trilium Bridge: ${msg}`);
}
