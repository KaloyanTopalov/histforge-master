/**
 * Cross-platform native-module guardrail.
 *
 * better-sqlite3 ships a compiled .node binary that only loads under the
 * OS + Node ABI it was built for. When the same node_modules is shared
 * between Windows and WSL (repo at /mnt/c/... on a 9p mount), whichever
 * runtime ran `npm install` / `npm rebuild` last wins and the other blows
 * up with `invalid ELF header` or `%1 is not a valid Win32 application`.
 *
 * Strategy: rebuild once per (platform, arch, Node ABI, sqlite version),
 * cache the resulting binary, and swap the cached copy into place when
 * the binary on disk doesn't match the current runtime. No rebuild on
 * matching runs.
 *
 * Wired as the `pre*` hook for every npm entry point that loads native
 * modules — see package.json (`predev`, `pretest`, `pretest:watch`,
 * `prestart`, `prebuild`, `predb:init`).
 *
 * Cost:
 * - First ever run on a platform: ~30 s rebuild.
 * - Every subsequent switch to a platform we've already cached: <1 s.
 * - Same-platform re-runs: near-zero (just a require() probe).
 *
 * Race warning: don't run npm commands from both Windows and WSL
 * simultaneously against the same checkout — they'll fight over the
 * single binary file in node_modules. The cache doesn't protect against
 * concurrent writes.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const BINARY_PATH = path.join(
  REPO_ROOT,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
const CACHE_DIR = path.join(REPO_ROOT, "data", ".native-cache");

function platformKey() {
  // Include the sqlite package version in the key so a package bump
  // invalidates the cache automatically — otherwise we'd happily restore
  // an old ABI-compatible binary that no longer matches the JS wrapper.
  const pkg = require("better-sqlite3/package.json");
  return [
    process.platform,
    process.arch,
    process.versions.modules,
    "sqlite" + pkg.version,
  ].join("-");
}

function cachePath() {
  return path.join(CACHE_DIR, "better_sqlite3-" + platformKey() + ".node");
}

function tryLoad() {
  try {
    // Clear any require-cache entry so retries after a binary swap
    // actually re-read the file from disk.
    const entry = require.resolve("better-sqlite3");
    delete require.cache[entry];
    // `require('better-sqlite3')` only loads the JS wrapper; the native
    // addon is pulled in lazily inside `new Database()` (database.js :47,
    // `require('bindings')('better_sqlite3.node')`). Constructing an
    // in-memory db is the cheapest way to force the .node file to load
    // and surface an ELF/Win32 mismatch here rather than downstream.
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return true;
  } catch (_err) {
    return false;
  }
}

function saveCache() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // Unlink first so we're not constrained by ownership of any existing
  // cache entry (same rationale as swapBinary).
  try {
    fs.unlinkSync(cachePath());
  } catch (_) {
    /* not present, fine */
  }
  fs.copyFileSync(BINARY_PATH, cachePath());
}

function swapBinary(src) {
  // The existing `better_sqlite3.node` may have been written by an npm
  // install run from the *other* OS — on a 9p / NTFS mount the file ends
  // up owned by a different uid (often `root` in WSL's view of a Windows
  // writer). Overwriting via copyFileSync then fails with EACCES even
  // though the directory is writable. Unlinking requires write on the
  // parent dir only, which we do have, so `unlink + copy` sidesteps the
  // ownership mismatch cleanly.
  try {
    if (fs.existsSync(BINARY_PATH)) fs.unlinkSync(BINARY_PATH);
  } catch (_) {
    /* fall through — copyFileSync will surface a real problem */
  }
  fs.copyFileSync(src, BINARY_PATH);
}

function restoreFromCache() {
  const cached = cachePath();
  if (!fs.existsSync(cached)) return false;
  try {
    swapBinary(cached);
  } catch (_) {
    return false;
  }
  return tryLoad();
}

function rebuild() {
  console.log(
    "[ensure-native] rebuilding better-sqlite3 for " + platformKey(),
  );
  execSync("npm rebuild better-sqlite3", { stdio: "inherit" });
}

// Fast path: binary already matches this runtime. Seed the cache if it's
// the first time we've seen this platform — that makes the *next* switch
// a file copy instead of a rebuild.
if (tryLoad()) {
  if (!fs.existsSync(cachePath())) {
    saveCache();
    console.log("[ensure-native] cached binary for " + platformKey());
  }
  process.exit(0);
}

console.log(
  "[ensure-native] better-sqlite3 binary missing or wrong platform",
);

if (restoreFromCache()) {
  console.log("[ensure-native] restored from cache — no rebuild");
  process.exit(0);
}

rebuild();
saveCache();
console.log("[ensure-native] rebuild complete, cached for next switch");
