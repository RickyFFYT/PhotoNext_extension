/*
 * Fonts are workspace assets, not document pixels.
 *
 * A font is downloaded (or copied from a local path) into extension storage and
 * added to a fontconfig file that points at that directory. `photo_draw` keeps
 * using its normal SVG text path; only the render process needs a fontconfig
 * file, and putting the fonts beside the document means they survive a restart
 * without ever installing into the user's system font library.
 *
 * The font file is parsed here only enough to read its family name. That keeps
 * the tool result useful to the agent without a platform `fc-scan` binary.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const FONT_EXTENSIONS = ['.ttf', '.otf'];
const MAX_FONT_BYTES = 8 * 1024 * 1024;
const REGISTRY_FILE = 'fonts.json';
const CONFIG_FILE = 'fontconfig.conf';
const CACHE_DIR = 'font-cache';
const DOWNLOAD_TIMEOUT_MS = 25000;

function fontDir(dataDir) {
  return path.join(dataDir, 'fonts');
}

function configPath(dataDir) {
  return path.join(fontDir(dataDir), CONFIG_FILE);
}

function registryPath(dataDir) {
  return path.join(fontDir(dataDir), REGISTRY_FILE);
}

function readUInt16(buffer, offset) {
  return buffer.readUInt16BE(offset);
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function cleanName(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read the family name from the SFNT `name` table (name IDs 1 and 16). */
function parseFamily(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const signature = buffer.toString('ascii', 0, 4);
  if (signature === 'ttcf') return null;
  const tableCount = readUInt16(buffer, 4);
  if (!tableCount || 12 + tableCount * 16 > buffer.length) return null;
  let nameOffset = null;
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (record + 16 > buffer.length) break;
    if (buffer.toString('ascii', record, record + 4) !== 'name') continue;
    nameOffset = readUInt32(buffer, record + 8);
    break;
  }
  if (nameOffset === null || nameOffset + 6 > buffer.length) return null;

  const count = readUInt16(buffer, nameOffset + 2);
  const stringOffset = readUInt16(buffer, nameOffset + 4);
  let fallback = null;
  for (let index = 0; index < count; index += 1) {
    const record = nameOffset + 6 + index * 12;
    if (record + 12 > buffer.length) break;
    const platform = readUInt16(buffer, record);
    const language = readUInt16(buffer, record + 4);
    const nameId = readUInt16(buffer, record + 6);
    const length = readUInt16(buffer, record + 8);
    const offset = readUInt16(buffer, record + 10);
    if (nameId !== 1 && nameId !== 16) continue;
    const start = nameOffset + stringOffset + offset;
    const end = start + length;
    if (start < 0 || end > buffer.length || end <= start) continue;
    const raw = buffer.subarray(start, end);
    let text = null;
    if (platform === 3 || platform === 0) {
      const even = raw.length - (raw.length % 2);
      const swapped = Buffer.from(raw.subarray(0, even));
      for (let byte = 0; byte + 1 < swapped.length; byte += 2) {
        const first = swapped[byte];
        swapped[byte] = swapped[byte + 1];
        swapped[byte + 1] = first;
      }
      text = swapped.toString('utf16le');
    } else if (platform === 1) {
      text = raw.toString('latin1');
    }
    text = cleanName(text);
    if (!text) continue;
    if (nameId === 1 && platform === 3 && (language === 0x0409 || language === 0)) return text;
    if (!fallback) fallback = text;
  }
  return fallback;
}

function fallbackFamily(fileName) {
  return path
    .basename(String(fileName || 'font'), path.extname(String(fileName || '')))
    .replace(/[_-]+/g, ' ')
    .replace(/\b(regular|book|roman|medium|semibold|bold|light|italic)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fontExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const signature = buffer.toString('ascii', 0, 4);
  if (signature === 'OTTO') return '.otf';
  if (signature === '\u0000\u0001\u0000\u0000' || signature === 'true' || signature === 'typ1') {
    return '.ttf';
  }
  return null;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function systemFontDirs() {
  const home = os.homedir();
  const candidates =
    process.platform === 'darwin'
      ? [
          '/System/Library/Fonts',
          '/System/Library/Fonts/Supplemental',
          '/Library/Fonts',
          path.join(home, 'Library', 'Fonts'),
        ]
      : process.platform === 'win32'
        ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')]
        : [
            '/usr/share/fonts',
            '/usr/local/share/fonts',
            path.join(home, '.fonts'),
            path.join(home, '.local', 'share', 'fonts'),
          ];
  const seen = new Set();
  return candidates.filter((dir) => {
    if (!dir || seen.has(dir) || !fs.existsSync(dir)) return false;
    seen.add(dir);
    return true;
  });
}

/**
 * Write the fontconfig file and make it the config this process and its
 * rasteriser child use. Safe to call repeatedly; it is just a small text file.
 */
function prepare(dataDir) {
  const dir = path.resolve(fontDir(dataDir));
  const cache = path.join(dir, CACHE_DIR);
  const config = path.resolve(configPath(dataDir));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const dirs = [dir, ...systemFontDirs()];
  const contents =
    '<?xml version="1.0"?>\n' +
    '<fontconfig>\n' +
    dirs.map((entry) => '  <dir>' + xmlEscape(entry) + '</dir>').join('\n') +
    '\n  <cachedir>' +
    xmlEscape(cache) +
    '</cachedir>\n' +
    '</fontconfig>\n';
  fs.writeFileSync(config, contents);
  process.env.FONTCONFIG_FILE = config;
  process.env.PANGOCAIRO_BACKEND = 'fontconfig';
  return config;
}

function readRegistry(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry) =>
        entry &&
        typeof entry.family === 'string' &&
        typeof entry.file === 'string' &&
        fs.existsSync(path.join(dataDir, entry.file))
    );
  } catch {
    return [];
  }
}

function writeRegistry(dataDir, entries) {
  const dir = fontDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(dataDir), JSON.stringify(entries, null, 2));
}

/** Public status view: no paths outside extension storage. */
function list(dataDir) {
  return readRegistry(dataDir).map((entry) => ({
    family: entry.family,
    file: path.basename(entry.file),
    bytes: entry.bytes,
    source: entry.source,
    installedAt: entry.installedAt,
  }));
}

function families(dataDir) {
  return readRegistry(dataDir).map((entry) => entry.family);
}

function assertUnique(dataDir, family) {
  const existing = readRegistry(dataDir).find(
    (entry) => entry.family.toLowerCase() === family.toLowerCase()
  );
  if (existing) {
    throw new Error(
      'The font family "' +
        family +
        '" is already installed from ' +
        existing.source +
        '. Pick a different font or use a distinct family.'
    );
  }
}

function installBytes(dataDir, buffer, source) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('The font download was empty. Nothing was installed.');
  }
  if (buffer.length > MAX_FONT_BYTES) {
    throw new Error(
      'The font is larger than the ' +
        Math.round(MAX_FONT_BYTES / 1024 / 1024) +
        ' MB limit. Nothing was installed.'
    );
  }
  const extension = fontExtension(buffer);
  if (!extension) {
    throw new Error(
      'The downloaded file is not a TrueType or OpenType font. Install a .ttf or .otf file.'
    );
  }
  const family = parseFamily(buffer) || fallbackFamily(source);
  if (!family) {
    throw new Error('Could not read the font family name. Nothing was installed.');
  }
  assertUnique(dataDir, family);
  const dir = fontDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join('fonts', 'font-' + crypto.randomBytes(6).toString('hex') + extension);
  fs.writeFileSync(path.join(dataDir, file), buffer);
  const entry = {
    family,
    file,
    bytes: buffer.length,
    source,
    installedAt: new Date().toISOString(),
  };
  const registry = readRegistry(dataDir);
  registry.push(entry);
  writeRegistry(dataDir, registry);
  return entry;
}

function download(url, redirects) {
  const hops = redirects || 0;
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('Font URL is not a valid URL.'));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('Font URL must start with http:// or https://.'));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(
      parsed,
      { headers: { 'User-Agent': 'PhotoNext/0.6.1' } },
      (response) => {
        const status = Number(response.statusCode) || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (hops >= 5) {
            reject(new Error('Font download redirected too many times.'));
            return;
          }
          resolve(download(new URL(response.headers.location, parsed).toString(), hops + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error('Font download failed with HTTP ' + status + '.'));
          return;
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_FONT_BYTES) {
          response.destroy();
          reject(new Error('The font is larger than the 8 MB limit.'));
          return;
        }
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_FONT_BYTES) {
            response.destroy();
            reject(new Error('The font is larger than the 8 MB limit.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }
    );
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy();
      reject(new Error('Font download timed out after ' + DOWNLOAD_TIMEOUT_MS / 1000 + ' seconds.'));
    });
    request.on('error', reject);
  });
}

async function installFromUrl(dataDir, url) {
  const target = String(url || '').trim();
  if (!target) throw new Error('url is required to install a font.');
  const buffer = await download(target);
  return installBytes(dataDir, buffer, target);
}

function installFromPath(dataDir, file) {
  const source = String(file || '').trim();
  if (!source) throw new Error('path is required to install a font.');
  if (!path.isAbsolute(source)) {
    throw new Error('Font path must be absolute (or start with ~/).');
  }
  if (!fs.existsSync(source)) throw new Error('No font exists at ' + source + '.');
  if (FONT_EXTENSIONS.indexOf(path.extname(source).toLowerCase()) === -1) {
    throw new Error('Font path must end in .ttf or .otf.');
  }
  return installBytes(dataDir, fs.readFileSync(source), source);
}

module.exports = {
  MAX_FONT_BYTES,
  configPath,
  families,
  fontDir,
  installFromPath,
  installFromUrl,
  list,
  parseFamily,
  prepare,
};
