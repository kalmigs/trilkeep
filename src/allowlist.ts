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
  // undefined (not null) when there are no custom excludes: that keeps VSCode's
  // default excludes (files.exclude / search.exclude: node_modules, .git, …).
  // Passing null would disable ALL excludes and back up everything.
  const excludePattern = excludeGlob
    ? new vscode.RelativePattern(folder, excludeGlob)
    : undefined;

  const uris = await vscode.workspace.findFiles(includePattern, excludePattern);
  return uris
    .map((u) => toPosix(vscode.workspace.asRelativePath(u, false)))
    .sort((a, b) => a.localeCompare(b));
}
