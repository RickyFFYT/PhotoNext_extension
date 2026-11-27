/*
 * 3D colour lookup tables (.cube), installed as document-side assets.
 *
 * A LUT is the compact way to ship a "look": one call grades a photo the way a
 * colourist would, and the same file reproduces the same result on every
 * machine. The parser accepts the Adobe/Resolve .cube subset that matters —
 * TITLE, LUT_3D_SIZE, DOMAIN_MIN/MAX and the RGB triples — and rejects anything
 * ambiguous instead of silently reading the wrong number of entries.
 *
 * Interpolation is tetrahedral, not trilinear: for a LUT this is the standard
 * choice because it preserves the diagonal (neutral) axis and avoids the
 * visible triangulation a trilinear read can leave on skin tones.
 *
 * Storage lives under MINOTAURIS_EXTENSION_DATA/luts, like fonts, so a look
 * travels with the document and never depends on a system install.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LUTS_DIR = 'luts';
const REGISTRY_FILE = 'luts.json';
const MAX_BYTES = 32 * 1024 * 1024;
const MIN_SIZE = 2;
const MAX_SIZE = 65;

let configuredDir = null;
const cache = new Map();

function configure(dataDir) {
  configuredDir = dataDir;
  cache.clear();
}

function lutDir() {
  return path.join(configuredDir, LUTS_DIR);
}

function registryPath() {
  return path.join(lutDir(), REGISTRY_FILE);
}

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries) {
  fs.mkdirSync(lutDir(), { recursive: true });
  fs.writeFileSync(registryPath(), JSON.stringify(entries, null, 2));
}

function slug(name) {
  return (
    String(name || 'look')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'look'
  );
}

/**
 * Parse a .cube file. Returns `{title, size, domainMin, domainMax, data}` where
 * `data` is size³ RGB triples in 0..1, blue varying slowest (the format's
 * ordering).
 */
function parseCube(text, fallbackTitle) {
  const lines = String(text || '').split(/\r?\n/);
  let size = null;
  let title = fallbackTitle || null;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('TITLE')) {
      const match = /^TITLE\s+"?(.*?)"?\s*$/i.exec(line);
      if (match) title = match[1];
      continue;
    }
    if (upper.startsWith('LUT_1D_SIZE')) {
      throw new Error('1D .cube LUTs are not supported; install a 3D LUT.');
    }
    if (upper.startsWith('LUT_3D_SIZE')) {
      const parts = line.split(/\s+/);
      size = Math.round(Number(parts[1]));
      continue;
    }
    if (upper.startsWith('DOMAIN_MIN')) {
      domainMin = line
        .split(/\s+/)
        .slice(1, 4)
        .map((entry) => Number(entry));
      continue;
    }
    if (upper.startsWith('DOMAIN_MAX')) {
      domainMax = line
        .split(/\s+/)
        .slice(1, 4)
        .map((entry) => Number(entry));
      continue;
    }
    if (/^[A-Z_]+/.test(line)) continue; // an unknown directive: ignore, do not misread it as data
    const parts = line.split(/\s+/).map((entry) => Number(entry));
    if (parts.length < 3 || parts.some((entry) => !Number.isFinite(entry))) {
      throw new Error('The .cube file has a data row that is not three numbers: "' + line + '".');
    }
    values.push(parts[0], parts[1], parts[2]);
  }
  if (!size || !Number.isFinite(size)) {
    throw new Error('The .cube file has no LUT_3D_SIZE.');
  }
  if (size < MIN_SIZE || size > MAX_SIZE) {
    throw new Error('LUT_3D_SIZE must be between ' + MIN_SIZE + ' and ' + MAX_SIZE + ' (got ' + size + ').');
  }
  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new Error(
      'The .cube file has ' +
        values.length / 3 +
        ' entries; a ' +
        size +
        '³ LUT needs ' +
        expected / 3 +
        '.'
    );
  }
  if (
    domainMin.some((entry) => !Number.isFinite(entry)) ||
    domainMax.some((entry) => !Number.isFinite(entry)) ||
    domainMax[0] === domainMin[0]
  ) {
    throw new Error('The .cube DOMAIN_MIN/DOMAIN_MAX values are not usable.');
  }
  return {
    title: title || null,
    size: size,
    domainMin: domainMin,
    domainMax: domainMax,
    data: Float32Array.from(values),
  };
}

function indexOf(cube, x, y, z) {
  const n = cube.size;
  return ((z * n + y) * n + x) * 3;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/** Sample one colour (0..1) with tetrahedral interpolation. */
function sample(cube, red, green, blue) {
  const n = cube.size;
  const r = clamp01((red - cube.domainMin[0]) / (cube.domainMax[0] - cube.domainMin[0]));
  const g = clamp01((green - cube.domainMin[1]) / (cube.domainMax[1] - cube.domainMin[1]));
  const b = clamp01((blue - cube.domainMin[2]) / (cube.domainMax[2] - cube.domainMin[2]));
  const x = r * (n - 1);
  const y = g * (n - 1);
  const z = b * (n - 1);
  const x0 = Math.min(n - 1, Math.floor(x));
  const y0 = Math.min(n - 1, Math.floor(y));
  const z0 = Math.min(n - 1, Math.floor(z));
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const z1 = Math.min(n - 1, z0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const d = cube.data;
  const c000 = indexOf(cube, x0, y0, z0);
  const c111 = indexOf(cube, x1, y1, z1);
  const result = [0, 0, 0];

  // Six tetrahedra: pick the one the fractional point falls in, then read four
  // corners. This is the published tetrahedral formulation, written out rather
  // than ported from a library.
  let corners;
  if (fx > fy) {
    if (fy > fz) {
      corners = [
        [c000, 1 - fx, 0, 0],
        [indexOf(cube, x1, y0, z0), fx - fy, 0, 0],
        [indexOf(cube, x1, y1, z0), fy - fz, 0, 0],
        [c111, fz, 0, 0],
      ];
    } else if (fx > fz) {
      corners = [
        [c000, 1 - fx, 0, 0],
        [indexOf(cube, x1, y0, z0), fx - fz, 0, 0],
        [indexOf(cube, x1, y0, z1), fz - fy, 0, 0],
        [c111, fy, 0, 0],
      ];
    } else {
      corners = [
        [c000, 1 - fz, 0, 0],
        [indexOf(cube, x0, y0, z1), fz - fx, 0, 0],
        [indexOf(cube, x1, y0, z1), fx - fy, 0, 0],
        [c111, fy, 0, 0],
      ];
    }
  } else if (fz > fy) {
    corners = [
      [c000, 1 - fz, 0, 0],
      [indexOf(cube, x0, y0, z1), fz - fy, 0, 0],
      [indexOf(cube, x0, y1, z1), fy - fx, 0, 0],
      [c111, fx, 0, 0],
    ];
  } else if (fz > fx) {
    corners = [
      [c000, 1 - fy, 0, 0],
      [indexOf(cube, x0, y1, z0), fy - fz, 0, 0],
      [indexOf(cube, x0, y1, z1), fz - fx, 0, 0],
      [c111, fx, 0, 0],
    ];
  } else {
    corners = [
      [c000, 1 - fy, 0, 0],
      [indexOf(cube, x1, y0, z0), fy - fx, 0, 0],
      [indexOf(cube, x1, y1, z0), fx - fz, 0, 0],
      [c111, fz, 0, 0],
    ];
  }
  for (const corner of corners) {
    const weight = corner[1];
    result[0] += d[corner[0]] * weight;
    result[1] += d[corner[0] + 1] * weight;
    result[2] += d[corner[0] + 2] * weight;
  }
  return result;
}

function lookupByFile(file) {
  const full = path.join(configuredDir, file);
  const stats = fs.statSync(full);
  const key = file + ':' + stats.mtimeMs;
  if (cache.has(key)) return cache.get(key);
  const cube = parseCube(fs.readFileSync(full, 'utf8'), path.basename(file));
  cache.set(key, cube);
  return cube;
}

function findEntry(name) {
  const needle = String(name || '').toLowerCase();
  return (
    readRegistry().find((entry) => String(entry.name).toLowerCase() === needle) ||
    readRegistry().find((entry) => String(entry.slug) === needle) ||
    null
  );
}

function exists(name) {
  return Boolean(configuredDir && findEntry(name));
}

function list() {
  return readRegistry().map((entry) => ({
    name: entry.name,
    title: entry.title,
    size: entry.size,
    bytes: entry.bytes,
    installedAt: entry.installedAt,
  }));
}

function installFromPath(file, options) {
  if (!configuredDir) throw new Error('LUT storage is not configured.');
  const settings = options || {};
  if (!fs.existsSync(file)) throw new Error('No LUT exists at ' + file + '.');
  const stats = fs.statSync(file);
  if (!stats.isFile()) throw new Error(file + ' is not a file.');
  if (stats.size > MAX_BYTES) {
    throw new Error('The LUT is larger than the ' + MAX_BYTES / 1024 / 1024 + ' MB limit.');
  }
  const cube = parseCube(fs.readFileSync(file, 'utf8'), path.basename(file, path.extname(file)));
  const name = String(settings.name || cube.title || path.basename(file, path.extname(file))).trim();
  if (!name) throw new Error('The LUT needs a name.');
  const existing = findEntry(name);
  if (existing && settings.replace !== true) {
    throw new Error('A LUT called "' + name + '" is already installed. Pass replace: true to replace it.');
  }
  const entry = {
    name: name,
    slug: slug(name),
    title: cube.title,
    size: cube.size,
    file: LUTS_DIR + '/' + slug(name) + '-' + crypto.randomBytes(4).toString('hex') + '.cube',
    bytes: stats.size,
    installedAt: new Date().toISOString(),
  };
  fs.mkdirSync(lutDir(), { recursive: true });
  fs.copyFileSync(file, path.join(configuredDir, entry.file));
  const registry = readRegistry().filter(
    (candidate) => String(candidate.name).toLowerCase() !== name.toLowerCase()
  );
  registry.push(entry);
  writeRegistry(registry);
  cache.clear();
  return entry;
}

function remove(name) {
  const entry = findEntry(name);
  if (!entry) return false;
  writeRegistry(
    readRegistry().filter(
      (candidate) => String(candidate.name).toLowerCase() !== String(entry.name).toLowerCase()
    )
  );
  try {
    fs.rmSync(path.join(configuredDir, entry.file), { force: true });
  } catch {
    // The registry no longer references it; a leftover file is harmless.
  }
  cache.clear();
  return true;
}

/** Apply a named LUT to a raw RGBA buffer, in place. */
function applyToRaw(raw, operation) {
  const requested = operation.lut !== undefined ? operation.lut : operation.name;
  const entry = findEntry(requested);
  if (!entry) {
    throw new Error(
      'No LUT called "' +
        requested +
        '". Installed: ' +
        (list().map((look) => look.name).join(', ') || 'none') +
        '. Nothing was changed.'
    );
  }
  const cube = lookupByFile(entry.file);
  const intensity =
    operation.intensity === undefined ? 1 : Math.max(0, Math.min(1, Number(operation.intensity) / 100));
  const channels = raw.channels || 4;
  for (let index = 0; index < raw.width * raw.height; index += 1) {
    const base = index * channels;
    if (raw.data[base + 3] === 0) continue;
    const graded = sample(
      cube,
      raw.data[base] / 255,
      raw.data[base + 1] / 255,
      raw.data[base + 2] / 255
    );
    for (let channel = 0; channel < 3; channel += 1) {
      const target = Math.round(clamp01(graded[channel]) * 255);
      raw.data[base + channel] = Math.round(
        raw.data[base + channel] * (1 - intensity) + target * intensity
      );
    }
  }
  return raw;
}

module.exports = {
  MAX_BYTES: MAX_BYTES,
  applyToRaw: applyToRaw,
  configure: configure,
  exists: exists,
  installFromPath: installFromPath,
  list: list,
  parseCube: parseCube,
  remove: remove,
  sample: sample,
};
