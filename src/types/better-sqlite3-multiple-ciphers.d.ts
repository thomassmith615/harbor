/**
 * Types for the cipher-enabled driver.
 *
 * The package ships an `index.d.ts` identical to `better-sqlite3`'s but its
 * `exports` map does not point at it, so TypeScript cannot resolve it. Rather
 * than pin a patched fork or turn off `noImplicitAny` for the whole store
 * layer, this re-exports the upstream types, which are already a dependency and
 * are correct: the fork's API is `better-sqlite3` plus cipher pragmas, and
 * pragmas are strings.
 */
declare module "better-sqlite3-multiple-ciphers" {
  import Database from "better-sqlite3";
  export * from "better-sqlite3";
  export default Database;
}
