/**
 * Minimal, dependency-free glob matching.
 *
 * Supported syntax:
 *   *   matches any run of characters EXCEPT the path separator "/"
 *   **  matches any run of characters INCLUDING "/" (crosses directories)
 *   ?   matches exactly one character (not "/")
 *
 * All other characters (including ".", "-", etc.) are matched literally.
 * Patterns are anchored to the whole string.
 */

/** Escape a literal character for use inside a RegExp source. */
function escapeLiteral(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a glob into an anchored RegExp.
 *
 * Note the ordering: `**` must be handled before `*` so it can cross "/".
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // "**" — consume the second star (and an optional following "/")
        // so that "**/" also matches zero directories.
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        // single "*" — anything but a slash
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += escapeLiteral(ch);
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * True if `path` matches any of `globs`.
 *
 * Each glob is tested two ways: against the full path AND against the path's
 * basename (final "/"-delimited segment). The basename rule is what makes a
 * bare pattern like ".env*" catch "apps/api/.env.local" — the glob matches the
 * basename ".env.local" even though it does not match the full path.
 */
export function matchesAny(path: string, globs: string[]): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  for (const glob of globs) {
    const re = globToRegExp(glob);
    if (re.test(path) || re.test(basename)) return true;
  }
  return false;
}
