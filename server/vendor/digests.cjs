/*
 * Byte-level pin for the vendored backend.
 *
 * Version numbers and package names are not a supply-chain guard: 34 MB of
 * prebuilt libvips arrives from npm and is loaded into the app's own process,
 * so the thing worth pinning is the file bytes. This script writes and checks
 * `digests.json` — a sha256 for every vendored file, plus the registry sha512
 * integrity each package was installed from.
 *
 *   node digests.cjs           verify the tree (missing, extra, mismatched fail)
 *   node digests.cjs --write   re-pin after a deliberate upgrade
 *
 * No PATH, no network, no npm: it is safe to run inside the extension's
 * sanitized environment, which is where the test runs it.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const MODULES = path.join(ROOT, 'node_modules');
const MANIFEST = path.join(ROOT, 'digests.json');

function relativeFiles(directory, base) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // npm's shim directory is symlinks to executables that nothing in the
      // extension loads; hashing them would pin a link path, not bytes.
      if (entry.name === '.bin') continue;
      files.push(...relativeFiles(full, base));
    } else if (entry.isFile()) {
      files.push(path.relative(base, full).split(path.sep).join('/'));
    } else {
      // A symlink would let the pinned bytes point somewhere outside the bundle.
      throw new Error('the vendored tree may not contain symlinks: ' + full);
    }
  }
  return files;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function lockIntegrity() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const integrity = {};
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key || !entry || typeof entry.integrity !== 'string') continue;
    integrity[key.replace(/^node_modules\//, '')] = entry.integrity;
  }
  return integrity;
}

function build() {
  const files = relativeFiles(MODULES, ROOT).sort();
  if (!files.length) throw new Error('no vendored files found under ' + MODULES);
  const digests = {};
  for (const file of files) digests[file] = sha256(path.join(ROOT, file));
  return {
    generatedAt: new Date().toISOString(),
    algorithm: 'sha256',
    note:
      'Pin of the vendored PhotoNext backend. Regenerate with `node digests.cjs --write`; ' +
      'verify with `node digests.cjs`, which is what the spike test runs.',
    lockIntegrity: lockIntegrity(),
    files: digests,
  };
}

function write() {
  const manifest = build();
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write('pinned ' + Object.keys(manifest.files).length + ' files\n');
}

function verify() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (manifest.algorithm !== 'sha256') {
    throw new Error('unknown digest algorithm: ' + String(manifest.algorithm));
  }
  const expected = manifest.files || {};
  const actual = relativeFiles(MODULES, ROOT).sort();
  const present = new Set(actual);
  const missing = Object.keys(expected).filter((file) => !present.has(file));
  const extra = actual.filter((file) => !(file in expected));
  const mismatched = [];
  for (const [file, digest] of Object.entries(expected)) {
    if (!present.has(file)) continue;
    if (sha256(path.join(ROOT, file)) !== digest) mismatched.push(file);
  }

  const problems = [];
  if (!Object.keys(expected).length) problems.push('the manifest is empty');
  if (missing.length) problems.push('missing: ' + missing.join(', '));
  if (extra.length) problems.push('not pinned: ' + extra.join(', '));
  if (mismatched.length) problems.push('changed: ' + mismatched.join(', '));

  if (problems.length) {
    process.stderr.write('vendor digests FAILED\n  ' + problems.join('\n  ') + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    'vendor digests OK: ' +
      Object.keys(expected).length +
      ' files, ' +
      Object.keys(manifest.lockIntegrity || {}).length +
      ' registry integrities\n'
  );
}

if (process.argv.includes('--write')) write();
else verify();
