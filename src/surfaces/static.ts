/**
 * Serving a built front end.
 *
 * In development the UI runs on its own dev server and talks to Harbor across
 * origins, which needs CORS. In production the right answer is to serve the
 * built files from Harbor itself: same origin, no CORS, no second process, and
 * the token in browser storage is scoped to the box rather than to whatever
 * host happened to serve the HTML.
 *
 * Deliberately minimal. No compression, no ETags, no directory listing. This
 * serves a handful of hashed asset files and one HTML document to devices on a
 * home network.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface StaticOptions {
  readonly root: string;
}

/**
 * Resolves a request path to a file inside the root, or null.
 *
 * The normalize-and-prefix-check is the whole security story here: without it,
 * `GET /../../.harbor/harbor.db` reads the database over HTTP.
 */
function resolveFile(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const candidate = resolve(root, `.${normalize(decoded)}`);

  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return null;
  }

  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }

  return null;
}

export interface StaticResult {
  readonly handled: boolean;
}

/**
 * Serves a file, falling back to index.html for unknown paths.
 *
 * The fallback is what makes client-side routing work: a hard refresh on
 * `/people` has to return the app rather than a 404, and the app then reads the
 * path itself.
 */
export function serveStatic(
  options: StaticOptions,
  urlPath: string,
  response: ServerResponse,
): StaticResult {
  const root = resolve(options.root);

  if (!existsSync(root)) {
    return { handled: false };
  }

  const direct = resolveFile(root, urlPath);
  const index = join(root, "index.html");

  const file = direct ?? (existsSync(index) ? index : null);

  if (file === null) {
    return { handled: false };
  }

  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

  // Never cached, deliberately.
  //
  // This used to serve non-index files as immutable for a year, which is right
  // for content-hashed bundles and wrong for everything else. The built-in
  // interface is `app.js` and `app.css` with no hash in the name, so a year of
  // immutable caching means a phone that opened Harbor once keeps the old page
  // after every upgrade, with no way to force it but clearing site data. These
  // are a few kilobytes over a home network; revalidating them costs nothing
  // worth the class of bug it removes.
  response.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  createReadStream(file).pipe(response);

  return { handled: true };
}
