/**
 * Every module loads.
 *
 * The cheapest test in the suite, and it exists because its absence cost a
 * broken release. `src/connectors/imessage/messages.ts` opened Apple's
 * `chat.db` with its own direct `better-sqlite3` import while the store had
 * moved to the cipher build. That kept the old package alive as an invisible
 * dependency until it was removed from `package.json`, at which point every
 * entry point failed at load time. Typecheck passed, because the types were
 * still installed. The build passed, because `tsc` does not resolve runtime
 * dependencies. All 38 tests passed, because none of them import that file.
 *
 * A dependency that is declared, typed, and absent from `node_modules` is
 * invisible to every other kind of check. This one catches it in about a
 * second, and it catches the whole family: a circular import that throws on
 * evaluation, a top-level statement that needs an environment variable, a
 * renamed file some other module still points at.
 *
 * The list is discovered from the filesystem rather than written down, so a new
 * module is covered the moment it exists, which is the only way a test like
 * this stays true.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Modules with side effects on load that a test cannot satisfy.
 *
 * Kept empty on purpose. Anything that has to be listed here is a module doing
 * work at import time, and the fix is almost always to stop doing that rather
 * than to add a line below.
 */
const SKIP: readonly string[] = [
  // The command line entry point, which parses argv and runs a command as soon
  // as it loads. That is correct for a `bin` and wrong for everything else, so
  // it is the one module here that cannot be imported for its own sake. Its
  // dependencies are all covered anyway: it imports most of the tree.
  "cli/main.js",
];

function modulesUnder(directory: string): readonly string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...modulesUnder(path));
      continue;
    }

    if (!entry.name.endsWith(".js") || entry.name.endsWith(".test.js")) {
      continue;
    }

    found.push(path);
  }

  return found;
}

test("every module can be imported", async () => {
  // `here` is dist/<something>, so the compiled root is one level up.
  const root = dirname(here);
  const modules = modulesUnder(root).filter(
    (path) => !SKIP.includes(relative(root, path)),
  );

  assert.ok(modules.length > 40, `only found ${String(modules.length)} modules, so this proves little`);

  const failures: string[] = [];

  for (const path of modules) {
    try {
      await import(pathToFileURL(path).href);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${relative(root, path)}: ${detail.split("\n")[0] ?? ""}`);
    }
  }

  assert.deepEqual(failures, [], `modules failed to load:\n  ${failures.join("\n  ")}`);
});
