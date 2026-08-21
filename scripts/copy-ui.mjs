/**
 * Copies the built-in interface into `dist`.
 *
 * `tsc` only emits what it compiles, so the HTML, CSS and JavaScript that make
 * up Harbor's own page would otherwise never reach `dist/surfaces/ui` and the
 * daemon would serve a 404 at the root. This runs as `postbuild`, which means
 * `npm run build`, `npm test` and `npm run verify` all get it without anybody
 * remembering a second command.
 *
 * Deliberately a copy rather than a bundle. There is nothing to transpile,
 * nothing to minify for a page served over a home network, and a build tool
 * here would be the second thing that can be a different version from the
 * daemon.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "src", "surfaces", "ui");
const to = join(root, "dist", "surfaces", "ui");

if (!existsSync(from)) {
  console.error(`no interface at ${from}`);
  process.exit(1);
}

// Removed first, so a file deleted from source does not survive in dist and
// keep being served long after it stopped existing.
rmSync(to, { recursive: true, force: true });
mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });
