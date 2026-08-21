/**
 * What build this is.
 *
 * Resolved from this file's own location rather than the working directory, so
 * it reports the build actually running whether Harbor was invoked through
 * `npm link`, a global install, `node dist/cli/main.js`, or launchd with a
 * working directory of `/`.
 *
 * It lived in `src/cli/main.ts` until the API needed it too. A literal that
 * used to be there read 0.17.0 for nine releases, which made the one command a
 * person runs to check what they are running the one command that lied to
 * them; that is the reason this reads the file rather than being a constant.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, "..", "..", "package.json"), "utf8");

    return (JSON.parse(text) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The compiled entry point, for a supervisor that needs an absolute path.
 *
 * `install-service` used to build this from `process.cwd()`, which quietly
 * wrote a plist pointing at wherever the terminal happened to be. Installing
 * from anywhere but the repository root produced a service that loads, fails,
 * and retries every thirty seconds against a log nobody is watching.
 */
export function entryPoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "main.js");
}
