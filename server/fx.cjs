/*
 * The native FX process.
 *
 * Release builds ship a prebuilt binary for each target under `native/prebuilt`.
 * That is the path a normal user takes: no compiler, no first-call pause, no
 * Xcode Command Line Tools requirement. The source and its vendored headers
 * still travel with the extension, so a developer checkout can compile the same
 * program into extension storage when no prebuilt matches.
 *
 * Resolution order:
 *   1. PHOTONEXT_FX_BINARY, for native development and tests.
 *   2. native/prebuilt/photonext_fx-<platform>-<arch>[.exe]
 *   3. a compiled binary cached under MINOTAURIS_EXTENSION_DATA/native
 *   4. compile on demand from native/photonext_fx.cpp
 *
 * Both binaries answer `--version`; a mismatch is treated like a missing
 * binary, so a stale prebuilt can never silently run older pixel code.
 *
 * One binary serves both jobs:
 *   photonext_fx --text <job>     SDF extruded text
 *   photonext_fx --effect <job>   raw RGBA effects
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENGINE_VERSION = '1.2.0';
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const NATIVE_SOURCE = path.join(EXTENSION_ROOT, 'native', 'photonext_fx.cpp');
const VENDOR_DIR = path.join(EXTENSION_ROOT, 'native', 'vendor');
const PREBUILT_DIR = path.join(EXTENSION_ROOT, 'native', 'prebuilt');
const BUILD_TIMEOUT_MS = 180000;
const PROBE_TIMEOUT_MS = 8000;
const RENDER_TIMEOUT_MS = 180000;
const MAX_BUILD_BUFFER = 4 * 1024 * 1024;

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseLines(text) {
  const result = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    result[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return result;
}

function binaryName(platform, arch) {
  return 'photonext_fx-' + platform + '-' + arch + (platform === 'win32' ? '.exe' : '');
}

function prebuiltPath(platform, arch) {
  return path.join(PREBUILT_DIR, binaryName(platform || process.platform, arch || process.arch));
}

function executable(pathname) {
  try {
    if (process.platform !== 'win32') fs.accessSync(pathname, fs.constants.X_OK);
    else fs.accessSync(pathname, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function versionOf(binaryPath) {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return parseLines(result.stdout).engine_version || null;
}

function createFx(dataDir) {
  const root = path.resolve(dataDir);
  const cacheDir = path.join(root, 'native');
  const compiledBinary = path.join(cacheDir, binaryName(process.platform, process.arch));
  const buildInfo = compiledBinary + '.json';
  const bundledBinary = prebuiltPath();
  let building = null;
  let resolved = null;
  let resolvedSource = null;

  function compiler() {
    // A Windows developer prompt has MSVC, not clang/g++. The release binary is
    // prebuilt, but the source fallback should work on every host too.
    if (process.platform === 'win32') {
      const msvc = spawnSync('cl', ['/Bv'], {
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 64 * 1024,
      });
      if (!msvc.error && msvc.status === 0) return 'cl';
    }
    const candidates = [process.env.CXX, 'c++', 'clang++', 'g++'].filter(Boolean);
    for (const candidate of candidates) {
      const check = spawnSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 64 * 1024,
      });
      if (!check.error && check.status === 0) return candidate;
    }
    return null;
  }

  function sourceIsNewerThanBinary() {
    if (!fs.existsSync(compiledBinary)) return true;
    let builtAt = 0;
    try {
      builtAt = fs.statSync(compiledBinary).mtimeMs;
    } catch {
      return true;
    }
    const sources = [NATIVE_SOURCE];
    try {
      for (const name of fs.readdirSync(VENDOR_DIR)) {
        if (/\.(h|hpp)$/i.test(name)) sources.push(path.join(VENDOR_DIR, name));
      }
    } catch {
      return true;
    }
    return sources.some((source) => {
      try {
        return fs.statSync(source).mtimeMs > builtAt;
      } catch {
        return true;
      }
    });
  }

  function cachedVersion() {
    try {
      return JSON.parse(fs.readFileSync(buildInfo, 'utf8')).engineVersion || null;
    } catch {
      return null;
    }
  }

  /**
   * Run a prebuilt if it is present, executable and the version this build of
   * the extension expects. A Unix binary copied out of a zip can lose its
   * executable bit; repair it here rather than falling back to a compiler the
   * user may not have.
   */
  function bundledVersion() {
    if (!fs.existsSync(bundledBinary)) return null;
    if (!executable(bundledBinary)) {
      try {
        fs.chmodSync(bundledBinary, 0o755);
      } catch {
        // Windows has no executable bit; the access check already covers it.
      }
    }
    if (!executable(bundledBinary)) return null;
    const version = versionOf(bundledBinary);
    return version === ENGINE_VERSION ? version : null;
  }

  function build() {
    if (building) return building;
    building = new Promise((resolve, reject) => {
      try {
        const cxx = compiler();
        if (!cxx) {
          throw new Error(
            'No C++ compiler was found and no matching prebuilt engine is available for ' +
              process.platform +
              '-' +
              process.arch +
              '. Reinstall the app so its bundled engine is restored, or install Xcode ' +
              'Command Line Tools (xcode-select --install) / clang / g++ and retry.'
          );
        }
        fs.mkdirSync(cacheDir, { recursive: true });
        const temporary =
          compiledBinary +
          '.tmp-' +
          process.pid +
          '-' +
          Date.now() +
          (process.platform === 'win32' ? '.exe' : '');
        const objectDir = path.join(cacheDir, '.obj');
        if (cxx === 'cl') fs.mkdirSync(objectDir, { recursive: true });
        const args =
          cxx === 'cl'
            ? [
                '/nologo',
                '/std:c++17',
                '/O2',
                '/EHsc',
                '/MT',
                '/D_CRT_SECURE_NO_WARNINGS',
                '/I',
                VENDOR_DIR,
                NATIVE_SOURCE,
                '/Fe:' + temporary,
                '/Fo:' + objectDir + path.sep,
              ]
            : [
                '-std=c++17',
                '-O3',
                '-Wno-deprecated-declarations',
                '-I',
                VENDOR_DIR,
                NATIVE_SOURCE,
                '-o',
                temporary,
              ];
        const result = spawnSync(cxx, args, {
          encoding: 'utf8',
          timeout: BUILD_TIMEOUT_MS,
          maxBuffer: MAX_BUILD_BUFFER,
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
          try {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
          } catch {
            // The compiler output is the useful failure.
          }
          throw new Error(
            'The native FX engine did not compile: ' +
              String(result.stderr || result.stdout || '').trim().slice(-4000)
          );
        }
        fs.renameSync(temporary, compiledBinary);
        fs.writeFileSync(
          buildInfo,
          JSON.stringify(
            {
              engineVersion: ENGINE_VERSION,
              compiler: cxx,
              platform: process.platform,
              arch: process.arch,
              compiledAt: new Date().toISOString(),
            },
            null,
            2
          )
        );
        resolve(compiledBinary);
      } catch (error) {
        reject(error);
      } finally {
        building = null;
      }
    });
    return building;
  }

  async function ensure() {
    if (resolved && fs.existsSync(resolved)) return resolved;

    const override = process.env.PHOTONEXT_FX_BINARY;
    if (override) {
      if (!fs.existsSync(override)) {
        throw new Error('PHOTONEXT_FX_BINARY points at a file that does not exist: ' + override);
      }
      if (versionOf(override) !== ENGINE_VERSION) {
        throw new Error(
          'PHOTONEXT_FX_BINARY is not engine version ' + ENGINE_VERSION + ': ' + override
        );
      }
      resolved = override;
      resolvedSource = 'override';
      return resolved;
    }

    // A shipped binary is the normal path. Version-checking it is cheap (one
    // process spawn on the first call) and keeps a stale bundle from running.
    if (bundledVersion()) {
      resolved = bundledBinary;
      resolvedSource = 'bundled';
      return resolved;
    }

    if (
      fs.existsSync(compiledBinary) &&
      cachedVersion() === ENGINE_VERSION &&
      !sourceIsNewerThanBinary()
    ) {
      resolved = compiledBinary;
      resolvedSource = 'compiled';
      return resolved;
    }

    await build();
    resolved = compiledBinary;
    resolvedSource = 'compiled';
    return resolved;
  }

  async function run(mode, jobPath) {
    const binary = await ensure();
    const result = spawnSync(binary, [mode, jobPath], {
      encoding: 'utf8',
      timeout: RENDER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        'The native ' +
          (mode === '--text' ? '3D text' : 'effect') +
          ' render failed: ' +
          String(result.stderr || result.stdout || '').trim().slice(-3000)
      );
    }
    const values = parseLines(result.stdout);
    return {
      engine: 'native-cpp',
      engineVersion: ENGINE_VERSION,
      renderMs: Number(values.render_ms) || 0,
      width: Number(values.width) || 0,
      height: Number(values.height) || 0,
      effect: values.effect || null,
      samples: Number(values.samples) || 0,
      rays: Number(values.rays) || 0,
    };
  }

  function temporaryPaths() {
    fs.mkdirSync(cacheDir, { recursive: true });
    const nonce = process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    return {
      mask: path.join(cacheDir, 'mask-' + nonce + '.png'),
      output: path.join(cacheDir, 'fx-' + nonce + '.png'),
      inputRaw: path.join(cacheDir, 'fx-' + nonce + '.in.raw'),
      outputRaw: path.join(cacheDir, 'fx-' + nonce + '.out.raw'),
      job: path.join(cacheDir, 'job-' + nonce + '.txt'),
    };
  }

  function status() {
    const bundled = fs.existsSync(bundledBinary);
    const compiled = fs.existsSync(compiledBinary);
    return {
      engine: 'native-cpp',
      engineVersion: ENGINE_VERSION,
      available: Boolean(resolved ? fs.existsSync(resolved) : bundled || compiled),
      // `source` is a report, not a probe: status must never trigger a compiler
      // or a version check just because the inspector was opened.
      source: resolvedSource || (bundled ? 'bundled' : compiled ? 'compiled' : null),
      bundled: bundled,
      binary: resolved || (bundled ? bundledBinary : compiled ? compiledBinary : null),
      prebuilt: bundledBinary,
      sourcePath: NATIVE_SOURCE,
      platform: process.platform,
      arch: process.arch,
      compiledAt: (() => {
        try {
          return JSON.parse(fs.readFileSync(buildInfo, 'utf8')).compiledAt || null;
        } catch {
          return null;
        }
      })(),
    };
  }

  return {
    binary: compiledBinary,
    bundledBinary: bundledBinary,
    build: build,
    ensure: ensure,
    run: run,
    status: status,
    temporaryPaths: temporaryPaths,
  };
}

module.exports = {
  ENGINE_VERSION: ENGINE_VERSION,
  NATIVE_SOURCE: NATIVE_SOURCE,
  VENDOR_DIR: VENDOR_DIR,
  PREBUILT_DIR: PREBUILT_DIR,
  binaryName: binaryName,
  prebuiltPath: prebuiltPath,
  createFx: createFx,
  messageOf: messageOf,
};
