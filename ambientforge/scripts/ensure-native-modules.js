#!/usr/bin/env node
/**
 * Verify better-sqlite3's native binding loads on this platform.
 * If the prebuilt binary mismatches (ELF on Windows, wrong ABI, etc.),
 * fall back to rebuilding from source.
 *
 * Runs as a postinstall hook. Idempotent + silent on success.
 */
const { execSync, spawnSync } = require('node:child_process');
const path = require('node:path');

function probe() {
  const result = spawnSync(
    process.execPath,
    ['-e', "require('better-sqlite3'); process.exit(0);"],
    { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' },
  );
  return { ok: result.status === 0, stderr: result.stderr || '' };
}

function rebuild() {
  console.log('[ensure-native-modules] Rebuilding better-sqlite3 from source…');
  execSync('npm rebuild better-sqlite3 --build-from-source', {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
}

try {
  // Skip when better-sqlite3 isn't installed yet (e.g. fresh clone before npm install completes).
  require.resolve('better-sqlite3', { paths: [process.cwd()] });
} catch {
  process.exit(0);
}

const first = probe();
if (first.ok) {
  process.exit(0);
}

const looksLikeNative = /Module|ELF|invalid ELF|wrong ELF class|NODE_MODULE_VERSION|napi|was compiled against|cannot open shared object|not a valid Win32 application/i.test(
  first.stderr,
);

if (!looksLikeNative) {
  // Some other error (e.g. typo in caller); surface it.
  console.error('[ensure-native-modules] better-sqlite3 failed to load:');
  console.error(first.stderr);
  process.exit(1);
}

try {
  rebuild();
} catch (err) {
  console.error('[ensure-native-modules] Rebuild failed.');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}

const second = probe();
if (!second.ok) {
  console.error('[ensure-native-modules] better-sqlite3 still failing after rebuild:');
  console.error(second.stderr);
  process.exit(1);
}
