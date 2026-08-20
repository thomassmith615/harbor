#!/usr/bin/env node
/**
 * A read-only look at your Photos library, before anything is built against it.
 *
 *   node scripts/photos-probe.mjs
 *
 * Writes nothing, sends nothing, and touches the library only through a copy.
 *
 * ## Why this exists rather than a connector
 *
 * Apple's `Photos.sqlite` schema is private, undocumented, and changes between
 * macOS releases. Table and column names differ across versions, and the same
 * concept is spelled differently in each. Writing a connector against a guessed
 * schema would produce code that typechecks, passes review, and does nothing on
 * your machine, which is a failure mode this project has already been bitten by
 * more than once.
 *
 * So: measure first. This prints what the library actually contains, and the
 * connector gets written against that.
 *
 * ## What it answers
 *
 * - Where the library is and how big it is
 * - Which table holds assets, and what its columns are really called
 * - How many assets there are, and how many are screenshots
 * - Whether screenshots are distinguishable without opening a single image
 * - Roughly how long an OCR backfill would take
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function findLibrary() {
  const fromEnv = process.env["HARBOR_PHOTOS_LIBRARY"];

  if (fromEnv !== undefined && existsSync(fromEnv)) {
    return fromEnv;
  }

  const pictures = join(homedir(), "Pictures");

  if (!existsSync(pictures)) {
    return null;
  }

  for (const entry of readdirSync(pictures)) {
    if (entry.endsWith(".photoslibrary")) {
      return join(pictures, entry);
    }
  }

  return null;
}

const library = findLibrary();

if (library === null) {
  console.log("No .photoslibrary found in ~/Pictures.");
  console.log("Set HARBOR_PHOTOS_LIBRARY to its path if it lives elsewhere.");
  process.exit(1);
}

console.log(`library   ${library}`);

const source = join(library, "database", "Photos.sqlite");

if (!existsSync(source)) {
  console.log(`No Photos.sqlite at ${source}`);
  console.log("Contents of database/:");
  try {
    for (const entry of readdirSync(join(library, "database"))) {
      console.log(`  ${entry}`);
    }
  } catch (error) {
    console.log(`  unreadable: ${String(error)}`);
    console.log("");
    console.log("If this is a permissions error, Terminal needs Full Disk Access:");
    console.log("System Settings > Privacy & Security > Full Disk Access.");
  }
  process.exit(1);
}

console.log(`database  ${(statSync(source).size / 1_048_576).toFixed(0)} MB`);

// Snapshot before reading, exactly as the iMessage connector does. Photos holds
// this open with a WAL and reading it live risks both a torn read and, worse,
// contending with an application the user is running.
const scratch = mkdtempSync(join(tmpdir(), "harbor-photos-"));
let db;

try {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${source}${suffix}`;

    if (existsSync(path)) {
      copyFileSync(path, join(scratch, `Photos.sqlite${suffix}`));
    }
  }

  const Database = require("better-sqlite3-multiple-ciphers");
  db = new Database(join(scratch, "Photos.sqlite"), { readonly: true });

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => row.name);

  console.log(`tables    ${tables.length}`);

  // The asset table is whichever one has the most rows and looks like assets.
  const counted = [];

  for (const name of tables) {
    if (name.startsWith("sqlite_") || name.startsWith("Z_")) {
      continue;
    }

    try {
      counted.push({
        name,
        rows: db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n,
      });
    } catch {
      // Views and virtual tables can refuse a count. Not interesting here.
    }
  }

  counted.sort((a, b) => b.rows - a.rows);

  console.log("");
  console.log("largest tables:");

  for (const entry of counted.slice(0, 8)) {
    console.log(`  ${String(entry.rows).padStart(9)}  ${entry.name}`);
  }

  // Exact name first, and that specificity is the fix.
  //
  // The first version took the largest table matching /asset/i, which on a real
  // library is ZADDITIONALASSETATTRIBUTES: a side table of ninety-one extra
  // columns, one row per asset, that sorts alongside ZASSET and wins on a tie.
  // Every screenshot test then ran against a table without ZKIND or
  // ZKINDSUBTYPE and reported n/a three times, which read as "your macOS does
  // not support any of these" when it actually meant "wrong table".
  const assetTable =
    counted.find((entry) => entry.name === "ZASSET")?.name ??
    counted.find((entry) => /^ZASSET/i.test(entry.name))?.name ??
    counted.find((entry) => /asset/i.test(entry.name))?.name ??
    counted[0]?.name;

  if (assetTable === undefined) {
    console.log("No candidate asset table found.");
    process.exit(1);
  }

  console.log("");
  console.log(`asset table: ${assetTable}`);

  // The attributes side table carries the original filename, which is the
  // fallback screenshot signal if the flags turn out to be unreliable.
  const attrTable = counted.find((entry) => /ADDITIONALASSETATTRIBUTES/i.test(entry.name))?.name;

  if (attrTable !== undefined) {
    console.log(`attributes:  ${attrTable} (join on Z_PK / ZASSET)`);
  }

  const columns = db.prepare(`PRAGMA table_info("${assetTable}")`).all();

  // Only the columns a connector would plausibly need. The full list runs to
  // several hundred and reading it is not useful.
  const wanted =
    /width|height|kind|date|filename|directory|uti|uniform|type|trashed|hidden|favorite|latitude|longitude|saved|imported/i;

  console.log(`columns: ${columns.length} total, showing the relevant ones`);

  for (const column of columns) {
    if (wanted.test(column.name)) {
      console.log(`  ${column.name}`);
    }
  }

  const has = (needle) => columns.some((column) => column.name === needle);

  // Screenshots. Apple has spelled this several ways across releases, so try
  // each and report which one this library actually uses.
  console.log("");
  console.log("screenshot detection:");

  const strategies = [
    {
      label: "ZKIND / ZKINDSUBTYPE (subtype 1 is screenshot on most releases)",
      when: has("ZKINDSUBTYPE"),
      sql: `SELECT COUNT(*) AS n FROM "${assetTable}" WHERE ZKINDSUBTYPE = 1`,
    },
    {
      label: "ZUNIFORMTYPEIDENTIFIER = public.png (screenshots are PNG)",
      when: has("ZUNIFORMTYPEIDENTIFIER"),
      sql: `SELECT COUNT(*) AS n FROM "${assetTable}" WHERE ZUNIFORMTYPEIDENTIFIER LIKE '%png%'`,
    },
    {
      label: "ZFILENAME contains Screenshot",
      when: has("ZFILENAME"),
      sql: `SELECT COUNT(*) AS n FROM "${assetTable}" WHERE ZFILENAME LIKE '%Screenshot%' OR ZFILENAME LIKE '%Screen Shot%'`,
    },
    {
      label: "ZORIGINALFILENAME contains Screenshot (attributes table)",
      when: attrTable !== undefined,
      sql: `SELECT COUNT(*) AS n FROM "${String(attrTable)}"
            WHERE ZORIGINALFILENAME LIKE '%Screenshot%' OR ZORIGINALFILENAME LIKE '%Screen Shot%'`,
    },
  ];

  for (const strategy of strategies) {
    if (!strategy.when) {
      console.log(`  n/a   ${strategy.label}`);
      continue;
    }

    try {
      console.log(`  ${String(db.prepare(strategy.sql).get().n).padStart(7)}  ${strategy.label}`);
    } catch (error) {
      console.log(`  err   ${strategy.label}: ${String(error).slice(0, 60)}`);
    }
  }

  // The real distribution, rather than trusting that subtype 1 means screenshot.
  // Apple has renumbered these; reading the counts is how we find out which
  // value this library actually uses.
  if (has("ZKINDSUBTYPE")) {
    console.log("");
    console.log("ZKIND / ZKINDSUBTYPE distribution:");

    try {
      const rows = db
        .prepare(
          `SELECT ZKIND AS kind, ZKINDSUBTYPE AS subtype, COUNT(*) AS n
           FROM "${assetTable}" GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`,
        )
        .all();

      for (const row of rows) {
        console.log(
          `  kind ${String(row.kind).padEnd(3)} subtype ${String(row.subtype).padEnd(5)} ${String(row.n).padStart(7)}`,
        );
      }
    } catch (error) {
      console.log(`  unavailable: ${String(error).slice(0, 60)}`);
    }
  }

  const total = counted.find((entry) => entry.name === assetTable)?.rows ?? 0;

  console.log("");
  console.log(`total assets: ${String(total)}`);
  console.log("");
  console.log("OCR backfill estimate (macOS Vision, roughly 0.15s per image):");
  console.log(`  everything   ~${(total * 0.15 / 3600).toFixed(1)} hours`);
  console.log("  screenshots only: take the count above and divide by 24000");
} finally {
  if (db !== undefined) {
    db.close();
  }

  rmSync(scratch, { recursive: true, force: true });
}

// Whether the OCR half is even available on this machine, checked separately so
// a failure here does not hide the schema findings above.
console.log("");
console.log("OCR backend:");

try {
  execFileSync("swift", ["--version"], { stdio: "pipe" });
  console.log("  swift present, so the Vision framework is reachable");
} catch {
  console.log("  no swift toolchain. Install Xcode command line tools:");
  console.log("  xcode-select --install");
}
