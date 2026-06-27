// Pure glob/path helpers. Kept free of any `vscode` import so they can be
// unit-tested in plain Node.

/** Convert a single glob to a RegExp with minimatch-like semantics for the
 * subset we use: `**` (globstar, crosses `/`), `*` (within one segment), `?`,
 * brace alternation `{a,b}`, and `[...]` character classes.
 *
 * This replaces `path.matchesGlob`, which only exists on Node 22+. VSCode 1.90
 * (our `engines` floor) ships Node 20, where `path.matchesGlob` is undefined and
 * the on-save backup path would throw `TypeError: ... is not a function`. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    switch (c) {
      case "*":
        if (glob[i + 1] === "*") {
          i++;
          if (glob[i + 1] === "/") {
            i++;
            re += "(?:[^/]*/)*"; // `**/` → zero or more leading path segments
          } else {
            re += ".*"; // `**` → any characters, including `/`
          }
        } else {
          re += "[^/]*"; // `*` → any characters within a single segment
        }
        break;
      case "?":
        re += "[^/]";
        break;
      case "{":
        braceDepth++;
        re += "(?:";
        break;
      case "}":
        if (braceDepth > 0) {
          braceDepth--;
          re += ")";
        } else {
          re += "\\}";
        }
        break;
      case ",":
        re += braceDepth > 0 ? "|" : ",";
        break;
      case "[": {
        // Character class: copy through to the matching `]`, converting a
        // leading glob negation `!` to the regex form `^`.
        let j = i + 1;
        let cls = "[";
        if (glob[j] === "!" || glob[j] === "^") {
          cls += "^";
          j++;
        }
        if (glob[j] === "]") {
          cls += "\\]";
          j++;
        }
        while (j < glob.length && glob[j] !== "]") {
          cls += glob[j];
          j++;
        }
        if (j >= glob.length) {
          re += "\\["; // unterminated class → treat `[` as a literal
        } else {
          re += cls + "]";
          i = j;
        }
        break;
      }
      default:
        re += /[\\^$.|+()]/.test(c) ? "\\" + c : c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Does a workspace-relative posix path satisfy the include/exclude allowlist?
 * Used by the on-save path to test a single file without walking the tree. */
export function matchesAllowlist(
  rel: string,
  include: string[],
  exclude: string[]
): boolean {
  if (!include.some((g) => globToRegExp(g).test(rel))) {
    return false;
  }
  return !exclude.some((g) => globToRegExp(g).test(rel));
}

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

/** Split a comma-separated glob field (from the setup wizard) into a trimmed,
 * empty-free list. `"a, ,b,"` → `["a", "b"]`; blank input → `[]`. */
export function parseGlobList(raw: string): string[] {
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
}
