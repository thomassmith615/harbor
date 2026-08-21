/**
 * Where Harbor's own interface lives on disk.
 *
 * It used to be a template literal compiled into this file, and the argument
 * for that was sound: one repository, one build, no deploy, no version skew.
 * The previous front end was a separate project, fell six milestones behind the
 * API it talked to, and was shelved.
 *
 * The string kept all of that and charged for it in a currency that got
 * expensive as the page grew. A regex inside a template literal needs every
 * backslash doubled, and a backtick in a pattern ends the file. Both cost real
 * builds in M20, and both are invisible until something silently does nothing.
 *
 * These are ordinary files in the same package, copied to `dist` by the build
 * and served from the same origin as the API. Every property that mattered is
 * intact: nothing to install, nothing to deploy, nothing that can be a
 * different version from the daemon serving it.
 */
import { fileURLToPath } from "node:url";

/**
 * The directory holding the built-in interface.
 *
 * Resolved from this module rather than from the process working directory, so
 * it is correct whether Harbor was started from the repository, from a global
 * install, or by launchd from `/`.
 */
export function builtinUiRoot(): string {
  return fileURLToPath(new URL("./ui/", import.meta.url));
}
