/*
 * The native 3D compositor, built on demand.
 *
 * Shipping a per-platform binary for every desktop target is a release problem;
 * until that exists, the source and its vendored headers live with the
 * extension and the first 3D call compiles a small C++ program into extension
 * storage. The result is cached by source/header timestamp, so normal renders do
 * not pay for compilation. If the machine has no C++ compiler this fails with
 * the command and compiler output, rather than pretending the feature exists.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scene3d = require('./scene3d.cjs');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const NATIVE_SOURCE = path.join(EXTENSION_ROOT, 'native', 'photo3d.cpp');
const VENDOR_DIR = path.join(EXTENSION_ROOT, 'native', 'vendor');
const BUILD_TIMEOUT_MS = 180000;
const RENDER_TIMEOUT_MS = 120000;
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

function safeRelative(file) {
  const resolved = path.resolve(file);
  const root = path.resolve(path.dirname(NATIVE_SOURCE), '..');
  return resolved.startsWith(root + path.sep) || resolved === root;
}

function createNative3d(dataDir) {
  const root = path.resolve(dataDir);
  const cacheDir = path.join(root, 'native');
  const modelsDir = path.join(root, 'models');
  const binary = path.join(
    cacheDir,
    'photo3d-' + process.platform + '-' + process.arch + (process.platform === 'win32' ? '.exe' : '')
  );
  const buildInfo = binary + '.json';
  let building = null;

  function compiler() {
    const candidates = [
      process.env.CXX,
      'c++',
      'clang++',
      'g++',
    ].filter(Boolean);
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
    if (!fs.existsSync(binary)) return true;
    let builtAt = 0;
    try {
      builtAt = fs.statSync(binary).mtimeMs;
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

  function build() {
    if (building) return building;
    building = new Promise((resolve, reject) => {
      try {
        const cxx = compiler();
        if (!cxx) {
          throw new Error(
            'No C++ compiler was found. The 3D compositor is native C++; install Xcode ' +
              'Command Line Tools (xcode-select --install) or clang/g++ and retry.'
          );
        }
        fs.mkdirSync(cacheDir, { recursive: true });
        const temporary = binary + '.tmp-' + process.pid + '-' + Date.now();
        const result = spawnSync(
          cxx,
          [
            '-std=c++17',
            '-O3',
            '-Wno-deprecated-declarations',
            '-I',
            VENDOR_DIR,
            NATIVE_SOURCE,
            '-o',
            temporary,
          ],
          {
            encoding: 'utf8',
            timeout: BUILD_TIMEOUT_MS,
            maxBuffer: MAX_BUILD_BUFFER,
          }
        );
        if (result.error) throw result.error;
        if (result.status !== 0) {
          try {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
          } catch {
            // The compiler output is the useful failure.
          }
          throw new Error(
            'The native 3D compositor did not compile: ' +
              String(result.stderr || result.stdout || '').trim().slice(-4000)
          );
        }
        fs.renameSync(temporary, binary);
        fs.writeFileSync(
          buildInfo,
          JSON.stringify(
            {
              engineVersion: scene3d.ENGINE_VERSION,
              compiler: cxx,
              platform: process.platform,
              arch: process.arch,
              compiledAt: new Date().toISOString(),
            },
            null,
            2
          )
        );
        resolve(binary);
      } catch (error) {
        reject(error);
      } finally {
        building = null;
      }
    });
    return building;
  }

  async function ensure() {
    if (cachedVersion() !== scene3d.ENGINE_VERSION || sourceIsNewerThanBinary()) {
      await build();
    }
    if (!fs.existsSync(binary)) throw new Error('The native 3D compositor is missing after build.');
    return binary;
  }

  function runRender(modelPath, outputPath, options) {
    const jobPath = path.join(cacheDir, 'job-' + process.pid + '-' + Date.now() + '.txt');
    const job = scene3d.jobFor(options.scene, {
      modelPath: modelPath,
      outputPath: outputPath,
      width: options.width,
      height: options.height,
    });
    fs.writeFileSync(jobPath, job, 'utf8');
    try {
      return spawnSync(binary, ['--render', jobPath], {
        encoding: 'utf8',
        timeout: RENDER_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
    } finally {
      try {
        fs.unlinkSync(jobPath);
      } catch {
        // A stale job file is harmless and sits under our own cache.
      }
    }
  }

  function probe(modelPath) {
    return new Promise(async (resolve, reject) => {
      try {
        await ensure();
        if (!fs.existsSync(modelPath)) throw new Error('No model exists at ' + modelPath + '.');
        const result = spawnSync(binary, ['--probe', modelPath], {
          encoding: 'utf8',
          timeout: RENDER_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
          throw new Error(
            'The 3D model could not be read: ' +
              String(result.stderr || result.stdout || '').trim().slice(-3000)
          );
        }
        const values = parseLines(result.stdout);
        const dimensions = {};
        for (const key of [
          'meshes',
          'primitives',
          'triangles',
          'materials',
          'textures',
          'min_x',
          'min_y',
          'min_z',
          'max_x',
          'max_y',
          'max_z',
        ]) {
          const value = Number(values[key]);
          if (!Number.isFinite(value)) throw new Error('The native 3D probe returned no ' + key + '.');
          dimensions[key] = value;
        }
        resolve({
          engine: 'native-cpp',
          engineVersion: scene3d.ENGINE_VERSION,
          meshes: dimensions.meshes,
          primitives: dimensions.primitives,
          triangles: dimensions.triangles,
          materials: dimensions.materials,
          textures: dimensions.textures,
          bounds: {
            min: [dimensions.min_x, dimensions.min_y, dimensions.min_z],
            max: [dimensions.max_x, dimensions.max_y, dimensions.max_z],
          },
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function render(scene, options) {
    await ensure();
    const settings = options || {};
    const output = path.join(cacheDir, 'render-' + process.pid + '-' + Date.now() + '.png');
    try {
      const result = runRender(settings.modelPath, output, {
        scene: scene,
        width: settings.width,
        height: settings.height,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(
          'The native 3D render failed: ' +
            String(result.stderr || result.stdout || '').trim().slice(-3000)
        );
      }
      if (!fs.existsSync(output)) throw new Error('The native 3D render wrote no image.');
      const values = parseLines(result.stdout);
      return {
        buffer: fs.readFileSync(output),
        renderMs: Number(values.render_ms) || 0,
        engine: 'native-cpp',
        width: Number(values.width) || settings.width,
        height: Number(values.height) || settings.height,
      };
    } finally {
      try {
        if (fs.existsSync(output)) fs.unlinkSync(output);
      } catch {
        // The output lives under the extension's own native cache.
      }
    }
  }

  function copyExternalUri(uri, sourceDir, destinationDir) {
    if (typeof uri !== 'string' || !uri || /^data:/i.test(uri) || /^https?:/i.test(uri)) return;
    let decoded;
    try {
      decoded = decodeURIComponent(uri);
    } catch {
      throw new Error('The glTF contains an invalid external URI: ' + uri);
    }
    if (path.isAbsolute(decoded) || decoded.split(/[\\/]/).includes('..')) {
      throw new Error('The glTF references a resource outside its folder: ' + uri);
    }
    const from = path.join(sourceDir, decoded);
    const to = path.join(destinationDir, decoded);
    if (!fs.existsSync(from)) {
      throw new Error('The glTF references a missing file: ' + decoded);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  async function importModel(sourcePath) {
    const extension = path.extname(sourcePath).toLowerCase();
    if (extension !== '.glb' && extension !== '.gltf') {
      throw new Error('3D models must be .glb or .gltf files.');
    }
    if (!fs.existsSync(sourcePath)) throw new Error('No model exists at ' + sourcePath + '.');
    if (!fs.statSync(sourcePath).isFile()) throw new Error(sourcePath + ' is not a file.');
    const id = 'model_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
    const modelDir = path.join(modelsDir, id);
    const destination = path.join(modelDir, path.basename(sourcePath));
    fs.mkdirSync(modelDir, { recursive: true });
    try {
      fs.copyFileSync(sourcePath, destination);
      if (extension === '.gltf') {
        const json = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const sourceDir = path.dirname(sourcePath);
        for (const buffer of Array.isArray(json.buffers) ? json.buffers : []) {
          copyExternalUri(buffer.uri, sourceDir, modelDir);
        }
        for (const image of Array.isArray(json.images) ? json.images : []) {
          copyExternalUri(image.uri, sourceDir, modelDir);
        }
      }
      const probeResult = await probe(destination);
      const file = path.relative(root, destination).split(path.sep).join('/');
      return {
        file: file,
        absolute: destination,
        sourceName: path.basename(sourcePath),
        format: extension.slice(1),
        bytes: fs.statSync(destination).size,
        probe: probeResult,
      };
    } catch (error) {
      try {
        fs.rmSync(modelDir, { recursive: true, force: true });
      } catch {
        // The import itself is the failure to report.
      }
      throw error;
    }
  }

  function removeModel(file) {
    if (!file || typeof file !== 'string') return;
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(path.resolve(modelsDir) + path.sep)) return;
    try {
      fs.rmSync(path.dirname(absolute), { recursive: true, force: true });
    } catch {
      // A leftover model in our own storage is harmless.
    }
  }

  function status() {
    return {
      engine: 'native-cpp',
      engineVersion: scene3d.ENGINE_VERSION,
      available: fs.existsSync(binary),
      binary: binary,
      source: NATIVE_SOURCE,
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
    binary: binary,
    build: build,
    ensure: ensure,
    importModel: importModel,
    probe: probe,
    removeModel: removeModel,
    render: render,
    status: status,
  };
}

module.exports = {
  NATIVE_SOURCE: NATIVE_SOURCE,
  VENDOR_DIR: VENDOR_DIR,
  createNative3d: createNative3d,
  messageOf: messageOf,
  safeRelative: safeRelative,
};
