/*
 * The file layout under MINOTAURIS_EXTENSION_DATA.
 *
 *   document.json        the document, its history and the last export
 *   layers/              one encoded file per raster layer version
 *   snapshots/           before/after pixels owned by history entries
 *   preview.jpg          the last encoded preview
 *
 * Every write goes beside its destination and is renamed into place, so a
 * half-written document or layer can never be loaded. Everything a layer or an
 * entry references is a *relative* path: an absolute path would break the moment
 * the store moved, and the app's data directory does move between builds.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const historyModule = require('./history.cjs');

const DOCUMENT_FILE = 'document.json';
const LAYERS_DIR = 'layers';
const MASKS_DIR = 'masks';
const MODELS_DIR = 'models';
const SELECTIONS_DIR = 'selections';
const SNAPSHOTS_DIR = 'snapshots';
const PREVIEW_FILE = 'preview.jpg';
const REVISIONS_DIR = 'revisions';
const LEGACY_STATE_FILE = 'state.json';
const MAX_REVISION_RENDERS = 40;

function createStore(dataDir) {
  const paths = {
    root: dataDir,
    document: path.join(dataDir, DOCUMENT_FILE),
    layers: path.join(dataDir, LAYERS_DIR),
    masks: path.join(dataDir, MASKS_DIR),
    selections: path.join(dataDir, SELECTIONS_DIR),
    models: path.join(dataDir, MODELS_DIR),
    snapshots: path.join(dataDir, SNAPSHOTS_DIR),
    revisions: path.join(dataDir, REVISIONS_DIR),
    preview: path.join(dataDir, PREVIEW_FILE),
  };

  fs.mkdirSync(paths.layers, { recursive: true });
  fs.mkdirSync(paths.masks, { recursive: true });
  fs.mkdirSync(paths.selections, { recursive: true });
  fs.mkdirSync(paths.models, { recursive: true });
  fs.mkdirSync(paths.snapshots, { recursive: true });
  fs.mkdirSync(paths.revisions, { recursive: true });

  function nonce() {
    return (
      process.pid +
      '-' +
      Date.now().toString(36) +
      '-' +
      crypto.randomBytes(4).toString('hex')
    );
  }

  function writeAtomic(target, data) {
    const temporary = target + '.tmp-' + nonce();
    try {
      fs.writeFileSync(temporary, data);
      fs.renameSync(temporary, target);
    } catch (error) {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      } catch {
        // A stale temp beside a destination is swept on the next boot.
      }
      throw error;
    }
  }

  /** Remove the temporaries a killed process could have left behind. */
  function sweepTemporaries() {
    for (const directory of [
      dataDir,
      paths.layers,
      paths.masks,
      paths.selections,
      paths.snapshots,
      paths.revisions,
    ]) {
      let names = [];
      try {
        names = fs.readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.includes('.tmp-')) continue;
        try {
          fs.unlinkSync(path.join(directory, name));
        } catch {
          // Best effort: it is our own scratch file.
        }
      }
    }
  }

  function absolute(file) {
    return path.join(dataDir, file);
  }

  function exists(file) {
    return Boolean(file) && fs.existsSync(absolute(file));
  }

  function read(file) {
    if (!exists(file)) {
      throw new Error(
        'The document refers to a pixel file that is missing from extension storage (' +
          String(file) +
          '). Nothing was changed.'
      );
    }
    return fs.readFileSync(absolute(file));
  }

  function size(file) {
    try {
      return fs.statSync(absolute(file)).size;
    } catch {
      return 0;
    }
  }

  function writeLayer(layerId, buffer, extension) {
    const file = LAYERS_DIR + '/' + layerId + '-' + nonce() + '.' + (extension || 'png');
    writeAtomic(absolute(file), buffer);
    return file;
  }

  function writeMask(layerId, buffer) {
    const file = MASKS_DIR + '/' + layerId + '-' + nonce() + '.png';
    writeAtomic(absolute(file), buffer);
    return file;
  }

  function writeSelection(id, buffer) {
    const file = SELECTIONS_DIR + '/' + id + '-' + nonce() + '.png';
    writeAtomic(absolute(file), buffer);
    return file;
  }

  function writeSnapshot(entryId, layerId, side, buffer) {
    const file = SNAPSHOTS_DIR + '/' + entryId + '-' + layerId + '-' + side + '.png';
    writeAtomic(absolute(file), buffer);
    return file;
  }

  /**
   * A downscaled render of one revision, used by render_diff. PNG, not JPEG:
   * a difference between two lossily encoded frames is partly an artefact of
   * the encoder, which makes a small real edit look like noise.
   */
  function writeRevisionRender(revision, buffer) {
    const file = REVISIONS_DIR + '/rev-' + String(Math.max(0, Math.round(Number(revision) || 0))).padStart(6, '0') + '.png';
    writeAtomic(absolute(file), buffer);
    return file;
  }

  function revisionFiles() {
    let names = [];
    try {
      names = fs.readdirSync(paths.revisions);
    } catch {
      return [];
    }
    return names
      .map((name) => {
        const match = /^rev-(\d+)\.png$/.exec(name);
        return match ? { name: name, revision: Number(match[1]) } : null;
      })
      .filter(Boolean);
  }

  function readRevisionRender(revision) {
    const target = Math.round(Number(revision));
    if (!Number.isFinite(target)) return null;
    const name = 'rev-' + String(Math.max(0, target)).padStart(6, '0') + '.png';
    const full = path.join(paths.revisions, name);
    return fs.existsSync(full) ? fs.readFileSync(full) : null;
  }

  function collectRevisionRenders() {
    const files = revisionFiles().sort((left, right) => right.revision - left.revision);
    for (const file of files.slice(MAX_REVISION_RENDERS)) {
      remove([REVISIONS_DIR + '/' + file.name]);
    }
  }

  function remove(files) {
    for (const file of files || []) {
      if (!file || path.isAbsolute(file)) continue;
      try {
        const full = absolute(file);
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } catch {
        // Best effort: the next garbage collection retries.
      }
    }
  }

  function saveDocument(document, history, lastExport) {
    writeAtomic(
      paths.document,
      JSON.stringify(
        {
          document: document,
          history: historyModule.serialize(history),
          lastExport: lastExport || null,
          savedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  }

  function loadDocument() {
    if (!fs.existsSync(paths.document)) return null;
    const parsed = JSON.parse(fs.readFileSync(paths.document, 'utf8'));
    if (!parsed || !parsed.document || parsed.document.format !== 'mnphoto-document') return null;
    return {
      document: parsed.document,
      history: historyModule.restore(parsed.history),
      lastExport: parsed.lastExport || null,
    };
  }

  /** The pre-M1 single-image state, for a store written by version 0.2.x. */
  function readLegacyState() {
    const legacy = path.join(dataDir, LEGACY_STATE_FILE);
    if (!fs.existsSync(legacy)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function clearLegacy(currentPath) {
    remove([LEGACY_STATE_FILE]);
    if (typeof currentPath === 'string' && path.isAbsolute(currentPath)) {
      try {
        if (fs.existsSync(currentPath)) fs.unlinkSync(currentPath);
      } catch {
        // It is inside our own storage; a leftover does not affect the document.
      }
    }
  }

  /**
   * Delete layer files and snapshots nothing references any more.
   *
   * Called after every mutation, so an edit's replaced layer file, an evicted
   * entry's snapshots and a redo tail dropped by a new edit all leave with the
   * operation that orphaned them.
   */
  function collectGarbage(document, history) {
    collectRevisionRenders();
    const keep = new Set();
    for (const layer of document.layers) {
      if (layer.pixels && layer.pixels.file) keep.add(layer.pixels.file);
      if (layer.mask && layer.mask.file) keep.add(layer.mask.file);
    }
    if (document.selection && document.selection.maskFile) keep.add(document.selection.maskFile);
    for (const named of Object.values(document.selections || {})) {
      if (named && named.maskFile) keep.add(named.maskFile);
    }
    for (const entry of history.entries || []) {
      for (const file of historyModule.filesFor(entry)) keep.add(file);
    }
    for (const directory of [LAYERS_DIR, MASKS_DIR, SELECTIONS_DIR, SNAPSHOTS_DIR]) {
      let names = [];
      try {
        names = fs.readdirSync(path.join(dataDir, directory));
      } catch {
        continue;
      }
      for (const name of names) {
        const relative = directory + '/' + name;
        if (!keep.has(relative)) remove([relative]);
      }
    }
  }

  function readPreview() {
    try {
      return fs.readFileSync(paths.preview);
    } catch {
      return null;
    }
  }

  function writePreview(buffer) {
    writeAtomic(paths.preview, buffer);
  }

  return {
    paths: paths,
    absolute: absolute,
    clearLegacy: clearLegacy,
    collectGarbage: collectGarbage,
    exists: exists,
    loadDocument: loadDocument,
    read: read,
    readLegacyState: readLegacyState,
    readPreview: readPreview,
    readRevisionRender: readRevisionRender,
    remove: remove,
    revisionFiles: revisionFiles,
    saveDocument: saveDocument,
    size: size,
    sweepTemporaries: sweepTemporaries,
    writeAtomic: writeAtomic,
    writeLayer: writeLayer,
    writeMask: writeMask,
    writePreview: writePreview,
    writeRevisionRender: writeRevisionRender,
    writeSelection: writeSelection,
    writeSnapshot: writeSnapshot,
  };
}

module.exports = {
  DOCUMENT_FILE: DOCUMENT_FILE,
  LAYERS_DIR: LAYERS_DIR,
  LEGACY_STATE_FILE: LEGACY_STATE_FILE,
  MASKS_DIR: MASKS_DIR,
  MAX_REVISION_RENDERS: MAX_REVISION_RENDERS,
  PREVIEW_FILE: PREVIEW_FILE,
  REVISIONS_DIR: REVISIONS_DIR,
  SELECTIONS_DIR: SELECTIONS_DIR,
  SNAPSHOTS_DIR: SNAPSHOTS_DIR,
  createStore: createStore,
};
