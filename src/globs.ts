// Pure glob/path helpers. Kept free of any `vscode` import so they can be
// unit-tested in plain Node.

/** Combine an array of globs into a single brace pattern, or "" if empty. */
export function joinGlobs(globs: string[]): string {
  const cleaned = globs.map((g) => g.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return "";
  }
  if (cleaned.length === 1) {
    return cleaned[0];
  }
  return `{${cleaned.join(",")}}`;
}

/** Normalise a path to forward slashes for stable, cross-platform keys. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
