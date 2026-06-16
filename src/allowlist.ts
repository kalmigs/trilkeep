// File discovery driven by the include/exclude allowlist.
//
// The glob-joining helpers are pure so they can be unit-tested without the
// VSCode host; discoverFiles is the thin VSCode-API wrapper around them.

import * as vscode from "vscode";

import { joinGlobs, toPosix } from "./globs";

/**
 * Return workspace-relative POSIX paths of every file matching the include
 * globs and not matching the exclude globs, sorted so parent directories are
 * always created before their children.
 */
export async function discoverFiles(
  folder: vscode.WorkspaceFolder,
  include: string[],
  exclude: string[]
): Promise<string[]> {
  const includePattern = new vscode.RelativePattern(folder, joinGlobs(include) || "**/*");
  const excludeGlob = joinGlobs(exclude);
  const excludePattern = excludeGlob
    ? new vscode.RelativePattern(folder, excludeGlob)
    : null;

  const uris = await vscode.workspace.findFiles(includePattern, excludePattern);
  return uris
    .map((u) => toPosix(vscode.workspace.asRelativePath(u, false)))
    .sort((a, b) => a.localeCompare(b));
}
