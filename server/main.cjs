/*
 * PhotoNext, as an agent capability rather than a human photo app.
 *
 * The process owns a *document*: a layer tree with blend modes, masks and
 * offsets, a selection, an activity log and an op-log history with undo.
 *
 * Tools: `photo_import`, `photo_edit` (geometry), `photo_adjust` (the raster
 * engine, destructive or as an adjustment layer), `photo_draw` (vectors, shapes
 * and baked text), `photo_text` (editable text layers), `photo_select`,
 * `photo_mask`, `photo_layer`, `photo_export`, `photo_history` and `photo_status`.
 *
 * Storage lives only under MINOTAURIS_EXTENSION_DATA (document.json, layers/,
 * masks/, selections/, snapshots/, preview.jpg). The source file handed to
 * `photo_import` is never modified. Export is the only tool that writes outside
 * that directory, which is why it is the only one that asks for approval.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fontsModule = require('./fonts.cjs');
const dataDir = process.env.MINOTAURIS_EXTENSION_DATA || path.join(process.cwd(), 'data');

// fontconfig reads its config once per process. Prepare it before anything that
// loads the bundled libvips, so installed fonts and host fonts share one view.
fontsModule.prepare(dataDir);

const adjustments = require('./adjustments.cjs');
const blendModule = require('./blend.cjs');
const documentModel = require('./document.cjs');
const drawModule = require('./draw.cjs');
const effectsModule = require('./effects.cjs');
const engine = require('./engine.cjs');
const errorsModule = require('./errors.cjs');
const inspect = require('./inspect.cjs');
const fxModule = require('./fx.cjs');
const historyModule = require('./history.cjs');
const lutModule = require('./lut.cjs');
const native3dModule = require('./native3d.cjs');
const text3dModule = require('./text3d.cjs');
const scene3dModule = require('./scene3d.cjs');
const ops = require('./ops.cjs');
const pixels = require('./pixels.cjs');
const pointerModule = require('./pointer.cjs');
const render = require('./render.cjs');
const selection = require('./selection.cjs');
const storeModule = require('./store.cjs');
const stylesModule = require('./styles.cjs');
const textModule = require('./text.cjs');

// The LUT store is a document-side asset like fonts, so it shares the same
// data directory rather than depending on a system install.
lutModule.configure(dataDir);

const PREVIEW_MAX_EDGE = 1400;

// Named output sizes, so an agent asks for `ig_story` instead of guessing.
const EXPORT_PRESETS = {
  ig_post: { width: 1080, height: 1080, label: 'Instagram post' },
  ig_story: { width: 1080, height: 1920, label: 'Instagram story / Reel cover' },
  ig_landscape: { width: 1080, height: 1350, label: 'Instagram portrait post' },
  x_post: { width: 1600, height: 900, label: 'X / Twitter post' },
  linkedin_post: { width: 1200, height: 627, label: 'LinkedIn link card' },
  youtube_thumb: { width: 1280, height: 720, label: 'YouTube thumbnail' },
  hd_1080: { width: 1920, height: 1080, label: 'Full HD' },
  a4_print_300: { width: 2480, height: 3508, dpi: 300, label: 'A4 at 300 DPI' },
  a4_print_150: { width: 1240, height: 1754, dpi: 150, label: 'A4 at 150 DPI' },
  favicon: { width: 512, height: 512, label: 'Favicon source' },
};

function positiveInt(raw, fallback) {
  const value = Math.round(Number(raw));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const historySettings = {
  budgetBytes: positiveInt(
    process.env.PHOTONEXT_HISTORY_BUDGET_BYTES,
    historyModule.DEFAULT_BUDGET_BYTES
  ),
  maxEntries: positiveInt(
    process.env.PHOTONEXT_HISTORY_MAX_ENTRIES,
    historyModule.DEFAULT_MAX_ENTRIES
  ),
};

function log(level, message) {
  process.stderr.write('[photonext:' + level + '] ' + message + '\n');
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let store = null;
let document = documentModel.emptyDocument();
let history = historyModule.createHistory(historySettings);
let lastExport = null;
let startupError = null;
let previewDataUrl = null;
let previewError = null;
let histogramCache = null;
let visualsRevision = -1;
let activePointer = null;
let pointerSerial = 0;
// A recipe stamps every entry it creates so the whole plan is one undo step.
let currentGroupId = null;
// Retried tool calls return the first answer instead of editing twice.
const opCache = new Map();
const OP_CACHE_LIMIT = 60;
const native3d = native3dModule.createNative3d(dataDir);
const fx = fxModule.createFx(dataDir);

function migrateLegacy() {
  const legacy = store.readLegacyState();
  const current = legacy && legacy.current;
  if (!current || typeof current.path !== 'string' || !fs.existsSync(current.path)) return false;

  const bytes = fs.readFileSync(current.path);
  const extension = ops.imageExtension(current.path) || 'png';
  const file = store.writeLayer(
    documentModel.newId('layer'),
    bytes,
    extension === 'jpeg' ? 'jpg' : extension
  );
  document = documentModel.fromImport({
    file: file,
    width: current.width,
    height: current.height,
    name: legacy.sourceName || path.basename(current.path),
    format: current.format || ops.formatForExtension(extension) || 'png',
  });
  history = historyModule.createHistory(historySettings);
  store.saveDocument(document, history, null);
  store.clearLegacy(current.path);
  log('info', 'Migrated the pre-M1 working image into a document.');
  return true;
}

try {
  store = storeModule.createStore(dataDir);
  store.sweepTemporaries();
  const loaded = store.loadDocument();
  if (loaded) {
    document = loaded.document;
    if (!document.selections) document.selections = {};
    if (!document.scene) document.scene = null;
    history = loaded.history;
    lastExport = loaded.lastExport;
  } else {
    migrateLegacy();
  }
  store.collectGarbage(document, history);
} catch (error) {
  startupError = messageOf(error);
  log('error', 'startup failed: ' + startupError);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHome(value) {
  const home = (() => {
    try {
      return os.userInfo().homedir;
    } catch {
      return os.homedir();
    }
  })();
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function requireAbsolutePath(value, label) {
  const expanded = expandHome(String(value || '').trim());
  if (!expanded) throw new Error(label + ' is required.');
  if (!path.isAbsolute(expanded)) {
    throw new Error(
      label +
        ' must be an absolute path (or start with ~/). This process runs inside the ' +
        'extension, not in the task workspace, so a relative path would point at the wrong place.'
    );
  }
  return expanded;
}

function requireStore() {
  if (!store) {
    throw new Error(
      'PhotoNext could not open its extension storage' +
        (startupError ? ': ' + startupError : '') +
        '. Nothing was changed.'
    );
  }
  return store;
}

function requireDocument() {
  requireStore();
  if (!document.layers.length) {
    throw new Error('No image is loaded. Call photo_import first.');
  }
  return document;
}

function activeLayerOrThrow() {
  const layer = documentModel.activeLayer(document);
  if (!layer || layer.kind !== 'raster' || !layer.pixels) {
    throw new Error('The document has no raster layer to edit. Call photo_import first.');
  }
  if (layer.locked) {
    throw new Error(
      'Layer "' + layer.name + '" is locked; unlock it before editing. Nothing was changed.'
    );
  }
  return layer;
}

/** Document-space frame: groups report the union of their descendants. */
function frameOf(layer) {
  return documentModel.frameOf(document, layer);
}

function resolveLayer(value) {
  if (value === undefined || value === null || value === 'active') {
    const layer = documentModel.activeLayer(document);
    if (!layer) throw new Error('The document has no layer. Call photo_import first.');
    return layer;
  }
  const layer = documentModel.layerById(document, String(value));
  if (!layer) {
    const candidates = inspect
      .rankLayers(inspect.snapshotLayers(document), String(value))
      .slice(0, 5);
    throw errorsModule.photoError(
      'NOT_FOUND',
      'No layer with id "' +
        value +
        '". photo_status or photo_find lists the layer ids. Nothing was changed.',
      {
        field: 'target.layer',
        received: String(value),
        candidates: candidates,
        retryable: false,
        suggested_call: {
          tool: 'photo_find',
          arguments: { query: String(value), limit: 5 },
        },
      }
    );
  }
  return layer;
}

/** Resolve one layer, several ids, "all" or "active" for the inspection tools. */
function textLayers() {
  return document.layers.filter((layer) => layer.kind === 'text');
}

function resolveTextLayer(value) {
  const layer = resolveLayer(value);
  if (layer.kind !== 'text') {
    throw errorsModule.photoError(
      'INVALID_ARGUMENT',
      'Layer "' +
        layer.name +
        '" is a ' +
        layer.kind +
        ' layer, not a text layer. photo_text edits editable type; use photo_layer for raster, adjustment or group layers. Nothing was changed.',
      {
        field: 'target.layer',
        received: layer.name,
        candidates: textLayers().map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          content: candidate.text.content,
        })),
        suggested_call: { tool: 'photo_text', arguments: { action: 'list' } },
      }
    );
  }
  return layer;
}

function textTargetError(error) {
  const field = error && error.field ? error.field : 'content';
  const message = messageOf(error);
  return errorsModule.photoError(
    'INVALID_ARGUMENT',
    /nothing was changed/i.test(message) ? message : message + ' Nothing was changed.',
    {
      field: field,
      min: error && error.min,
      max: error && error.max,
      limit: error && error.limit,
      received: error && error.received,
      suggested_call: {
        tool: 'photo_text',
        arguments: { action: 'list' },
      },
    }
  );
}

function defaultTextName(text) {
  const first = String(text.content).split(/\r?\n/)[0].trim();
  return first.length > 40 ? first.slice(0, 39) + '…' : first || 'Text';
}

function resolveLayerList(value, options) {
  const settings = options || {};
  const pick = (layer) => {
    if (!layer) return null;
    if (settings.rasterOnly && layer.kind !== 'raster') return null;
    return layer;
  };
  if (value === 'all' || (Array.isArray(value) && value.length === 1 && value[0] === 'all')) {
    const pool = settings.topLevel ? documentModel.topLevelLayers(document) : document.layers;
    return pool.map(pick).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((id) => pick(resolveLayer(id))).filter(Boolean);
  }
  return [pick(resolveLayer(value))].filter(Boolean);
}

/** A layer description at the requested level of detail. */
function describeLayer(layer, index, detail) {
  const frame = frameOf(layer);
  const base = {
    id: layer.id,
    name: layer.name,
    kind: layer.kind,
    index: index,
    parentId: layer.parentId || null,
    depth: documentModel.depthOf(document, layer),
    visible: layer.visible !== false,
    locked: layer.locked === true,
    opacity: layer.opacity === undefined ? 1 : layer.opacity,
    blendMode: layer.blendMode || 'normal',
    active: layer.id === document.activeLayerId,
    frame: frame,
    bbox_norm: inspect.normBox(frame, document.canvas),
    styleCount: (layer.styles || []).filter((style) => style.enabled !== false).length,
  };
  if (layer.kind === 'text' && layer.text) {
    base.text = Object.assign(textModule.describe(layer.text), {
      transform: {
        x: Math.round(Number(layer.offset && layer.offset.x) || 0),
        y: Math.round(Number(layer.offset && layer.offset.y) || 0),
        rotation: layer.text.rotation,
        scale: layer.text.scale,
      },
    });
  }
  if (detail === 'summary') return base;
  base.mask = layer.mask && layer.mask.file ? { inverted: layer.mask.inverted === true, feather: layer.mask.feather || 0 } : null;
  base.styles = (layer.styles || []).map(stylesModule.describeStyle);
  base.summary = layer.summary || null;
  if (layer.kind === 'adjustment') base.adjustments = (layer.adjustments || []).map((entry) => entry.type);
  if (layer.kind === 'group') base.children = documentModel.groupMembers(document, layer.id).length;
  if (detail !== 'full') return base;
  base.offset = { x: frame.x, y: frame.y };
  base.pixels = layer.pixels
    ? { width: layer.pixels.width, height: layer.pixels.height, format: layer.pixels.format }
    : null;
  base.rawOffset = layer.offset || { x: 0, y: 0 };
  return base;
}

/** Ink bounds for a raster or text layer, in both layer and document space. */
async function inkBoundsOf(layer) {
  if (!layer) return null;
  let raw;
  if (layer.kind === 'text' && layer.text) {
    raw = (await engine.renderTextLayer(layer, flattenOptions())).raw;
  } else if (layer.kind === 'raster' && layer.pixels && store.exists(layer.pixels.file)) {
    raw = await engine.decode(store.read(layer.pixels.file));
  } else {
    return null;
  }
  const ink = inspect.alphaBounds(raw);
  if (ink.empty) return { layer: ink, doc: null, empty: true };
  const offset = frameOf(layer);
  return {
    layer: { x: ink.x, y: ink.y, width: ink.width, height: ink.height, coverage: ink.coverage },
    doc: {
      x: offset.x + ink.x,
      y: offset.y + ink.y,
      width: ink.width,
      height: ink.height,
    },
    empty: false,
  };
}

/** Union of a group's raster descendants' ink, in document space. */
async function groupInkBounds(group) {
  const boxes = [];
  let coverage = 0;
  for (const member of documentModel.descendantsOf(document, group.id)) {
    if (member.kind !== 'raster' && member.kind !== 'text') continue;
    const ink = await inkBoundsOf(member);
    if (ink && ink.doc) {
      boxes.push(ink.doc);
      coverage = Math.max(coverage, ink.layer.coverage || 0);
    }
  }
  const union = inspect.unionBoxes(boxes);
  if (!union) return { empty: true };
  return Object.assign({}, union, { empty: false, coverage: coverage });
}

function flattenOptions() {
  return {
    fontDir: fontsModule.fontDir(dataDir),
    customFonts: fontsModule.families(dataDir),
  };
}

async function flattenedRaw() {
  requireDocument();
  return engine.flattenDocument(document, store, flattenOptions());
}

/** Decode the render cached for a revision, if that revision is still kept. */
async function renderAtRevision(revision) {
  const buffer = store.readRevisionRender(revision);
  if (!buffer) return null;
  return engine.decode(buffer);
}

function encodableFormat(format) {
  return ['png', 'jpeg', 'webp', 'tiff', 'gif'].indexOf(format) === -1 ? 'png' : format;
}

async function refreshVisuals(force) {
  if (!store) return null;
  if (!document.layers.length) {
    previewDataUrl = null;
    previewError = null;
    histogramCache = null;
    visualsRevision = document.revision;
    return null;
  }
  if (!force && visualsRevision === document.revision) return previewError;
  try {
    const flattened = await engine.flattenDocument(document, store, flattenOptions());
    histogramCache = flattened.histogram;
    previewDataUrl = await render.preview(flattened.buffer, PREVIEW_MAX_EDGE);
    store.writePreview(Buffer.from(previewDataUrl.split(',')[1], 'base64'));
    // Keep a lossless downscaled frame per revision so render_diff compares
    // pixels, not two independently encoded JPEGs.
    if (!store.readRevisionRender(document.revision)) {
      try {
        store.writeRevisionRender(
          document.revision,
          await render.thumbnail(flattened.buffer, PREVIEW_MAX_EDGE)
        );
      } catch {
        // A diff baseline is an optimization; never fail an edit for it.
      }
    }
    previewError = null;
  } catch (error) {
    previewDataUrl = null;
    histogramCache = null;
    previewError = messageOf(error);
  }
  visualsRevision = document.revision;
  return previewError;
}

function persist() {
  requireStore().saveDocument(document, history, lastExport);
}

async function statusPayload(includePreview) {
  if (!store) {
    return {
      loaded: false,
      revision: 0,
      layers: [],
      history: [],
      historyState: null,
      capabilities: render.capabilities(),
      fonts: fontsModule.list(dataDir),
      budgets: documentModel.LIMITS,
      storageError: startupError,
    };
  }

  await refreshVisuals(false);
  const layer = documentModel.activeLayer(document);
  const pixelLayer =
    layer && layer.pixels
      ? layer
      : document.layers.find((candidate) => candidate.kind === 'raster' && candidate.pixels) || null;
  const loaded = document.layers.length > 0;
  const payload = {
    loaded: loaded,
    revision: document.revision,
    documentId: document.id,
    canvas: document.canvas,
    sourceName: document.metadata.sourceName,
    fileName: pixelLayer ? path.basename(pixelLayer.pixels.file) : null,
    width: pixelLayer ? pixelLayer.pixels.width : document.canvas.width,
    height: pixelLayer ? pixelLayer.pixels.height : document.canvas.height,
    format: pixelLayer ? pixelLayer.pixels.format : null,
    bytes: pixelLayer ? store.size(pixelLayer.pixels.file) : 0,
    layers: documentModel.layerTree(document),
    activeLayerId: document.activeLayerId,
    selection: document.selection
      ? {
          kind: document.selection.kind,
          summary: document.selection.summary,
          bounds: document.selection.bounds,
          feather: document.selection.feather || 0,
        }
      : null,
    savedSelections: Object.keys(document.selections || {}),
    fonts: fontsModule.list(dataDir),
    histogram: histogramCache,
    history: document.activity.slice(-8),
    historyState: {
      applied: history.cursor,
      total: history.entries.length,
      canUndo: historyModule.canUndo(history),
      canRedo: historyModule.canRedo(history),
      bytes: history.bytes,
      budgetBytes: history.budgetBytes,
      maxEntries: history.maxEntries,
      entries: historyModule.entriesView(history),
    },
    lastExport: lastExport,
    activePointer: activePointer || null,
    updatedAt: document.updatedAt,
    scene3d: scene3dModule.publicScene(document.scene),
    capabilities: Object.assign({}, render.capabilities(), {
      adjustments: adjustments.TYPES,
      blendModes: blendModule.BLEND_MODES,
      threeD: native3d.status(),
      effects: effectsModule.TYPES,
      text3d: fx.status(),
    }),
    // The sidebar renders this as its tool rail and tool inspector, so the
    // panel's idea of the surface and the model's are the same list — not two
    // catalogs that drift. Read only; calling them is what the tools are for.
    tools: TOOLS.map(function (tool) {
      return {
        name: tool.name,
        readOnly: tool.readOnly === true,
        requiresApproval: tool.requiresApproval === true,
      };
    }),
    budgets: documentModel.LIMITS,
  };
  if (includePreview) {
    if (!previewDataUrl) await refreshVisuals(true);
    payload.preview = previewDataUrl || null;
    if (previewError) payload.previewError = previewError;
  }
  return payload;
}

function textFor(payload) {
  if (!payload.loaded) return 'No image is loaded. Import one with photo_import.';
  const parts = [
    payload.fileName + ' · ' + payload.width + ' × ' + payload.height + ' · ' + payload.format,
    payload.bytes + ' bytes',
  ];
  if (payload.layers.length > 1) parts.push(payload.layers.length + ' layers');
  if (payload.selection) parts.push('selection: ' + payload.selection.summary);
  const latest =
    payload.history && payload.history.length
      ? payload.history[payload.history.length - 1]
      : null;
  if (latest) parts.push(latest.summary);
  return parts.join(' · ');
}

function toolResult(payload, text, extra) {
  return {
    content: [{ type: 'text', text: text || textFor(payload) }],
    structuredContent: Object.assign({}, payload, extra || {}),
  };
}

// ---------------------------------------------------------------------------
// Selections and masks
// ---------------------------------------------------------------------------

async function selectionMaskFor(entry) {
  return engine.decodeMask(store.read(entry.maskFile), document.canvas.width, document.canvas.height);
}

async function layerMaskFor(layer) {
  const mask = await engine.decodeMask(
    store.read(layer.mask.file),
    document.canvas.width,
    document.canvas.height
  );
  return layer.mask.inverted ? selection.invertMask(mask) : mask;
}

async function writeSelectionEntry(kind, summary, mask, extra) {
  const width = document.canvas.width;
  const height = document.canvas.height;
  const file = store.writeSelection(
    documentModel.newId('sel'),
    await engine.encodeMask(mask, width, height)
  );
  return Object.assign(
    {
      id: documentModel.newId('sel'),
      kind: kind,
      summary: summary,
      width: width,
      height: height,
      bounds: selection.maskBounds(mask, width, height),
      maskFile: file,
    },
    extra || {}
  );
}

async function writeLayerMaskEntry(layer, mask, feather) {
  const width = document.canvas.width;
  const height = document.canvas.height;
  const file = store.writeMask(layer.id, await engine.encodeMask(mask, width, height));
  return { file: file, width: width, height: height, feather: feather || 0, inverted: false };
}

/** Combine the requested scopes into one canvas-sized coverage mask. */
async function scopedMask(target, layer) {
  let mask = null;
  if (target.selection) {
    if (!document.selection) {
      throw new Error(
        'target.selection is set but there is no active selection. Create one with photo_select. Nothing was changed.'
      );
    }
    mask = await selectionMaskFor(document.selection);
  }
  if (target.mask) {
    if (!layer.mask || !layer.mask.file) {
      throw new Error(
        'target.mask is set but layer "' + layer.name + '" has no mask. Create one with photo_mask. Nothing was changed.'
      );
    }
    const layerMask = await layerMaskFor(layer);
    mask = mask ? selection.multiplyMasks(mask, layerMask) : layerMask;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// History commits
// ---------------------------------------------------------------------------

function pushEntry(entry, tool, summary) {
  if (currentGroupId) entry.groupId = currentGroupId;
  entry.revisionBefore = document.revision;
  historyModule.record(history, entry);
  documentModel.recordActivity(document, tool, summary);
  entry.revisionAfter = document.revision;
  persist();
  store.collectGarbage(document, history);
}

function baseEntry(tool, summary, changes, bytes) {
  return {
    id: documentModel.newId('entry'),
    at: documentModel.isoNow(),
    tool: tool,
    summary: summary,
    changes: changes,
    canvas: {
      before: { width: document.canvas.width, height: document.canvas.height },
      after: { width: document.canvas.width, height: document.canvas.height },
    },
    bytes: bytes || 0,
  };
}

function commitPixelChanges(items, summary, tool) {
  const entryId = documentModel.newId('entry');
  const changes = [];
  const previousCanvas = { width: document.canvas.width, height: document.canvas.height };
  let bytes = 0;

  for (const item of items) {
    const layer = item.layer;
    const applied = item.applied;
    const before = store.read(layer.pixels.file);
    const beforeFile = store.writeSnapshot(entryId, layer.id, 'before', before);
    const afterFile = store.writeSnapshot(entryId, layer.id, 'after', applied.buffer);
    const layerFile = store.writeLayer(
      layer.id,
      applied.buffer,
      render.outputExtension(encodableFormat(applied.format))
    );
    bytes += store.size(beforeFile) + store.size(afterFile);
    const previousPixels = layer.pixels;
    changes.push({
      kind: 'pixels',
      layerId: layer.id,
      before: {
        file: beforeFile,
        width: previousPixels.width,
        height: previousPixels.height,
        format: encodableFormat(previousPixels.format),
      },
      after: {
        file: afterFile,
        width: applied.width,
        height: applied.height,
        format: encodableFormat(applied.format),
      },
    });
    layer.pixels = {
      file: layerFile,
      width: applied.width,
      height: applied.height,
      format: encodableFormat(applied.format),
    };
  }

  if (document.layers.length === 1 && items.length) {
    const first = items[0].layer.pixels;
    document.canvas = { width: first.width, height: first.height };
  }

  const entry = {
    id: entryId,
    at: documentModel.isoNow(),
    tool: tool,
    summary: summary,
    changes: changes,
    canvas: {
      before: previousCanvas,
      after: { width: document.canvas.width, height: document.canvas.height },
    },
    bytes: bytes,
  };
  pushEntry(entry, tool, summary);
  return entry;
}

function commitAdjustmentLayer(layer, summary) {
  documentModel.addLayer(document, layer);
  const change = {
    kind: 'layerAdded',
    layerId: layer.id,
    index: document.layers.length - 1,
    before: null,
    after: clone(layer),
    files: [],
  };
  pushEntry(baseEntry('photo_adjust', summary, [change]), 'photo_adjust', summary);
  return layer;
}

function commitAdjustmentSpec(layer, beforeStack, beforeSummary, stack, summary) {
  layer.adjustments = stack;
  layer.summary = summary;
  const change = {
    kind: 'spec',
    layerId: layer.id,
    before: { spec: clone(beforeStack), summary: beforeSummary || null },
    after: { spec: clone(stack), summary: summary },
  };
  pushEntry(baseEntry('photo_adjust', summary, [change]), 'photo_adjust', summary);
}

function commitSelection(before, after, summary) {
  document.selection = after ? clone(after) : null;
  const change = {
    kind: 'selection',
    before: { selection: clone(before || null), file: before ? before.maskFile : null },
    after: { selection: clone(after || null), file: after ? after.maskFile : null },
  };
  pushEntry(baseEntry('photo_select', summary, [change]), 'photo_select', summary);
}

function commitStyles(layer, beforeStyles, afterStyles, summary, options) {
  layer.styles = clone(afterStyles);

  // Adding a style and then dialling in its first parameter is one intent, so
  // it is one undo step. Only the immediately preceding style add qualifies and
  // only once; a later edit is a separate history entry.
  const settings = options || {};
  if (settings.coalesceStyleId && history.cursor === history.entries.length) {
    const last = history.entries[history.entries.length - 1];
    const change =
      last &&
      last.tool === 'photo_style' &&
      !last.styleAddMerged &&
      (last.changes || []).find((item) => item.kind === 'styles' && item.layerId === layer.id);
    if (change) {
      const beforeIds = (change.before.styles || []).map((style) => style.id);
      const afterIds = (change.after.styles || []).map((style) => style.id);
      if (beforeIds.indexOf(settings.coalesceStyleId) === -1 && afterIds.indexOf(settings.coalesceStyleId) !== -1) {
        change.after.styles = clone(afterStyles);
        last.summary = summary;
        last.styleAddMerged = true;
        documentModel.recordActivity(document, 'photo_style', summary);
        last.revisionAfter = document.revision;
        persist();
        store.collectGarbage(document, history);
        return;
      }
    }
  }

  const change = {
    kind: 'styles',
    layerId: layer.id,
    before: { styles: clone(beforeStyles) },
    after: { styles: clone(afterStyles) },
  };
  pushEntry(baseEntry('photo_style', summary, [change]), 'photo_style', summary);
}

function commitTextAdded(layer, summary) {
  documentModel.addLayer(document, layer);
  const change = {
    kind: 'layerAdded',
    layerId: layer.id,
    index: document.layers.length - 1,
    before: null,
    after: clone(layer),
    files: [],
  };
  pushEntry(baseEntry('photo_text', summary, [change]), 'photo_text', summary);
  return layer;
}

/**
 * Store an edited text record. The first edit immediately after a create folds
 * into that create entry, so creating a headline and then typing its size is
 * one undo step; undo removes the whole layer, redo restores the final record.
 */
function commitText(layer, before, after, summary) {
  const change = {
    kind: 'text',
    layerId: layer.id,
    before: clone(before),
    after: clone(after),
  };
  layer.text = clone(after.text);
  layer.offset = clone(after.offset);
  layer.name = after.name;

  if (history.cursor === history.entries.length) {
    const last = history.entries[history.entries.length - 1];
    const added =
      last &&
      last.tool === 'photo_text' &&
      !last.textEditMerged &&
      (last.changes || []).length === 1 &&
      last.changes[0].kind === 'layerAdded' &&
      last.changes[0].layerId === layer.id;
    if (added) {
      last.changes[0].after = clone(layer);
      last.summary = summary;
      last.textEditMerged = true;
      documentModel.recordActivity(document, 'photo_text', summary);
      last.revisionAfter = document.revision;
      persist();
      store.collectGarbage(document, history);
      return;
    }
  }
  pushEntry(baseEntry('photo_text', summary, [change]), 'photo_text', summary);
}

function commitMask(layer, beforeMask, afterMask, summary, tool) {
  layer.mask = afterMask ? clone(afterMask) : null;
  const change = {
    kind: 'mask',
    layerId: layer.id,
    before: { mask: clone(beforeMask || null), file: beforeMask ? beforeMask.file : null },
    after: { mask: clone(afterMask || null), file: afterMask ? afterMask.file : null },
  };
  pushEntry(baseEntry(tool || 'photo_mask', summary, [change]), tool || 'photo_mask', summary);
}

function commitLayerProps(layer, beforeProps, afterProps, summary) {
  Object.assign(layer, clone(afterProps));
  const change = {
    kind: 'layerProps',
    layerId: layer.id,
    before: { props: clone(beforeProps) },
    after: { props: clone(afterProps) },
  };
  pushEntry(baseEntry('photo_layer', summary, [change]), 'photo_layer', summary);
}

/** Several layers moved by one intent (align, distribute) are one undo step. */
function commitLayerPropsMany(items, summary, tool) {
  const changes = [];
  for (const item of items) {
    Object.assign(item.layer, clone(item.after));
    changes.push({
      kind: 'layerProps',
      layerId: item.layer.id,
      before: { props: clone(item.before) },
      after: { props: clone(item.after) },
    });
  }
  documentModel.bumpRevision(document);
  pushEntry(baseEntry(tool || 'photo_layout', summary, changes), tool || 'photo_layout', summary);
}

/** Undo every applied entry stamped with a recipe group id. */
async function undoTillOutOfGroup(groupId) {
  let moved = 0;
  while (history.cursor > 0) {
    const entry = history.entries[history.cursor - 1];
    if (!entry || entry.groupId !== groupId) break;
    entryState(entry, 'undo');
    historyModule.undo(history);
    await applyHistoryEntry(entry, 'undo');
    moved += 1;
  }
  return moved;
}

function commitLayerOrder(beforeIds, afterIds, summary) {
  document.layers = afterIds
    .map((id) => documentModel.layerById(document, id))
    .filter((layer) => Boolean(layer));
  const change = { kind: 'layerOrder', before: { order: beforeIds }, after: { order: afterIds } };
  pushEntry(baseEntry('photo_layer', summary, [change]), 'photo_layer', summary);
}

function commitLayerRemoved(layer, index, summary) {
  const change = {
    kind: 'layerRemoved',
    layerId: layer.id,
    index: index,
    layer: clone(layer),
    files: [
      layer.pixels && layer.pixels.file,
      layer.mask && layer.mask.file,
    ].filter(Boolean),
  };
  documentModel.removeLayer(document, layer.id);
  pushEntry(baseEntry('photo_layer', summary, [change]), 'photo_layer', summary);
}

function commitLayerAdded(layer, index, summary, tool) {
  const entryTool = tool || 'photo_layer';
  document.layers.splice(Math.max(0, Math.min(document.layers.length, index)), 0, layer);
  document.activeLayerId = layer.id;
  documentModel.bumpRevision(document);
  const change = {
    kind: 'layerAdded',
    layerId: layer.id,
    index: index,
    before: null,
    after: clone(layer),
    files: [
      layer.pixels && layer.pixels.file,
      layer.mask && layer.mask.file,
    ].filter(Boolean),
  };
  pushEntry(baseEntry(entryTool, summary, [change]), entryTool, summary);
}

function entryState(entry, direction) {
  for (const change of entry.changes || []) {
    if (
      change.kind === 'layerAdded' ||
      change.kind === 'spec' ||
      change.kind === 'layerProps' ||
      change.kind === 'layerOrder'
    ) {
      continue;
    }
    const state = direction === 'undo' ? change.before : change.after;
    if (state && state.file && !store.exists(state.file)) {
      throw new Error(
        'The ' +
          direction +
          ' snapshot for "' +
          entry.summary +
          '" is missing from extension storage, so that step cannot be replayed. Nothing was changed.'
      );
    }
  }
}

function insertLayer(layer, index) {
  const target = Math.max(0, Math.min(document.layers.length, Math.round(Number(index)) || 0));
  document.layers.splice(target, 0, layer);
  document.activeLayerId = layer.id;
}

async function applyHistoryEntry(entry, direction) {
  const changes = direction === 'undo' ? (entry.changes || []).slice().reverse() : entry.changes || [];
  const deferred = [];
  for (const change of changes) {
    const state = direction === 'undo' ? change.before : change.after;
    if (change.kind === 'layerAdded') {
      if (direction === 'undo') {
        documentModel.removeLayer(document, change.layerId);
      } else if (change.after && !documentModel.layerById(document, change.layerId)) {
        insertLayer(clone(change.after), change.index);
      }
      continue;
    }
    if (change.kind === 'layerRemoved') {
      if (direction === 'undo' && change.layer) deferred.push(change);
      else documentModel.removeLayer(document, change.layerId);
      continue;
    }
    if (change.kind === 'layerOrder') {
      const order = (state && state.order) || [];
      document.layers = order
        .map((id) => documentModel.layerById(document, id))
        .filter((layer) => Boolean(layer));
      continue;
    }
    if (change.kind === 'selection') {
      document.selection = state && state.selection ? clone(state.selection) : null;
      continue;
    }
    const layer = documentModel.layerById(document, change.layerId);
    if (!layer) continue;
    if (change.kind === 'spec') {
      layer.adjustments = clone((state && state.spec) || []);
      layer.summary = (state && state.summary) || null;
      continue;
    }
    if (change.kind === 'layerProps') {
      Object.assign(layer, clone((state && state.props) || {}));
      continue;
    }
    if (change.kind === 'mask') {
      layer.mask = state && state.mask ? clone(state.mask) : null;
      continue;
    }
    if (change.kind === 'styles') {
      layer.styles = state && Array.isArray(state.styles) ? clone(state.styles) : [];
      continue;
    }
    if (change.kind === 'text') {
      layer.text = state && state.text ? clone(state.text) : layer.text;
      if (state && state.offset) layer.offset = clone(state.offset);
      if (state && state.name !== undefined) layer.name = state.name;
      continue;
    }
    if (!state || !state.file) continue;
    const bytes = store.read(state.file);
    const file = store.writeLayer(
      layer.id,
      bytes,
      render.outputExtension(encodableFormat(state.format))
    );
    layer.pixels = {
      file: file,
      width: state.width,
      height: state.height,
      format: encodableFormat(state.format),
    };
  }
  // Undo re-inserts removed layers bottom-up, so their recorded indexes stay valid.
  deferred
    .slice()
    .sort((left, right) => (left.index || 0) - (right.index || 0))
    .forEach((change) => insertLayer(clone(change.layer), change.index));

  const canvas = direction === 'undo' ? entry.canvas.before : entry.canvas.after;
  if (canvas && canvas.width && canvas.height) {
    document.canvas = { width: canvas.width, height: canvas.height };
  }
  documentModel.recordActivity(
    document,
    'photo_history',
    (direction === 'undo' ? 'Undid ' : 'Redid ') + entry.summary
  );
  // Entry revision stamps stay immutable. A state keeps the revision that
  // first produced it, so an undo_to target captured earlier still names the
  // same state after a detour through undo and redo. `baseRevision` names the
  // empty state when every entry has been undone.
  if (history.cursor <= 0) history.baseRevision = 0;
  persist();
  store.collectGarbage(document, history);
  await refreshVisuals(true);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'photo_import',
    description:
      'Import an image from an absolute path as a new document (one raster layer). Accepts PNG, JPEG, TIFF, GIF, HEIC and WebP. The source file is copied, never modified. Returns the image size, layer tree and histogram; the PhotoNext panel updates to show it. Use this before photo_edit or photo_adjust.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path of the image to import (a leading ~/ is expanded). Chat attachments and workspace files both arrive as paths.',
        },
      },
      required: ['path'],
    },
    async run(args) {
      requireStore();
      render.requireBackend();
      const source = requireAbsolutePath(args.path, 'path');
      if (!fs.existsSync(source)) throw new Error('No file exists at ' + source + '.');
      if (!fs.statSync(source).isFile()) throw new Error(source + ' is not a file.');
      const extension = ops.imageExtension(source);
      if (!extension) {
        throw new Error(
          'Unsupported image type for ' +
            source +
            '. Use one of: PNG, JPEG, TIFF, GIF, HEIC, WebP.'
        );
      }

      const originalBytes = fs.readFileSync(source);
      // Bake EXIF orientation before any size, crop or offset is computed. A
      // sideways phone photo is otherwise cropped in the wrong space.
      const rotated = await render.autorotate(originalBytes);
      const bytes = rotated ? rotated.buffer : originalBytes;
      const image = await render.readImage(bytes);
      const size = documentModel.assertCanvas(image.width, image.height);
      const storedExtension = rotated
        ? render.outputExtension(rotated.format)
        : extension === 'jpeg'
          ? 'jpg'
          : extension;
      const file = store.writeLayer(documentModel.newId('layer'), bytes, storedExtension);

      document = documentModel.fromImport({
        file: file,
        width: size.width,
        height: size.height,
        name: path.basename(source),
        format: ops.formatForExtension(storedExtension) || image.format,
      });
      history = historyModule.createHistory(historySettings);
      lastExport = null;
      documentModel.recordActivity(
        document,
        'photo_import',
        'Imported ' +
          path.basename(source) +
          ' at ' +
          size.width +
          '×' +
          size.height +
          (rotated ? ' · EXIF orientation ' + rotated.orientation + ' baked in' : '')
      );
      persist();
      store.collectGarbage(document, history);
      const previewFailure = await refreshVisuals(true);

      const payload = await statusPayload(false);
      if (previewFailure) payload.previewError = previewFailure;
      if (rotated) payload.orientationApplied = rotated.orientation;
      return toolResult(payload);
    },
  },
  {
    name: 'photo_edit',
    description:
      'Transform the active raster layer. Operations run in a fixed order: rotate, flip, skew, perspective, crop, resize, canvas, trim. Rotate takes any clockwise angle; 90/180/270 stay exact quarter turns, and an arbitrary angle expands the canvas unless rotateFit is "crop". Crop coordinates are pixels in the rotated image, so (0,0) is its top-left. Resize supports fit modes (stretch, fit, fill, pad). Each call is one undoable history entry; use photo_history to undo or redo.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        rotate: {
          type: 'number',
          description: 'Clockwise rotation in degrees (any angle; 90/180/270 are exact quarter turns).',
        },
        rotateFit: {
          type: 'string',
          enum: ['expand', 'crop'],
          description: 'For an arbitrary angle: expand the canvas (default) or crop back to the original size.',
        },
        flip: {
          type: 'string',
          enum: ['horizontal', 'vertical'],
          description: 'Mirror the image on this axis.',
        },
        skew: {
          type: 'object',
          description: 'Shear the image by degrees on each axis (±60).',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
        perspective: {
          type: 'object',
          description:
            'Quad→quad perspective: the four corners of the current image, moved to where they should land. Array order is topLeft, topRight, bottomRight, bottomLeft.',
          properties: {
            corners: {
              type: 'array',
              description: 'Four [x, y] points in output space.',
              items: { type: 'array', items: { type: 'number' } },
            },
            width: { type: 'number' },
            height: { type: 'number' },
            sampler: { type: 'string', enum: ['bilinear', 'nearest'] },
          },
        },
        crop: {
          type: 'object',
          description: 'Rectangle to keep, in pixels of the transformed image.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        resize: {
          type: 'object',
          description: 'Output dimensions and how to fit them: stretch (default), fit, fill, pad.',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            fit: { type: 'string', enum: ['stretch', 'fit', 'fill', 'pad'] },
            anchor: { type: 'string' },
            background: { type: 'string' },
          },
        },
        canvas: {
          type: 'object',
          description: 'Resize the canvas with a 9-point anchor; content is cropped or padded.',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            anchor: {
              type: 'string',
              enum: [
                'top-left',
                'top',
                'top-right',
                'left',
                'center',
                'right',
                'bottom-left',
                'bottom',
                'bottom-right',
              ],
            },
            background: { type: 'string', description: '"transparent" or a hex colour.' },
          },
        },
        trim: {
          type: 'object',
          description: 'Trim a uniform or transparent border.',
          properties: {
            tolerance: { type: 'number' },
            trimTransparent: { type: 'boolean' },
          },
        },
        sampler: { type: 'string', enum: ['bilinear', 'nearest'] },
        format: {
          type: 'string',
          enum: ['png', 'jpeg'],
          description: 'Convert the working layer to this format. Omit to keep its current format.',
        },
      },
    },
    async run(args) {
      requireDocument();
      const layer = activeLayerOrThrow();
      const plan = ops.planEdit(args, {
        width: layer.pixels.width,
        height: layer.pixels.height,
      });
      if (!plan.operations.length && !plan.format) {
        throw new Error(
          'Nothing to do: pass at least one of rotate, flip, skew, perspective, crop, resize, canvas or trim.'
        );
      }

      const before = store.read(layer.pixels.file);
      const applied = await engine.applyEditPlan(before, plan, {
        format: encodableFormat(layer.pixels.format),
      });

      commitPixelChanges([{ layer: layer, applied: applied }], plan.summary, 'photo_edit');
      const previewFailure = await refreshVisuals(true);

      const payload = await statusPayload(false);
      if (previewFailure) payload.previewError = previewFailure;
      return toolResult(payload);
    },
  },
  {
    name: 'photo_adjust',
    description:
      'Apply raster adjustments to a layer: tone (curves, levels, exposure, brightness/contrast, gamma, shadows/highlights, auto tone, posterize, threshold, invert), colour (white balance, HSL master or per hue band, vibrance, colour balance, channel mixer, black & white, gradient map, split toning, photo filter) and focus (gaussian/box/median/motion blur, unsharp mask, smart sharpen, clarity, dehaze, vignette, grain). Pass `adjustments` as an array of { type, ...params }. With `asLayer: true` the stack becomes a non-destructive adjustment layer that flatten applies to the layers below it. `target.selection` clips the adjustment to the active selection and `target.mask` to the layer mask; both compose. Returns the layer tree and a histogram so the effect can be verified rather than assumed.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        adjustments: {
          type: 'array',
          description:
            'One or more adjustments, e.g. [{ "type": "curves", "points": [[0,0],[128,140],[255,255]] }, { "type": "hueSaturation", "band": "blues", "saturation": -20 }]. Applied in a fixed engine order, not list order.',
          items: {
            type: 'object',
            properties: { type: { type: 'string', enum: adjustments.TYPES } },
            required: ['type'],
            additionalProperties: true,
          },
        },
        target: {
          type: 'object',
          description:
            'What to adjust. `layer` is "active" (default), "all" for every raster layer, or a layer id. `selection: true` clips to the active selection, `mask: true` to the layer mask.',
          properties: {
            layer: { type: 'string' },
            selection: { type: 'boolean' },
            mask: { type: 'boolean' },
          },
        },
        asLayer: {
          type: 'boolean',
          description:
            'Create a non-destructive adjustment layer instead of rewriting pixels. Omit for a destructive edit.',
        },
        name: { type: 'string', description: 'Layer name when asLayer is true.' },
      },
      required: ['adjustments'],
    },
    async run(args) {
      requireDocument();
      const stack = adjustments.normalize(
        args.adjustments === undefined ? args.adjustment : args.adjustments
      );
      for (const operation of stack) {
        if (operation.type === 'lut3d' && !lutModule.exists(operation.lut)) {
          throw errorsModule.photoError(
            'MISSING_RESOURCE',
            'No LUT called "' +
              operation.lut +
              '". Install it with photo_lut or use one of: ' +
              (lutModule.list().map((look) => look.name).join(', ') || 'none installed') +
              '. Nothing was changed.',
            {
              field: 'adjustments.name',
              allowed: lutModule.list().map((look) => look.name),
              suggested_call: { tool: 'photo_lut', arguments: { action: 'list' } },
            }
          );
        }
      }
      const summary = adjustments.summary(stack);
      const target =
        args.target && typeof args.target === 'object' && !Array.isArray(args.target)
          ? args.target
          : {};

      if (args.asLayer === true) {
        if (target.layer && target.layer !== 'active') {
          throw new Error(
            'asLayer creates one new adjustment layer; drop target.layer. Nothing was changed.'
          );
        }
        const name =
          typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Adjustment';
        const layer = documentModel.adjustmentLayer({
          name: name,
          adjustments: stack,
          summary: summary,
        });
        if (target.selection) {
          if (!document.selection) {
            throw new Error('target.selection is set but there is no active selection.');
          }
          const mask = await selectionMaskFor(document.selection);
          layer.mask = await writeLayerMaskEntry(layer, mask, 0);
        }
        commitAdjustmentLayer(layer, 'added adjustment layer · ' + summary);
        await refreshVisuals(true);
        const payload = await statusPayload(false);
        return toolResult(payload, textFor(payload) + ' · added adjustment layer · ' + summary);
      }

      if (target.layer === 'all') {
        const rasters = document.layers.filter(
          (candidate) => candidate.kind === 'raster' && candidate.pixels && !candidate.locked
        );
        if (!rasters.length) {
          throw new Error('There is no editable raster layer to adjust. Nothing was changed.');
        }
        const items = [];
        for (const layer of rasters) {
          const mask = await scopedMask(target, layer);
          const applied = await engine.applyToBuffer(store.read(layer.pixels.file), stack, {
            mask: mask,
            canvas: document.canvas,
            offset: layer.offset,
          });
          items.push({ layer: layer, applied: applied });
        }
        commitPixelChanges(
          items,
          summary + ' on ' + rasters.length + ' layer' + (rasters.length === 1 ? '' : 's'),
          'photo_adjust'
        );
      } else {
        const layer = resolveLayer(target.layer);
        if (layer.kind === 'adjustment') {
          if (target.selection || target.mask) {
            throw new Error(
              'An adjustment layer’s own pixels do not exist; set its mask with photo_mask instead. Nothing was changed.'
            );
          }
          const beforeStack = clone(layer.adjustments || []);
          const beforeSummary = layer.summary;
          commitAdjustmentSpec(layer, beforeStack, beforeSummary, stack, summary);
        } else if (layer.kind === 'group') {
          throw errorsModule.photoError(
            'INVALID_ARGUMENT',
            'Layer "' + layer.name + '" is a group. Adjust its child layers, or add an adjustment layer above it. Nothing was changed.',
            { field: 'target.layer', received: layer.name }
          );
        } else {
          if (layer.locked) {
            throw new Error(
              'Layer "' + layer.name + '" is locked; unlock it before editing. Nothing was changed.'
            );
          }
          if (!layer.pixels) {
            throw new Error('Layer "' + layer.name + '" has no pixels to adjust. Nothing was changed.');
          }
          const mask = await scopedMask(target, layer);
          const applied = await engine.applyToBuffer(store.read(layer.pixels.file), stack, {
            mask: mask,
            canvas: document.canvas,
            offset: layer.offset,
          });
          commitPixelChanges([{ layer: layer, applied: applied }], summary, 'photo_adjust');
        }
      }

      await refreshVisuals(true);
      const payload = await statusPayload(false);
      return toolResult(payload, textFor(payload) + ' · ' + summary);
    },
  },
  {
    name: 'photo_draw',
    description:
      'Draw marks onto one raster layer in canvas coordinates: smoothed brush strokes with solid/dashed/dotted line styles and round caps, straight lines and arrows, rectangles and ellipses (filled and/or stroked), polygons and multi-path compound shapes, multi-line text with font size, weight, alignment, letter spacing and rotation, `sketch` — many freehand tapered strokes in one command for rough drawing — plus GIMP-style `fill` and `gradient`. A sketch command takes `strokes: [{ points, width, color, opacity, pressure }]`; `pressure: true` tapers each stroke like a pen, or an array of 0–1 samples sets its own profile; `symmetry` mirrors a pass as `horizontal`, `vertical`, `quad` or `radial` (with optional `axisX`, `axisY`, `segments`) without extra commands or undo entries. A compound command takes `paths` (an array of point arrays) and an optional `fillRule: "evenodd"`, so one command can draw a car body with window and wheel holes; `stroke` also takes `paths` for several detail lines in one command. A `clone` command retouches from another part of the same layer: `{ "type": "clone", "from": [sourceX, sourceY], "points": [[x,y],...], "width": 60, "softness": 0.7 }` copies along the stroke with a soft round falloff, or use `offset` instead of `from`. A `fill` command flood-fills from `x`/`y` with `color`, `tolerance`, `contiguous` and `opacity`; a `gradient` command paints a `rect` (or x/y/width/height) with `shape` linear or radial, `from`/`to` points, and `colors` or up to 16 `stops`. Commands are applied in list order, rasterised anti-aliased at their bounding box and composited with the same selection/mask stack as the rest of the engine, so target.selection clips a drawing or fill. The whole command list is one undoable history entry. Text y is the baseline; rotation is degrees clockwise about (x, y).',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          description:
            'Draw commands applied in order, e.g. [{ "type": "stroke", "points": [[120,240],[180,200],[240,260]], "width": 12, "color": "#ff3b30", "style": "dashed" }, { "type": "text", "text": "Title", "x": 80, "y": 120, "size": 56, "color": "#ffffff", "weight": 700 }]. A sketch command is the fast path for rough drawing: { "type": "sketch", "strokes": [{ "points": [[..]], "width": 6, "pressure": true }], "color": "#111" } draws up to 32 tapered strokes as one undoable entry; add symmetry: "horizontal" | "vertical" | "quad" | "radial" to mirror the whole pass, with optional axisX, axisY and segments (radial only, 2–16, default 6). A polygon or compound may use `paths` instead of `points`: it accepts an array of point arrays and `fillRule` (evenodd by default for multiple paths), so a car silhouette and its window/wheel holes are one command; stroke also accepts `paths` for several detail lines. A bucket fill is { "type": "fill", "x": 420, "y": 310, "color": "#e8482f", "tolerance": 28, "contiguous": true, "opacity": 1 }; it floods the layer from the seed, clipped by target.selection. A gradient is { "type": "gradient", "shape": "linear", "from": [0,0], "to": [1000,0], "rect": { "x": 0, "y": 0, "width": 1000, "height": 500 }, "stops": [{ "offset": 0, "color": "#000000" }, { "offset": 1, "color": "#ffffff" }] }; shape may be radial, colors: [start, end] is shorthand for two stops, and a gradient can be clipped by a selection. Stroke points are smoothed through every sample unless smooth is false; rect/ellipse accept fill and stroke; text accepts font, weight, italic, align (left/center/end), letterSpacing and rotation.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'stroke',
                  'sketch',
                  'line',
                  'arrow',
                  'rect',
                  'ellipse',
                  'polygon',
                  'compound',
                  'text',
                  'fill',
                  'gradient',
                  'clone',
                ],
              },
            },
            required: ['type'],
            additionalProperties: true,
          },
        },
        target: {
          type: 'object',
          description:
            'The raster layer to draw on, plus optional clipping. `layer` is "active" (default) or a layer id. `selection: true` clips to the active selection, `mask: true` to the layer mask.',
          properties: {
            layer: { type: 'string' },
            selection: { type: 'boolean' },
            mask: { type: 'boolean' },
          },
        },
        opacity: {
          type: 'number',
          description: 'Opacity of the whole drawing, 0–1 (default 1).',
        },
      },
      required: ['commands'],
    },
    async run(args) {
      requireDocument();
      const commands = drawModule.normalizeCommands(args.commands);
      const summary = drawModule.summary(commands);
      const target =
        args.target && typeof args.target === 'object' && !Array.isArray(args.target)
          ? args.target
          : {};
      if (target.layer === 'all') {
        throw new Error(
          'photo_draw draws on one layer; pass a layer id or omit target.layer. Nothing was changed.'
        );
      }
      const layer = resolveLayer(target.layer);
      if (layer.kind !== 'raster' || !layer.pixels) {
        throw new Error(
          'Layer "' +
            layer.name +
            '" has no pixels to draw on. Use a raster layer. Nothing was changed.'
        );
      }
      if (layer.locked) {
        throw new Error(
          'Layer "' + layer.name + '" is locked; unlock it before drawing. Nothing was changed.'
        );
      }
      const mask = await scopedMask(target, layer);
      const applied = await engine.drawToBuffer(store.read(layer.pixels.file), commands, {
        canvas: document.canvas,
        offset: layer.offset,
        mask: mask,
        opacity: args.opacity === undefined ? 1 : args.opacity,
        fontDir: fontsModule.fontDir(dataDir),
        customFonts: fontsModule.families(dataDir),
      });
      commitPixelChanges(
        [{ layer: layer, applied: applied }],
        summary + ' on "' + layer.name + '"',
        'photo_draw'
      );
      await refreshVisuals(true);
      const payload = await statusPayload(false);
      return toolResult(payload, textFor(payload) + ' · ' + summary);
    },
  },
  {
    name: 'photo_select',
    description:
      'Create and modify the document selection, which is a coverage mask. Actions: rect, ellipse, polygon, wand (flood fill from a seed with tolerance, contiguous or similar), colorRange, all, none, invert, modify (grow/contract/smooth/border/feather), save (a named slot), load, toMask (turn the selection into the target layer’s mask). A selection clips photo_adjust when target.selection is true. Returns the selection summary; undo restores the previous selection.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'rect',
            'ellipse',
            'polygon',
            'wand',
            'colorRange',
            'all',
            'none',
            'invert',
            'modify',
            'save',
            'load',
            'toMask',
          ],
        },
        rect: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
        },
        ellipse: {
          type: 'object',
          properties: { cx: { type: 'number' }, cy: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' } },
        },
        points: {
          type: 'array',
          description: 'Polygon vertices as [x, y] pairs.',
          items: { type: 'array', items: { type: 'number' } },
        },
        x: { type: 'number', description: 'Wand seed x (rect/ellipse also accept a bounding box).' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        tolerance: { type: 'number', description: 'Wand / colour-range tolerance 0–255.' },
        contiguous: { type: 'boolean', description: 'Wand: only the connected region (default true).' },
        color: { type: 'string', description: 'Colour range target, e.g. #22aa55.' },
        sample: {
          type: 'object',
          description: 'Colour range sampled from this point instead of a literal colour.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
        },
        feather: { type: 'number', description: 'Feather radius in pixels.' },
        grow: { type: 'number' },
        contract: { type: 'number' },
        smooth: { type: 'number' },
        border: { type: 'number' },
        name: { type: 'string', description: 'Named selection slot for save/load.' },
        target: {
          type: 'object',
          description: 'Layer for toMask.',
          properties: { layer: { type: 'string' } },
        },
      },
      required: ['action'],
    },
    async run(args) {
      requireDocument();
      const action = String(args.action || '').trim();
      const width = document.canvas.width;
      const height = document.canvas.height;
      const feather = Math.max(0, Math.min(250, Number(args.feather) || 0));
      const before = clone(document.selection);

      const finish = async (mask, kind, summary, extra) => {
        let finalMask = mask;
        if (finalMask && feather) {
          finalMask = selection.featherMask(finalMask, width, height, feather);
        }
        const after = finalMask
          ? await writeSelectionEntry(kind, summary, finalMask, Object.assign({ feather: feather }, extra || {}))
          : null;
        commitSelection(before, after, summary);
        await refreshVisuals(true);
        const payload = await statusPayload(false);
        return toolResult(payload, textFor(payload) + ' · ' + summary);
      };

      switch (action) {
        case 'all':
          return finish(selection.fullMask(width, height), 'all', 'selected the whole canvas');
        case 'none':
          return finish(null, 'none', 'deselected');
        case 'invert': {
          if (!document.selection) {
            throw new Error('There is no selection to invert. Create one first.');
          }
          const mask = selection.invertMask(await selectionMaskFor(document.selection));
          return finish(mask, 'invert', 'inverted the selection');
        }
        case 'rect': {
          const rect =
            args.rect ||
            { x: args.x, y: args.y, width: args.width, height: args.height };
          if (!Number.isFinite(Number(rect.width)) || !Number.isFinite(Number(rect.height))) {
            throw new Error('rect needs x, y, width and height.');
          }
          const mask = selection.rectMask(width, height, rect);
          return finish(mask, 'rect', 'selected ' + Math.round(rect.width) + '×' + Math.round(rect.height) + ' at ' + Math.round(rect.x || 0) + ',' + Math.round(rect.y || 0));
        }
        case 'ellipse': {
          const ellipse = args.ellipse || {
            cx: Number(args.x) + Number(args.width) / 2,
            cy: Number(args.y) + Number(args.height) / 2,
            rx: Number(args.width) / 2,
            ry: Number(args.height) / 2,
          };
          if (!(ellipse.rx > 0 && ellipse.ry > 0)) {
            throw new Error('ellipse needs cx, cy, rx and ry (or a bounding x/y/width/height).');
          }
          const mask = selection.ellipseMask(width, height, ellipse);
          return finish(mask, 'ellipse', 'elliptical selection');
        }
        case 'polygon': {
          if (!Array.isArray(args.points) || args.points.length < 3) {
            throw new Error('polygon needs at least three [x, y] points.');
          }
          const mask = selection.polygonMask(width, height, args.points);
          return finish(mask, 'polygon', 'polygon selection (' + args.points.length + ' points)');
        }
        case 'wand': {
          const flattened = await engine.flattenDocument(document, store, flattenOptions());
          const mask = selection.wandMask(flattened.raw.data, width, height, {
            x: args.x,
            y: args.y,
            tolerance: args.tolerance,
            contiguous: args.contiguous,
          });
          return finish(mask, 'wand', 'magic wand at ' + Math.round(Number(args.x)) + ',' + Math.round(Number(args.y)));
        }
        case 'colorRange': {
          const flattened = await engine.flattenDocument(document, store, flattenOptions());
          const mask = selection.colorRangeMask(flattened.raw.data, width, height, {
            color: args.color,
            sample: args.sample,
            tolerance: args.tolerance,
          });
          return finish(mask, 'colorRange', 'colour-range selection');
        }
        case 'modify': {
          if (!document.selection) {
            throw new Error('There is no selection to modify. Create one first.');
          }
          let mask = await selectionMaskFor(document.selection);
          const parts = [];
          if (args.grow) {
            mask = selection.growMask(mask, width, height, args.grow);
            parts.push('grow ' + args.grow);
          }
          if (args.contract) {
            mask = selection.contractMask(mask, width, height, args.contract);
            parts.push('contract ' + args.contract);
          }
          if (args.smooth) {
            mask = selection.featherMask(mask, width, height, args.smooth);
            parts.push('smooth ' + args.smooth);
          }
          if (args.border) {
            mask = selection.borderMask(mask, width, height, args.border);
            parts.push('border ' + args.border);
          }
          if (!parts.length) {
            throw new Error('modify needs one of grow, contract, smooth or border.');
          }
          const summary = 'modified selection: ' + parts.join(', ');
          return finish(mask, 'modify', summary, { baseKind: document.selection.kind });
        }
        case 'save': {
          if (!document.selection) {
            throw new Error('There is no active selection to save.');
          }
          const name = String(args.name || '').trim();
          if (!name) throw new Error('save needs a name.');
          document.selections[name] = clone(document.selection);
          documentModel.recordActivity(document, 'photo_select', 'Saved selection "' + name + '"');
          persist();
          const payload = await statusPayload(false);
          return toolResult(payload, textFor(payload) + ' · saved selection "' + name + '"');
        }
        case 'load': {
          const name = String(args.name || '').trim();
          const named = document.selections[name];
          if (!named) {
            throw new Error(
              'No saved selection called "' + name + '". Saved: ' + (Object.keys(document.selections).join(', ') || 'none') + '.'
            );
          }
          commitSelection(before, clone(named), 'loaded selection "' + name + '"');
          await refreshVisuals(true);
          const payload = await statusPayload(false);
          return toolResult(payload, textFor(payload) + ' · loaded selection "' + name + '"');
        }
        case 'toMask': {
          if (!document.selection) {
            throw new Error('There is no active selection to turn into a mask.');
          }
          const layer = resolveLayer(args.target && args.target.layer);
          const mask = await selectionMaskFor(document.selection);
          const maskEntry = await writeLayerMaskEntry(layer, mask, 0);
          if (layer.mask && layer.mask.file) store.remove([layer.mask.file]);
          commitMask(layer, null, maskEntry, 'mask from selection on "' + layer.name + '"', 'photo_select');
          await refreshVisuals(true);
          const payload = await statusPayload(false);
          return toolResult(payload, textFor(payload) + ' · mask from selection');
        }
        default:
          throw new Error(
            'photo_select takes action rect, ellipse, polygon, wand, colorRange, all, none, invert, modify, save, load or toMask.'
          );
      }
    },
  },
  {
    name: 'photo_mask',
    description:
      'Manage a layer or group mask — a coverage mask that controls where that layer contributes when the document is flattened. Actions: create (from the active selection, or full white without one), paint (rect/ellipse at a value, with opacity), feather, invert, delete, apply (multiply a raster layer’s alpha by the mask and remove it; groups and adjustment layers cannot apply). On a group the mask clips the whole composite after its children render. Masks compose with target.mask in photo_adjust, and every change is undoable.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'paint', 'feather', 'invert', 'delete', 'apply'] },
        target: {
          type: 'object',
          properties: { layer: { type: 'string' } },
        },
        fromSelection: { type: 'boolean' },
        shape: { type: 'string', enum: ['rect', 'ellipse', 'brush'] },
        rect: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
        ellipse: { type: 'object', properties: { cx: { type: 'number' }, cy: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' } } },
        points: {
          type: 'array',
          description: 'Brush mask stroke samples as [x, y] pairs.',
          items: { type: 'array', items: { type: 'number' } },
        },
        paths: {
          type: 'array',
          description: 'Several brush mask strokes, each an array of [x, y] points.',
          items: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
        },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', description: 'Brush diameter in pixels for a brush mask paint.' },
        height: { type: 'number' },
        value: { type: 'number', description: 'Paint value 0–255 (default 255 = reveal).' },
        opacity: { type: 'number', description: 'Paint opacity 0–1 (default 1).' },
        feather: { type: 'number' },
      },
      required: ['action'],
    },
    async run(args) {
      requireDocument();
      const action = String(args.action || '').trim();
      const layer = resolveLayer(args.target && args.target.layer);
      const width = document.canvas.width;
      const height = document.canvas.height;

      const summarize = async (summary) => {
        await refreshVisuals(true);
        const payload = await statusPayload(false);
        return toolResult(payload, textFor(payload) + ' · ' + summary);
      };

      switch (action) {
        case 'create': {
          if (layer.mask && layer.mask.file) {
            throw new Error(
              'Layer "' + layer.name + '" already has a mask; paint, feather or delete it first. Nothing was changed.'
            );
          }
          const mask =
            args.fromSelection !== false && document.selection
              ? await selectionMaskFor(document.selection)
              : selection.fullMask(width, height);
          const maskEntry = await writeLayerMaskEntry(layer, mask, 0);
          commitMask(layer, null, maskEntry, 'created mask on "' + layer.name + '"');
          return summarize('created mask on "' + layer.name + '"');
        }
        case 'paint': {
          if (!layer.mask || !layer.mask.file) {
            throw new Error('Layer "' + layer.name + '" has no mask. Create one with photo_mask first.');
          }
          const current = await layerMaskFor(layer);
          const brush = args.shape === 'brush' || Array.isArray(args.points) || Array.isArray(args.paths);
          let painted;
          if (brush) {
            if (!Array.isArray(args.points) && !Array.isArray(args.paths)) {
              throw new Error('A brush mask paint needs `points` or `paths`. Nothing was changed.');
            }
            painted = selection.paintMask(current, width, height, {
              shape: 'brush',
              points: args.points,
              paths: args.paths,
              width: args.width,
              value: args.value,
              opacity: args.opacity,
            });
          } else {
            const shape =
              args.shape === 'ellipse'
                ? Object.assign({ kind: 'ellipse' }, args.ellipse || {
                    cx: Number(args.x) + Number(args.width) / 2,
                    cy: Number(args.y) + Number(args.height) / 2,
                    rx: Number(args.width) / 2,
                    ry: Number(args.height) / 2,
                  })
                : Object.assign({ kind: 'rect' }, args.rect || {
                    x: args.x,
                    y: args.y,
                    width: args.width,
                    height: args.height,
                  });
            painted = selection.paintMask(current, width, height, {
              shape: args.shape === 'ellipse' ? 'ellipse' : 'rect',
              ...(args.shape === 'ellipse'
                ? { cx: shape.cx, cy: shape.cy, rx: shape.rx, ry: shape.ry }
                : { x: shape.x, y: shape.y, width: shape.width, height: shape.height }),
              value: args.value,
              opacity: args.opacity,
            });
          }
          const beforeMask = clone(layer.mask);
          const maskEntry = await writeLayerMaskEntry(layer, painted, layer.mask.feather || 0);
          const paintSummary = brush
            ? 'painted mask brush on "' + layer.name + '"'
            : 'painted mask on "' + layer.name + '"';
          commitMask(layer, beforeMask, maskEntry, paintSummary);
          return summarize(paintSummary);
        }
        case 'feather': {
          if (!layer.mask || !layer.mask.file) {
            throw new Error('Layer "' + layer.name + '" has no mask.');
          }
          const radius = Math.max(0, Math.min(250, Number(args.feather) || 0));
          if (!radius) throw new Error('feather needs a positive feather radius.');
          const beforeMask = clone(layer.mask);
          const mask = selection.featherMask(await layerMaskFor(layer), width, height, radius);
          const maskEntry = await writeLayerMaskEntry(layer, mask, radius);
          commitMask(layer, beforeMask, maskEntry, 'feathered mask on "' + layer.name + '"');
          return summarize('feathered mask by ' + radius + 'px');
        }
        case 'invert': {
          if (!layer.mask || !layer.mask.file) {
            throw new Error('Layer "' + layer.name + '" has no mask.');
          }
          const beforeMask = clone(layer.mask);
          const mask = selection.invertMask(await layerMaskFor(layer));
          const maskEntry = await writeLayerMaskEntry(layer, mask, layer.mask.feather || 0);
          commitMask(layer, beforeMask, maskEntry, 'inverted mask on "' + layer.name + '"');
          return summarize('inverted mask on "' + layer.name + '"');
        }
        case 'delete': {
          if (!layer.mask || !layer.mask.file) {
            throw new Error('Layer "' + layer.name + '" has no mask.');
          }
          const beforeMask = clone(layer.mask);
          commitMask(layer, beforeMask, null, 'deleted mask from "' + layer.name + '"');
          return summarize('deleted mask from "' + layer.name + '"');
        }
        case 'apply': {
          if (!layer.mask || !layer.mask.file) {
            throw new Error('Layer "' + layer.name + '" has no mask.');
          }
          if (!layer.pixels) {
            throw new Error('Only raster layers have pixels a mask can be applied to.');
          }
          const mask = await layerMaskFor(layer);
          const raw = await engine.decode(store.read(layer.pixels.file));
          pixels.applyAlphaMask(
            raw,
            engine.maskForRaw(mask, width, height, raw, layer.offset)
          );
          const applied = await render.encodeRaw(raw, { format: 'png' });
          const beforeMask = clone(layer.mask);
          commitPixelChanges(
            [{ layer: layer, applied: applied }],
            'applied mask to "' + layer.name + '"',
            'photo_mask'
          );
          commitMask(layer, beforeMask, null, 'applied mask to "' + layer.name + '"');
          return summarize('applied and removed the mask on "' + layer.name + '" (two undo steps)');
        }
        default:
          throw new Error(
            'photo_mask takes action create, paint, feather, invert, delete or apply.'
          );
      }
    },
  },
  {
    name: 'photo_layer',
    description:
      'Manage the layer stack. Actions: select (make a layer the active one for later tools — the PhotoNext sidebar calls this when a layer row is clicked), set (blendMode, opacity, visible, locked, name, offset, parent), add (place an external image as a layer from an absolute path), group (make a group from `layers` or target.layer), ungroup (dissolve a group, keeping its children), duplicate, delete, reorder (to an index, or up/down), mergeDown (composite onto the layer below), flatten (merge every visible layer into one). A group is an isolated compositing container: children render bottom-to-top, then the group’s blend mode, opacity, mask and offset apply to that composite. Groups can nest, and `set parent` moves a layer in or out of a group (null removes it). Deleting a group removes its children too; ungroup keeps them. Every pixel or stack change is one undoable history entry; select is not, because choosing which layer to work on changes no pixels.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['select', 'set', 'add', 'group', 'ungroup', 'duplicate', 'delete', 'reorder', 'mergeDown', 'flatten'],
        },
        target: { type: 'object', properties: { layer: { type: 'string' } } },
        layers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Layer ids to group. All must share the same parent.',
        },
        parent: {
          type: 'string',
          description: 'For set: group id to move the layer into, or null/"none" to move it to the document root.',
        },
        blendMode: { type: 'string', description: 'e.g. normal, multiply, screen, overlay, softLight, luminosity.' },
        opacity: { type: 'number', description: '0–1.' },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' },
        name: { type: 'string' },
        offset: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        path: { type: 'string', description: 'Absolute path for add.' },
        x: { type: 'number' },
        y: { type: 'number' },
        index: { type: 'number', description: 'Stack index for reorder (0 = bottom).' },
        direction: { type: 'string', enum: ['up', 'down'] },
      },
      required: ['action'],
    },
    async run(args) {
      requireDocument();
      const action = String(args.action || '').trim();
      const summarize = async (summary) => {
        await refreshVisuals(true);
        const payload = await statusPayload(false);
        return toolResult(payload, textFor(payload) + ' · ' + summary);
      };

      switch (action) {
        case 'select': {
          const layer = resolveLayer(args.target && args.target.layer);
          if (document.activeLayerId === layer.id) {
            return summarize('"' + layer.name + '" is already the active layer');
          }
          document.activeLayerId = layer.id;
          documentModel.bumpRevision(document);
          persist();
          return summarize('selected "' + layer.name + '"');
        }
        case 'set': {
          const layer = resolveLayer(args.target && args.target.layer);
          const before = {
            blendMode: layer.blendMode,
            opacity: layer.opacity,
            visible: layer.visible,
            locked: layer.locked,
            name: layer.name,
            offset: clone(layer.offset),
            parentId: layer.parentId || null,
          };
          const after = clone(before);
          if (args.blendMode !== undefined) {
            after.blendMode = blendModule.normalizeMode(args.blendMode);
          }
          if (args.opacity !== undefined) {
            const opacity = Number(args.opacity);
            if (!Number.isFinite(opacity)) throw new Error('opacity must be a number between 0 and 1.');
            after.opacity = Math.max(0, Math.min(1, opacity));
          }
          if (args.visible !== undefined) after.visible = args.visible !== false;
          if (args.locked !== undefined) after.locked = args.locked === true;
          if (args.name !== undefined) after.name = String(args.name);
          if (args.offset && typeof args.offset === 'object') {
            after.offset = {
              x: Math.round(Number(args.offset.x) || 0),
              y: Math.round(Number(args.offset.y) || 0),
            };
          }
          if (args.parent !== undefined) {
            if (args.parent === null || args.parent === '' || args.parent === 'none' || args.parent === 'root') {
              after.parentId = null;
            } else {
              const parent = resolveLayer(args.parent);
              if (parent.kind !== 'group') {
                throw errorsModule.photoError('INVALID_ARGUMENT', 'parent must be a group id, or null for the document root.', {
                  field: 'parent',
                  received: args.parent,
                });
              }
              if (layer.id === parent.id || documentModel.isWithin(document, parent.id, layer.id)) {
                throw errorsModule.photoError('INVALID_ARGUMENT', 'A group cannot be moved inside itself or one of its own descendants.', {
                  field: 'parent',
                  received: args.parent,
                });
              }
              const subtree = documentModel.descendantsOf(document, layer.id).reduce(
                (height, candidate) =>
                  Math.max(height, documentModel.depthOf(document, candidate) - documentModel.depthOf(document, layer)),
                0
              );
              if (documentModel.depthOf(document, parent) + 1 + subtree > 8) {
                throw errorsModule.photoError('LIMIT_EXCEEDED', 'Groups nest at most 8 deep.', {
                  field: 'parent',
                  limit: 8,
                });
              }
              after.parentId = parent.id;
            }
          }
          const changes = Object.keys(after).filter(
            (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key])
          );
          if (!changes.length) throw new Error('Nothing to set: pass at least one layer property.');
          commitLayerProps(
            layer,
            before,
            after,
            'set ' + changes.join(', ') + ' on "' + layer.name + '"'
          );
          return summarize('set ' + changes.join(', ') + ' on "' + layer.name + '"');
        }
        case 'group': {
          const requested = Array.isArray(args.layers)
            ? args.layers
            : args.target && args.target.layer && args.target.layer !== 'all'
              ? [args.target.layer]
              : [];
          if (!requested.length) {
            throw errorsModule.photoError('INVALID_ARGUMENT', 'group needs `layers` (ids) or target.layer. Nothing was changed.', {
              field: 'layers',
            });
          }
          const members = [];
          const selected = new Set();
          for (const id of requested) {
            const member = resolveLayer(id);
            if (selected.has(member.id)) continue;
            selected.add(member.id);
            members.push(member);
          }
          for (let left = 0; left < members.length; left += 1) {
            for (let right = 0; right < members.length; right += 1) {
              if (
                left !== right &&
                documentModel.isWithin(document, members[left].id, members[right].id)
              ) {
                throw errorsModule.photoError(
                  'INVALID_ARGUMENT',
                  'Select either a group or one of its children, not both. Nothing was changed.',
                  { field: 'layers', received: members[right].name }
                );
              }
            }
          }
          const parentId = members[0].parentId || null;
          if (members.some((member) => (member.parentId || null) !== parentId)) {
            throw errorsModule.photoError(
              'INVALID_ARGUMENT',
              'All layers in one group must share the same parent. Nothing was changed.',
              { field: 'layers' }
            );
          }
          if (document.layers.length >= documentModel.LIMITS.maxLayers) {
            throw errorsModule.photoError(
              'LIMIT_EXCEEDED',
              'A document holds at most ' + documentModel.LIMITS.maxLayers + ' layers including groups. Nothing was changed.',
              { limit: documentModel.LIMITS.maxLayers, requested: document.layers.length + 1 }
            );
          }
          const subtree = members.flatMap((member) => [member].concat(documentModel.descendantsOf(document, member.id)));
          const deepest = subtree.reduce(
            (depth, candidate) => Math.max(depth, documentModel.depthOf(document, candidate)),
            0
          );
          if (deepest + 1 > 8) {
            throw errorsModule.photoError('LIMIT_EXCEEDED', 'Groups nest at most 8 deep.', {
              field: 'layers',
              limit: 8,
            });
          }
          const name =
            typeof args.name === 'string' && args.name.trim()
              ? args.name.trim()
              : 'Group ' + (document.layers.filter((candidate) => candidate.kind === 'group').length + 1);
          const group = documentModel.groupLayer({ name: name, parentId: parentId });
          const insertIndex = Math.min(
            document.layers.length,
            Math.max.apply(null, members.map((member) => document.layers.indexOf(member))) + 1
          );
          document.layers.splice(insertIndex, 0, group);
          const changes = [
            {
              kind: 'layerAdded',
              layerId: group.id,
              index: insertIndex,
              before: null,
              after: clone(group),
              files: [],
            },
          ];
          for (const member of members) {
            changes.push({
              kind: 'layerProps',
              layerId: member.id,
              before: { props: { parentId: member.parentId || null } },
              after: { props: { parentId: group.id } },
            });
            member.parentId = group.id;
          }
          document.activeLayerId = group.id;
          documentModel.bumpRevision(document);
          pushEntry(
            baseEntry('photo_layer', 'grouped ' + members.length + ' layer' + (members.length === 1 ? '' : 's') + ' into "' + name + '"', changes),
            'photo_layer',
            'grouped ' + members.length + ' layers into "' + name + '"'
          );
          return summarize('grouped ' + members.length + ' layer' + (members.length === 1 ? '' : 's') + ' into "' + name + '"');
        }
        case 'ungroup': {
          const group = resolveLayer(args.target && args.target.layer);
          if (group.kind !== 'group') {
            throw errorsModule.photoError('INVALID_ARGUMENT', 'ungroup targets a group layer.', {
              field: 'target.layer',
              received: group.name,
            });
          }
          if (
            group.visible === false ||
            (group.opacity !== undefined && group.opacity < 1) ||
            (group.mask && group.mask.file) ||
            (group.blendMode && group.blendMode !== 'normal')
          ) {
            throw errorsModule.photoError(
              'INVALID_ARGUMENT',
              'Ungrouping would discard the group visibility, mask, opacity or blend mode. Restore those first, or flatten the group. Nothing was changed.',
              { field: 'target.layer', received: group.name }
            );
          }
          const children = documentModel.groupMembers(document, group.id);
          const parentId = group.parentId || null;
          const groupOffset = {
            x: Math.round(Number(group.offset && group.offset.x) || 0),
            y: Math.round(Number(group.offset && group.offset.y) || 0),
          };
          const changes = children.map((child) => ({
            kind: 'layerProps',
            layerId: child.id,
            before: { props: { parentId: group.id, offset: clone(child.offset) } },
            after: {
              props: {
                parentId: parentId,
                offset: {
                  x: Math.round(Number(child.offset && child.offset.x) || 0) + groupOffset.x,
                  y: Math.round(Number(child.offset && child.offset.y) || 0) + groupOffset.y,
                },
              },
            },
          }));
          changes.push({
            kind: 'layerRemoved',
            layerId: group.id,
            index: document.layers.indexOf(group),
            layer: clone(group),
            files: [],
          });
          for (const child of children) {
            child.parentId = parentId;
            child.offset = {
              x: Math.round(Number(child.offset && child.offset.x) || 0) + groupOffset.x,
              y: Math.round(Number(child.offset && child.offset.y) || 0) + groupOffset.y,
            };
          }
          document.layers = document.layers.filter((candidate) => candidate.id !== group.id);
          document.activeLayerId = children.length ? children[children.length - 1].id : parentId;
          documentModel.bumpRevision(document);
          const summary = 'ungrouped "' + group.name + '" (' + children.length + ' layer' + (children.length === 1 ? '' : 's') + ')';
          pushEntry(baseEntry('photo_layer', summary, changes), 'photo_layer', summary);
          return summarize(summary);
        }
        case 'add': {
          const source = requireAbsolutePath(args.path, 'path');
          if (!fs.existsSync(source)) throw new Error('No file exists at ' + source + '.');
          const extension = ops.imageExtension(source);
          if (!extension) {
            throw new Error('Unsupported image type for ' + source + '. Use PNG, JPEG, TIFF, GIF, HEIC or WebP.');
          }
          const originalBytes = fs.readFileSync(source);
          const rotated = await render.autorotate(originalBytes);
          const bytes = rotated ? rotated.buffer : originalBytes;
          const image = await render.readImage(bytes);
          documentModel.assertCanvas(image.width, image.height);
          const storedExtension = rotated
            ? render.outputExtension(rotated.format)
            : extension === 'jpeg'
              ? 'jpg'
              : extension;
          const file = store.writeLayer(documentModel.newId('layer'), bytes, storedExtension);
          const layer = documentModel.rasterLayer({
            file: file,
            width: image.width,
            height: image.height,
            format: ops.formatForExtension(storedExtension) || image.format,
            name: path.basename(source),
          });
          layer.offset = {
            x: args.x === undefined ? Math.round((document.canvas.width - image.width) / 2) : Math.round(Number(args.x)),
            y: args.y === undefined ? Math.round((document.canvas.height - image.height) / 2) : Math.round(Number(args.y)),
          };
          commitLayerAdded(layer, document.layers.length, 'added "' + layer.name + '"');
          return summarize('added "' + layer.name + '" at ' + layer.offset.x + ',' + layer.offset.y);
        }
        case 'duplicate': {
          const layer = resolveLayer(args.target && args.target.layer);
          if (layer.kind === 'group') {
            const subtree = [layer].concat(documentModel.descendantsOf(document, layer.id));
            if (document.layers.length + subtree.length > documentModel.LIMITS.maxLayers) {
              throw errorsModule.photoError(
                'LIMIT_EXCEEDED',
                'Duplicating this group would exceed the ' +
                  documentModel.LIMITS.maxLayers +
                  '-layer budget. Nothing was changed.',
                { limit: documentModel.LIMITS.maxLayers, requested: document.layers.length + subtree.length }
              );
            }
            const idMap = new Map(subtree.map((original) => [original.id, documentModel.newId('layer')]));
            const copies = subtree.map((original) => {
              const copy = clone(original);
              copy.id = idMap.get(original.id);
              copy.parentId = original.parentId ? idMap.get(original.parentId) || original.parentId : null;
              if (original.kind === 'raster' && original.pixels) {
                copy.pixels = {
                  file: store.writeLayer(
                    copy.id,
                    store.read(original.pixels.file),
                    render.outputExtension(encodableFormat(original.pixels.format))
                  ),
                  width: original.pixels.width,
                  height: original.pixels.height,
                  format: original.pixels.format,
                };
              }
              copy.mask = original.mask && original.mask.file
                ? Object.assign({}, original.mask, {
                    file: store.writeMask(copy.id, store.read(original.mask.file)),
                  })
                : null;
              return copy;
            });
            copies[0].name = layer.name + ' copy';
            const start = document.layers.length;
            const changes = [];
            for (let offset = 0; offset < copies.length; offset += 1) {
              document.layers.push(copies[offset]);
              changes.push({
                kind: 'layerAdded',
                layerId: copies[offset].id,
                index: start + offset,
                before: null,
                after: clone(copies[offset]),
                files: [
                  copies[offset].pixels && copies[offset].pixels.file,
                  copies[offset].mask && copies[offset].mask.file,
                ].filter(Boolean),
              });
            }
            document.activeLayerId = copies[0].id;
            documentModel.bumpRevision(document);
            pushEntry(
              baseEntry('photo_layer', 'duplicated group "' + layer.name + '" with ' + (copies.length - 1) + ' children', changes),
              'photo_layer',
              'duplicated group "' + layer.name + '"'
            );
            return summarize('duplicated group "' + layer.name + '" (' + (copies.length - 1) + ' children)');
          }
          if (layer.kind === 'text' && layer.text) {
            const copy = clone(layer);
            copy.id = documentModel.newId('layer');
            copy.name = layer.name + ' copy';
            commitLayerAdded(copy, document.layers.indexOf(layer) + 1, 'duplicated "' + layer.name + '"');
            return summarize('duplicated "' + layer.name + '"');
          }
          if (!layer.pixels) {
            throw new Error('Only raster and text layers can be duplicated in this milestone.');
          }
          const file = store.writeLayer(
            documentModel.newId('layer'),
            store.read(layer.pixels.file),
            render.outputExtension(encodableFormat(layer.pixels.format))
          );
          const copy = clone(layer);
          copy.id = documentModel.newId('layer');
          copy.name = layer.name + ' copy';
          copy.pixels = {
            file: file,
            width: layer.pixels.width,
            height: layer.pixels.height,
            format: layer.pixels.format,
          };
          if (layer.mask && layer.mask.file) {
            copy.mask = Object.assign({}, layer.mask, {
              file: store.writeMask(copy.id, store.read(layer.mask.file)),
            });
          }
          commitLayerAdded(copy, document.layers.indexOf(layer) + 1, 'duplicated "' + layer.name + '"');
          return summarize('duplicated "' + layer.name + '"');
        }
        case 'delete': {
          const layer = resolveLayer(args.target && args.target.layer);
          if (layer.kind !== 'group') {
            commitLayerRemoved(layer, document.layers.indexOf(layer), 'deleted "' + layer.name + '"');
            return summarize('deleted "' + layer.name + '"');
          }
          const doomed = [layer].concat(documentModel.descendantsOf(document, layer.id));
          const doomedIds = new Set(doomed.map((candidate) => candidate.id));
          const changes = doomed.map((candidate) => ({
            kind: 'layerRemoved',
            layerId: candidate.id,
            index: document.layers.indexOf(candidate),
            layer: clone(candidate),
            files: [
              candidate.pixels && candidate.pixels.file,
              candidate.mask && candidate.mask.file,
            ].filter(Boolean),
          }));
          document.layers = document.layers.filter((candidate) => !doomedIds.has(candidate.id));
          document.activeLayerId = layer.parentId || (document.layers[0] && document.layers[0].id) || null;
          documentModel.bumpRevision(document);
          const summary = 'deleted group "' + layer.name + '" and ' + (doomed.length - 1) + ' child' + (doomed.length === 2 ? '' : ' layers');
          pushEntry(baseEntry('photo_layer', summary, changes), 'photo_layer', summary);
          return summarize(summary);
        }
        case 'reorder': {
          const layer = resolveLayer(args.target && args.target.layer);
          const beforeIds = document.layers.map((candidate) => candidate.id);
          let index = args.index;
          if (index === undefined) {
            const current = document.layers.indexOf(layer);
            if (args.direction === 'up') index = current + 1;
            else if (args.direction === 'down') index = current - 1;
            else throw new Error('reorder needs "index" or "direction": up/down.');
          }
          index = Math.max(0, Math.min(document.layers.length - 1, Math.round(Number(index))));
          documentModel.moveLayer(document, layer.id, index);
          const afterIds = document.layers.map((candidate) => candidate.id);
          if (JSON.stringify(beforeIds) === JSON.stringify(afterIds)) {
            throw new Error('The layer is already at that position.');
          }
          commitLayerOrder(beforeIds, afterIds, 'moved "' + layer.name + '" to index ' + index);
          return summarize('moved "' + layer.name + '" to index ' + index);
        }
        case 'mergeDown': {
          const layer = resolveLayer(args.target && args.target.layer);
          const index = document.layers.indexOf(layer);
          if (layer.kind === 'group') {
            throw errorsModule.photoError('UNSUPPORTED', 'Ungroup a group before merging; a group is a container, not a raster layer.', { field: 'target.layer' });
          }
          if (index <= 0) throw new Error('There is no layer below "' + layer.name + '" to merge into.');
          const lower = document.layers[index - 1];
          if (lower.kind === 'group') {
            throw errorsModule.photoError('UNSUPPORTED', 'The layer below is a group; ungroup it or target a layer inside it.', { field: 'target.layer' });
          }
          if ((layer.parentId || null) !== (lower.parentId || null)) {
            throw errorsModule.photoError('INVALID_ARGUMENT', 'mergeDown only merges layers that share the same group.', { field: 'target.layer' });
          }
          const merged = await engine.flattenDocument(
            { canvas: document.canvas, layers: [lower, layer].filter((candidate) => candidate.visible) },
            store,
            flattenOptions()
          );
          const file = store.writeLayer(
            documentModel.newId('layer'),
            merged.buffer,
            'png'
          );
          const mergedLayer = documentModel.rasterLayer({
            file: file,
            width: document.canvas.width,
            height: document.canvas.height,
            format: 'png',
            name: layer.name,
          });
          mergedLayer.parentId = lower.parentId || null;
          const changes = [
            {
              kind: 'layerRemoved',
              layerId: lower.id,
              index: index - 1,
              layer: clone(lower),
              files: [lower.pixels && lower.pixels.file, lower.mask && lower.mask.file].filter(Boolean),
            },
            {
              kind: 'layerRemoved',
              layerId: layer.id,
              index: index,
              layer: clone(layer),
              files: [layer.pixels && layer.pixels.file, layer.mask && layer.mask.file].filter(Boolean),
            },
            {
              kind: 'layerAdded',
              layerId: mergedLayer.id,
              index: index - 1,
              before: null,
              after: clone(mergedLayer),
              files: [mergedLayer.pixels.file],
            },
          ];
          document.layers.splice(index - 1, 2);
          document.layers.splice(index - 1, 0, mergedLayer);
          document.activeLayerId = mergedLayer.id;
          documentModel.bumpRevision(document);
          pushEntry(
            baseEntry('photo_layer', 'merged "' + layer.name + '" down', changes),
            'photo_layer',
            'merged "' + layer.name + '" down'
          );
          return summarize('merged "' + layer.name + '" into "' + lower.name + '"');
        }
        case 'flatten': {
          if (document.layers.length < 2) {
            throw new Error('There is only one layer; nothing to flatten.');
          }
          const flattened = await engine.flattenDocument(document, store, flattenOptions());
          const file = store.writeLayer(documentModel.newId('layer'), flattened.buffer, 'png');
          const layer = documentModel.rasterLayer({
            file: file,
            width: document.canvas.width,
            height: document.canvas.height,
            format: 'png',
            name: 'Flattened',
          });
          const changes = document.layers.map((candidate, index) => ({
            kind: 'layerRemoved',
            layerId: candidate.id,
            index: index,
            layer: clone(candidate),
            files: [candidate.pixels && candidate.pixels.file, candidate.mask && candidate.mask.file].filter(Boolean),
          }));
          changes.push({
            kind: 'layerAdded',
            layerId: layer.id,
            index: 0,
            before: null,
            after: clone(layer),
            files: [layer.pixels.file],
          });
          document.layers = [layer];
          document.activeLayerId = layer.id;
          documentModel.bumpRevision(document);
          pushEntry(baseEntry('photo_layer', 'flattened the document', changes), 'photo_layer', 'flattened the document');
          return summarize('flattened the document to one layer');
        }
        default:
          throw new Error(
            'photo_layer takes action select, set, add, group, ungroup, duplicate, delete, reorder, mergeDown or flatten.'
          );
      }
    },
  },
  {
    name: 'photo_export',
    description:
      'Write the flattened document (raster layers and grouped composites with their blend modes, opacity and masks, plus adjustment layers) to an absolute destination path and return the file that now exists. The extension picks the format from the file extension; a resize can be applied at export time. This is the only photo tool that writes outside extension storage, so it asks the user first.',
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute destination including the file extension, e.g. /Users/me/project/artifacts/cover.png. A leading ~/ is expanded.',
        },
        resize: {
          type: 'object',
          description: 'Optional exact output dimensions, applied only to this exported copy.',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['width', 'height'],
        },
        quality: {
          type: 'number',
          description: 'JPEG/WebP quality 1–100. Ignored for PNG and TIFF.',
        },
        presets: {
          type: 'array',
          description:
            'Export several named sizes from this document in one call, e.g. ["ig_post","ig_story"]. Names come from photo_catalog presets; each variant is flattened once and resized for its output.',
          items: { type: 'string' },
        },
        naming: {
          type: 'string',
          description:
            'File name template for presets. Tokens: {stem}, {preset}, {width}, {height}, {ext}. Default "{stem}-{preset}.{ext}".',
        },
      },
      required: ['path'],
    },
    async run(args) {
      requireDocument();
      const flattened = await engine.flattenDocument(document, store, flattenOptions());
      const buffer = flattened.buffer;

      if (Array.isArray(args.presets) && args.presets.length) {
        if (args.presets.length > 12) {
          throw errorsModule.photoError('LIMIT_EXCEEDED', 'photo_export writes at most 12 presets per call.', {
            field: 'presets',
            limit: 12,
            requested: args.presets.length,
          });
        }
        const base = requireAbsolutePath(args.path, 'path');
        const directory = path.dirname(base);
        fs.mkdirSync(directory, { recursive: true });
        const stem = path.basename(base).replace(/\.[^.]+$/, '');
        const template =
          typeof args.naming === 'string' && args.naming.trim()
            ? args.naming.trim()
            : '{stem}-{preset}.{ext}';
        const baseExtension = ops.imageExtension(base) || 'png';
        const variants = [];
        const used = new Set();
        for (const raw of args.presets) {
          const spec = typeof raw === 'string' ? { name: raw } : raw;
          const name = spec && typeof spec === 'object' ? String(spec.name || '') : '';
          if (!EXPORT_PRESETS[name]) {
            throw errorsModule.photoError('NOT_FOUND', 'No export preset called "' + name + '".', {
              field: 'presets',
              allowed: Object.keys(EXPORT_PRESETS),
              suggested_call: { tool: 'photo_catalog', arguments: { section: 'presets' } },
            });
          }
          const preset = EXPORT_PRESETS[name];
          const format = encodableFormat(
            spec.format === undefined ? ops.formatForExtension(baseExtension) : String(spec.format)
          );
          const quality = spec.quality === undefined ? args.quality : spec.quality;
          const filename = template
            .replace(/\{stem\}/g, stem)
            .replace(/\{preset\}/g, name)
            .replace(/\{width\}/g, String(preset.width))
            .replace(/\{height\}/g, String(preset.height))
            .replace(/\{ext\}/g, render.outputExtension(format));
          const safe = path.basename(filename);
          if (used.has(safe)) {
            throw errorsModule.photoError('INVALID_ARGUMENT', 'The naming template writes "' + safe + '" twice.', {
              field: 'naming',
              received: template,
            });
          }
          used.add(safe);
          const destination = path.join(directory, safe);
          const encoded = await render.encode(buffer, {
            format: format,
            quality: quality,
            resize: { width: preset.width, height: preset.height },
          });
          const temporary = path.join(
            directory,
            '.minotauris-export-' + process.pid + '-' + Date.now() + '-' + safe
          );
          try {
            fs.writeFileSync(temporary, encoded.buffer);
            fs.renameSync(temporary, destination);
          } catch (error) {
            try {
              if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
            } catch {
              // Best effort: the export itself is the failure to report.
            }
            throw error;
          }
          variants.push({
            path: destination,
            preset: name,
            width: encoded.width,
            height: encoded.height,
            format: encoded.format,
            bytes: fs.statSync(destination).size,
          });
        }
        lastExport = Object.assign({}, variants[variants.length - 1], {
          at: documentModel.isoNow(),
          variants: variants.length,
        });
        documentModel.recordActivity(
          document,
          'photo_export',
          'Exported ' + variants.length + ' variant' + (variants.length === 1 ? '' : 's')
        );
        persist();
        return {
          content: [
            {
              type: 'text',
              text:
                'Exported ' +
                variants.length +
                ' variants · ' +
                variants
                  .map((variant) => path.basename(variant.path) + ' ' + variant.width + '×' + variant.height)
                  .join(' · '),
            },
          ],
          structuredContent: {
            ok: true,
            revision: document.revision,
            variants: variants,
            path: variants[0].path,
            lastExport: lastExport,
          },
        };
      }

      let destination = requireAbsolutePath(args.path, 'path');
      let extension = ops.imageExtension(destination);
      if (!extension) {
        extension = 'png';
        destination += '.png';
      }
      const format = ops.formatForExtension(extension);
      const parent = path.dirname(destination);
      fs.mkdirSync(parent, { recursive: true });

      let resize = null;
      if (args.resize && typeof args.resize === 'object') {
        const planned = ops.planEdit(
          { resize: args.resize },
          { width: flattened.width, height: flattened.height }
        );
        const operation = planned.operations.find((candidate) => candidate.kind === 'resize');
        if (operation) resize = operation.size;
      }

      const encoded = await render.encode(buffer, {
        format: encodableFormat(format),
        quality: args.quality,
        resize: resize,
      });

      const temporary = path.join(
        parent,
        '.minotauris-export-' + process.pid + '-' + Date.now() + '.' + extension
      );
      try {
        fs.writeFileSync(temporary, encoded.buffer);
        fs.renameSync(temporary, destination);
      } catch (error) {
        try {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        } catch {
          // Best effort: the export itself is the failure to report.
        }
        throw error;
      }

      const size = await render.readImage(fs.readFileSync(destination));
      lastExport = {
        path: destination,
        width: size.width,
        height: size.height,
        format: size.format,
        bytes: fs.statSync(destination).size,
        at: documentModel.isoNow(),
      };
      documentModel.recordActivity(document, 'photo_export', 'Exported to ' + destination);
      persist();

      return {
        content: [
          {
            type: 'text',
            text:
              'Exported ' +
              destination +
              ' · ' +
              size.width +
              ' × ' +
              size.height +
              ' · ' +
              size.format,
          },
        ],
        structuredContent: { ...lastExport, revision: document.revision },
      };
    },
  },
  {
    name: 'photo_history',
    description:
      'Undo, redo or list the document’s edit history. Each mutating call is one entry; undo restores the previous pixels, adjustment spec, mask, selection, layer properties or layer stack and redo replays them. Recording a new edit after an undo drops the redo tail. The history is capped by entry count and bytes, and the newest entry is never evicted, so the last edit is always reversible.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['undo', 'redo', 'list', 'undo_to'], description: 'What to do. `list` changes nothing.' },
        steps: { type: 'number', description: 'How many entries to undo or redo (1–10, default 1).' },
        revision: { type: 'number', description: 'For undo_to: the revision to land on.' },
      },
      required: ['action'],
    },
    async run(args) {
      requireStore();
      const action = String(args.action || 'list').trim().toLowerCase();
      if (action === 'list') {
        const payload = await statusPayload(false);
        const entries = payload.historyState ? payload.historyState.entries : [];
        return toolResult(
          payload,
          entries.length
            ? 'History: ' +
                entries.length +
                ' entr' +
                (entries.length === 1 ? 'y' : 'ies') +
                ' · ' +
                history.cursor +
                ' applied · ' +
                history.bytes +
                ' bytes of ' +
                history.budgetBytes
            : 'History is empty: no edit has been made to this document yet.'
        );
      }
      if (action !== 'undo' && action !== 'redo' && action !== 'undo_to') {
        throw new Error('photo_history takes action undo, redo, list or undo_to.');
      }
      // An empty stack is still undoable: deleting the last group or layer
      // must not trap the document with no way back.
      if (!document.layers.length && (!history || (!history.cursor && !history.entries.length))) {
        throw new Error('No image is loaded. Call photo_import first.');
      }

      const target = action === 'undo_to' ? Math.round(Number(args.revision)) : null;
      if (action === 'undo_to' && !Number.isFinite(target)) {
        throw errorsModule.photoError('INVALID_ARGUMENT', 'undo_to needs a numeric `revision`.', {
          field: 'revision',
          received: args.revision,
        });
      }
      // A revision is the identifier of a *state*, not of the counter: undoing
      // also bumps the counter, so the jump target comes from the entry that
      // produced that state. An entry without stamps predates the upgrade and
      // falls back to the live counter.
      const stateRevision = () => {
        if (history.cursor <= 0) return Number(history.baseRevision) || 0;
        const applied = history.entries[history.cursor - 1];
        return Number.isFinite(applied && applied.revisionAfter) ? applied.revisionAfter : document.revision;
      };
      let moved = 0;
      let groupsDone = 0;
      const stepOnce = async (direction) => {
        const entry =
          direction === 'undo'
            ? history.cursor > 0
              ? history.entries[history.cursor - 1]
              : null
            : history.cursor < history.entries.length
              ? history.entries[history.cursor]
              : null;
        if (!entry) return null;
        entryState(entry, direction);
        if (direction === 'undo') historyModule.undo(history);
        else historyModule.redo(history);
        await applyHistoryEntry(entry, direction);
        moved += 1;
        return entry;
      };
      const runGroup = async (direction) => {
        const first =
          direction === 'undo'
            ? history.cursor > 0
              ? history.entries[history.cursor - 1]
              : null
            : history.cursor < history.entries.length
              ? history.entries[history.cursor]
              : null;
        if (!first) return 0;
        const groupId = first.groupId && args.group !== false ? first.groupId : null;
        let count = 0;
        do {
          const entry = await stepOnce(direction);
          if (!entry) break;
          count += 1;
          if (!groupId) break;
        } while (
          count < 40 &&
          (direction === 'undo'
            ? history.cursor > 0 && history.entries[history.cursor - 1].groupId === groupId
            : history.cursor < history.entries.length && history.entries[history.cursor].groupId === groupId)
        );
        if (groupId) groupsDone += 1;
        return count;
      };

      if (action === 'undo_to') {
        let guard = 0;
        if (stateRevision() > target) {
          while (stateRevision() > target && guard < 200) {
            const count = await runGroup('undo');
            if (!count) break;
            guard += count;
          }
        } else {
          while (stateRevision() < target && guard < 200) {
            const next = history.cursor < history.entries.length ? history.entries[history.cursor] : null;
            if (!next) break;
            const count = await runGroup('redo');
            if (!count) break;
            guard += count;
          }
        }
      } else {
        let budget = Math.max(1, Math.min(10, Math.round(Number(args.steps) || 1)));
        while (budget > 0) {
          const count = await runGroup(action);
          if (!count) break;
          budget -= count;
        }
      }
      if (!moved && action === 'undo_to') {
        const payload = await statusPayload(false);
        return toolResult(payload, 'Already at revision ' + stateRevision() + '.');
      }
      if (!moved) {
        throw new Error(
          action === 'undo'
            ? 'Nothing to undo: this document is at its oldest kept state.'
            : 'Nothing to redo: no undone edit remains.'
        );
      }

      // Include the refreshed preview in the undo/redo response. The panel's
      // tool call does not poll afterward with the old revision, so omitting it
      // here leaves the previous canvas on screen even though history moved.
      const payload = await statusPayload(true);
      return toolResult(
        payload,
        textFor(payload) +
          ' · ' +
          action +
          ' ' +
          moved +
          ' step' +
          (moved === 1 ? '' : 's') +
          (groupsDone ? ' (' + groupsDone + ' group' + (groupsDone === 1 ? '' : 's') + ')' : '') +
          (action === 'undo_to' ? ' · revision ' + document.revision : '')
      );
    },
  },
  {
    name: 'photo_font',
    description:
      'Manage fonts for photo_draw text. `install` downloads a TrueType/OpenType font from an http(s) URL (or copies an absolute .ttf/.otf path) into extension storage and returns its family name. `list` shows installed families. Use the returned family as `font` on a text command; the font is rendered from extension storage, not installed into the operating system.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['install', 'list'] },
        url: { type: 'string', description: 'http(s) URL of a .ttf or .otf font to download.' },
        path: { type: 'string', description: 'Absolute path of a .ttf or .otf font to copy, as an alternative to url.' },
      },
      required: ['action'],
    },
    async run(args) {
      requireStore();
      const action = String(args.action || '').trim();
      if (action === 'list') {
        const fonts = fontsModule.list(dataDir);
        const payload = await statusPayload(false);
        return toolResult(
          payload,
          'installed fonts: ' + (fonts.map((font) => font.family).join(', ') || 'none')
        );
      }
      if (action !== 'install') {
        throw new Error('photo_font takes action install or list.');
      }
      let entry;
      if (args.url !== undefined) {
        entry = await fontsModule.installFromUrl(dataDir, args.url);
      } else if (args.path !== undefined) {
        entry = fontsModule.installFromPath(
          dataDir,
          requireAbsolutePath(args.path, 'path')
        );
      } else {
        throw new Error('photo_font install needs a url or an absolute path. Nothing was installed.');
      }
      fontsModule.prepare(dataDir);
      const payload = await statusPayload(false);
      return toolResult(
        payload,
        'installed font "' + entry.family + '" · use font: "' + entry.family + '" in photo_draw',
        { font: { family: entry.family, bytes: entry.bytes, source: entry.source } }
      );
    },
  },
  {
    name: 'photo_3d',
    description:
      'Compose a 3D model into the current photo with the native C++ rasteriser. Actions: import (copy an absolute .glb or self-contained .gltf into extension storage and probe its triangle/material bounds), configure (object transform, camera, key/fill/rim lighting, sky/transparent environment, ground shadow catcher, render quality), preview (render an interactive low-resolution camera view without changing the document), render (render a transparent or sky-backed PNG at the document size and add it as a normal raster layer with one undoable history entry), and status (read the scene without rendering). The expensive raster, texture sampling and shadow-map pass run in C++; the first 3D call compiles the bundled source into extension storage and caches it. Rendering does not alter the source model or the photo outside the new layer.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['import', 'configure', 'preview', 'render', 'status'] },
        path: {
          type: 'string',
          description: 'Absolute path of a .glb or .gltf model for import (a leading ~/ is expanded).',
        },
        name: { type: 'string', description: 'Optional label for the imported model or rendered layer.' },
        scene: {
          type: 'object',
          description:
            'For configure: the scene sections to change. Omit to pass object/camera/light/environment/ground/render directly at the top level.',
          additionalProperties: true,
        },
        object: {
          type: 'object',
          description: 'Object transform. position and rotation are [x, y, z]; rotation is degrees.',
          properties: {
            position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            scale: { type: 'number' },
            placeOnGround: { type: 'boolean' },
          },
        },
        camera: {
          type: 'object',
          description: 'Camera. auto frames the model; set auto:false to use position, target and fov.',
          properties: {
            auto: { type: 'boolean' },
            position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            target: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            fov: { type: 'number' },
            framing: { type: 'number', description: 'Auto-camera distance multiplier, 0.5–10 (default 1).' },
          },
        },
        light: {
          type: 'object',
          description: 'Directional key light with sky fill, rim light and soft shadows.',
          properties: {
            direction: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            color: { type: 'string' },
            intensity: { type: 'number' },
            fill: { type: 'number' },
            rim: { type: 'number' },
            ambient: { type: 'number' },
            shadows: { type: 'boolean' },
            shadowOpacity: { type: 'number' },
            shadowSoftness: { type: 'number' },
          },
        },
        environment: {
          type: 'object',
          description: 'Transparent output for compositing, or a generated sky background.',
          properties: {
            mode: { type: 'string', enum: ['transparent', 'sky'] },
            top: { type: 'string' },
            horizon: { type: 'string' },
            alpha: { type: 'number' },
          },
        },
        ground: {
          type: 'object',
          description: 'Ground plane and shadow catcher. alpha 0 makes it a pure shadow pass.',
          properties: {
            enabled: { type: 'boolean' },
            y: { type: 'number' },
            color: { type: 'string' },
            alpha: { type: 'number' },
          },
        },
        render: {
          type: 'object',
          description: 'Render quality. samples is 1–3 (supersampling), shadowMap is 256–2048.',
          properties: {
            samples: { type: 'number' },
            shadowMap: { type: 'number' },
            exposure: { type: 'number' },
          },
        },
        orbit: {
          type: 'object',
          description:
            'For preview: view-only camera orbit. yaw and pitch are degrees; zoom is a distance multiplier. Omit to use the scene camera framing.',
          properties: {
            yaw: { type: 'number' },
            pitch: { type: 'number' },
            zoom: { type: 'number' },
          },
        },
        width: { type: 'number', description: 'Preview width in pixels (240–960, default 720).' },
        height: { type: 'number', description: 'Preview height in pixels (180–720, default 540).' },
        quality: {
          type: 'string',
          enum: ['draft', 'final'],
          description: 'Preview quality: draft for orbiting, final for a refined still.',
        },
      },
      required: ['action'],
    },
    async run(args) {
      const action = String(args.action || '').trim();
      if (action === 'import') {
        requireDocument();
        const source = requireAbsolutePath(args.path, 'path');
        const imported = await native3d.importModel(source);
        const previous = document.scene && document.scene.model ? document.scene.model.file : null;
        document.scene = scene3dModule.defaultScene({
          name:
            typeof args.name === 'string' && args.name.trim()
              ? args.name.trim()
              : imported.sourceName,
          file: imported.file,
          format: imported.format,
          bytes: imported.bytes,
          meshes: imported.probe.meshes,
          primitives: imported.probe.primitives,
          triangles: imported.probe.triangles,
          materials: imported.probe.materials,
          textures: imported.probe.textures,
          bounds: imported.probe.bounds,
        });
        if (previous) native3d.removeModel(previous);
        documentModel.recordActivity(
          document,
          'photo_3d',
          'Imported 3D model ' +
            document.scene.model.name +
            ' · ' +
            imported.probe.triangles.toLocaleString('en-US') +
            ' triangles'
        );
        persist();
        const payload = await statusPayload(false);
        return toolResult(
          payload,
          scene3dModule.summarize(document.scene),
          { scene3d: scene3dModule.publicScene(document.scene) }
        );
      }

      if (action === 'configure') {
        requireDocument();
        if (!scene3dModule.isScene(document.scene)) {
          throw new Error('No 3D scene is loaded. Use photo_3d import first. Nothing was changed.');
        }
        const raw =
          args.scene && typeof args.scene === 'object' && !Array.isArray(args.scene)
            ? args.scene
            : (() => {
                const copy = Object.assign({}, args);
                delete copy.action;
                delete copy.scene;
                delete copy.path;
                delete copy.name;
                return copy;
              })();
        document.scene = scene3dModule.configure(document.scene, raw);
        documentModel.recordActivity(
          document,
          'photo_3d',
          'Configured 3D scene · ' + document.scene.model.name
        );
        persist();
        const payload = await statusPayload(false);
        return toolResult(
          payload,
          scene3dModule.summarize(document.scene),
          { scene3d: scene3dModule.publicScene(document.scene) }
        );
      }

      if (action === 'render') {
        requireDocument();
        if (!scene3dModule.isScene(document.scene)) {
          throw new Error('No 3D scene is loaded. Use photo_3d import first. Nothing was changed.');
        }
        if (document.layers.length >= documentModel.LIMITS.maxLayers) {
          throw new Error(
            'A document holds at most ' +
              documentModel.LIMITS.maxLayers +
              ' layers; delete or merge one before rendering 3D. Nothing was changed.'
          );
        }
        const canvas = document.canvas;
        // The native renderer supersamples internally. Cap that buffer rather
        // than the document, so a 3x render of a large canvas cannot allocate
        // gigabytes while still resizing the final layer back to the canvas.
        const maxRenderEdge = Math.min(4800, Math.floor(8000 / document.scene.render.samples));
        const scale = Math.min(1, maxRenderEdge / Math.max(canvas.width, canvas.height));
        const renderWidth = Math.max(1, Math.round(canvas.width * scale));
        const renderHeight = Math.max(1, Math.round(canvas.height * scale));
        const result = await native3d.render(document.scene, {
          modelPath: store.absolute(document.scene.model.file),
          width: renderWidth,
          height: renderHeight,
        });
        const encoded = await render.encode(result.buffer, {
          format: 'png',
          resize:
            renderWidth === canvas.width && renderHeight === canvas.height
              ? null
              : { width: canvas.width, height: canvas.height },
        });
        const layerName =
          typeof args.name === 'string' && args.name.trim()
            ? args.name.trim()
            : '3D · ' + document.scene.model.name;
        const file = store.writeLayer(documentModel.newId('layer'), encoded.buffer, 'png');
        const layer = documentModel.rasterLayer({
          file: file,
          width: canvas.width,
          height: canvas.height,
          format: 'png',
          name: layerName,
        });
        document.scene.lastRender = {
          layerId: layer.id,
          name: layerName,
          width: canvas.width,
          height: canvas.height,
          engine: result.engine,
          renderMs: result.renderMs,
          at: documentModel.isoNow(),
        };
        const summary =
          'rendered 3D ' +
          document.scene.model.name +
          ' · ' +
          Math.max(1, Math.round(result.renderMs)) +
          ' ms';
        commitLayerAdded(layer, document.layers.length, summary, 'photo_3d');
        await refreshVisuals(true);
        const payload = await statusPayload(false);
        return toolResult(payload, textFor(payload) + ' · ' + summary);
      }

      if (action === 'preview') {
        requireDocument();
        if (!scene3dModule.isScene(document.scene)) {
          throw new Error('No 3D scene is loaded. Use photo_3d import first. Nothing was changed.');
        }
        const width = Math.max(240, Math.min(960, Math.round(Number(args.width) || 720)));
        const height = Math.max(180, Math.min(720, Math.round(Number(args.height) || 540)));
        const prepared = scene3dModule.previewScene(document.scene, {
          orbit: args.orbit,
          quality: args.quality === 'draft' ? 'draft' : 'final',
        });
        const result = await native3d.render(prepared.scene, {
          modelPath: store.absolute(document.scene.model.file),
          width,
          height,
        });
        const image = 'data:image/png;base64,' + result.buffer.toString('base64');
        return {
          content: [
            {
              type: 'text',
              text:
                '3D preview · ' +
                width +
                ' × ' +
                height +
                ' · ' +
                Math.max(1, Math.round(result.renderMs)) +
                ' ms · view only',
            },
          ],
          structuredContent: {
            image,
            orbit: prepared.orbit,
            camera: prepared.camera,
            width,
            height,
            renderMs: result.renderMs,
            engine: result.engine,
          },
        };
      }

      if (action === 'status') {
        const payload = await statusPayload(false);
        return toolResult(
          payload,
          scene3dModule.summarize(document.scene),
          { scene3d: scene3dModule.publicScene(document.scene) }
        );
      }

      throw new Error('photo_3d takes action import, configure, preview, render or status.');
    },
  },
  {
    name: 'photo_text3d',
    description:
      'Render real 3D text with the native C++ engine: extruded glyphs, a distance-field bevel, a twist along the extrusion, key/fill/rim lighting, specular highlights, ambient occlusion and an optional soft shadow, with an orbitable perspective camera. Materials can be solid, a reflective studio chrome or an emissive neon edge, with an optional vertical face gradient. The text mask is laid out by the same font pipeline as photo_draw (system fonts and fonts installed with photo_font), then turned into a signed distance field and ray-marched in C++; this is not a canvas or CSS 3D effect. `action: "render"` adds the result to the document as a normal raster layer in one undoable history entry; `action: "preview"` returns a PNG data URL without changing the document. Use the preview first when tuning depth, bevel, twist and camera.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['render', 'preview'] },
        text: { type: 'string', description: 'The text to extrude. Up to six lines with \\n.' },
        font: { type: 'string', description: 'Font family, including a family installed with photo_font. Default sans-serif.' },
        weight: { type: 'number', description: '100–900, default 700.' },
        italic: { type: 'boolean' },
        letterSpacing: { type: 'number', description: 'Extra spacing in pixels at mask scale, -100–400.' },
        lineHeight: { type: 'number', description: 'Line-height multiplier, 0.5–3.' },
        depth: { type: 'number', description: 'Extrusion depth in text-height units, 0–2 (default 0.32).' },
        bevel: { type: 'number', description: 'Bevel radius in text-height units, 0–0.3 (default 0.03).' },
        twist: { type: 'number', description: 'Twist across the full extrusion in degrees, −720–720 (default 0).' },
        scale: { type: 'number', description: 'World scale of the text box, 0.1–10.' },
        maskSize: { type: 'number', description: 'Mask resolution in pixels, 512–2048 (default 1600). Higher costs more render time.' },
        rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z] degrees.' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        camera: {
          type: 'object',
          properties: {
            fov: { type: 'number', description: '10–100, default 35.' },
            yaw: { type: 'number', description: '−80–80 degrees.' },
            pitch: { type: 'number', description: '−80–80 degrees; 8 shows the extrusion and shadow.' },
            zoom: { type: 'number', description: '0.4–3 camera distance multiplier.' },
          },
          additionalProperties: false,
        },
        light: {
          type: 'object',
          properties: {
            direction: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            color: { type: 'string' },
            intensity: { type: 'number' },
            fill: { type: 'number' },
            rim: { type: 'number' },
            ambient: { type: 'number' },
          },
          additionalProperties: false,
        },
        material: {
          type: 'object',
          properties: {
            face: { type: 'string', description: '#rrggbb front/back colour.' },
            side: { type: 'string', description: '#rrggbb extrusion wall colour.' },
            bevel: { type: 'string', description: '#rrggbb bevel highlight colour.' },
            specular: { type: 'number' },
            shininess: { type: 'number' },
            mode: { type: 'string', enum: ['solid', 'chrome', 'neon'], description: 'solid paint, reflective chrome or an emissive neon edge.' },
            gradient: { type: 'boolean', description: 'Blend a vertical face gradient from faceBottom to faceTop.' },
            faceTop: { type: 'string', description: '#rrggbb gradient top colour.' },
            faceBottom: { type: 'string', description: '#rrggbb gradient bottom colour.' },
          },
          additionalProperties: false,
        },
        shadow: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            opacity: { type: 'number' },
            distance: { type: 'number' },
            softness: { type: 'number' },
            color: { type: 'string' },
          },
          additionalProperties: false,
        },
        background: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['transparent', 'solid', 'gradient'] },
            color: { type: 'string' },
            top: { type: 'string' },
            bottom: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: {
          type: 'object',
          properties: {
            samples: { type: 'number', description: '1–3 supersampling, default 2.' },
            exposure: { type: 'number' },
            steps: { type: 'number', description: 'Ray-march steps, 48–256.' },
          },
          additionalProperties: false,
        },
        name: { type: 'string', description: 'Layer name for render.' },
        width: { type: 'number', description: 'Preview width in pixels, 240–1400.' },
        height: { type: 'number', description: 'Preview height in pixels, 160–900.' },
      },
      required: ['action', 'text'],
      additionalProperties: false,
    },
    async run(args) {
      const action = String(args.action || 'render');
      if (action !== 'render' && action !== 'preview') {
        throw new Error('photo_text3d takes action render or preview.');
      }
      const config = text3dModule.normalize(args);
      const mask = await text3dModule.prepareMask(dataDir, config);
      const paths = fx.temporaryPaths();
      const cleanup = function () {
        for (const file of Object.values(paths)) {
          try {
            fs.rmSync(file, { force: true });
          } catch {
            // The files live under our own native cache.
          }
        }
      };

      try {
        fs.writeFileSync(paths.mask, mask.buffer);

        if (action === 'preview') {
          const width = Math.max(240, Math.min(1400, Math.round(Number(args.width) || 900)));
          const height = Math.max(160, Math.min(900, Math.round(Number(args.height) || 600)));
          fs.writeFileSync(
            paths.job,
            text3dModule.jobFor(config, {
              maskPath: paths.mask,
              outputPath: paths.output,
              width: width,
              height: height,
              aspect: mask.aspect,
            })
          );
          const result = await fx.run('--text', paths.job);
          const image = 'data:image/png;base64,' + fs.readFileSync(paths.output).toString('base64');
          return {
            content: [
              {
                type: 'text',
                text:
                  '3D text preview · ' +
                  width +
                  ' × ' +
                  height +
                  ' · ' +
                  Math.max(1, Math.round(result.renderMs)) +
                  ' ms · native C++ · view only',
              },
            ],
            structuredContent: {
              image: image,
              width: width,
              height: height,
              renderMs: result.renderMs,
              engine: result.engine,
              samples: result.samples,
              rays: result.rays,
              mask: { width: mask.width, height: mask.height },
            },
          };
        }

        requireDocument();
        if (document.layers.length >= documentModel.LIMITS.maxLayers) {
          throw new Error(
            'A document holds at most ' +
              documentModel.LIMITS.maxLayers +
              ' layers; delete or merge one before rendering 3D text. Nothing was changed.'
          );
        }
        const canvas = document.canvas;
        const maxEdge = 2000;
        const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
        const renderWidth = Math.max(1, Math.round(canvas.width * scale));
        const renderHeight = Math.max(1, Math.round(canvas.height * scale));

        fs.writeFileSync(
          paths.job,
          text3dModule.jobFor(config, {
            maskPath: paths.mask,
            outputPath: paths.output,
            width: renderWidth,
            height: renderHeight,
            aspect: mask.aspect,
          })
        );
        const result = await fx.run('--text', paths.job);
        const encoded = await render.encode(fs.readFileSync(paths.output), {
          format: 'png',
          resize:
            renderWidth === canvas.width && renderHeight === canvas.height
              ? null
              : { width: canvas.width, height: canvas.height },
        });
        const layerName =
          typeof args.name === 'string' && args.name.trim()
            ? args.name.trim()
            : '3D text · ' + config.text.split(/\r?\n/)[0].slice(0, 28);
        const file = store.writeLayer(documentModel.newId('layer'), encoded.buffer, 'png');
        const layer = documentModel.rasterLayer({
          file: file,
          width: canvas.width,
          height: canvas.height,
          format: 'png',
          name: layerName,
        });
        const summary =
          text3dModule.summary(config) +
          ' · ' +
          Math.max(1, Math.round(result.renderMs)) +
          ' ms';
        commitLayerAdded(layer, document.layers.length, summary, 'photo_text3d');
        await refreshVisuals(true);
        const payload = await statusPayload(false);
        return toolResult(payload, textFor(payload) + ' · ' + summary);
      } finally {
        cleanup();
      }
    },
  },
  {
    name: 'photo_effect',
    description:
      'Apply a destructive native raster effect to one layer: radialBlur, zoomBlur, motionBlur, lensDistortion, whirl, kaleidoscope, mosaic, stainedGlass, oilify (Kuwahara oil paint), halftone, dither, pixelSort, glow (bloom), wave, glitch or chromaticAberration. The pixels are processed by the bundled C++ engine, not a canvas, and the result replaces the layer with one undoable history entry. Pass the effect name and its parameters at the top level (or inside `params`). Set `preview: true` to process a downscaled copy and return a PNG data URL without touching the document. Effects are original implementations of the operations GIMP popularised, not ports of GPL code.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        effect: { type: 'string', enum: effectsModule.TYPES },
        target: {
          type: 'object',
          description: 'Which raster layer: omit for the active layer, or pass { "layer": "<id>" }.',
          properties: { layer: { type: 'string' } },
          additionalProperties: false,
        },
        params: {
          type: 'object',
          description:
            'Optional parameter object; the same keys may be passed at the top level. radialBlur: amount, centerX, centerY, samples. zoomBlur: amount, centerX, centerY, samples. motionBlur: distance, angle, samples. lensDistortion: k1, k2, scale. whirl: angle, radius, centerX, centerY. kaleidoscope: segments, angle, centerX, centerY, zoom. mosaic: cell. stainedGlass: cell, jitter, edge, edgeColor. oilify: radius, levels. halftone: cell, angle, ink. dither: levels, mode, serpentine. pixelSort: threshold, direction, reverse, minLength. glow: threshold, radius, intensity. wave: amplitude, wavelength, phase, axis. glitch: slices, amount, rgbSplit, seed. chromaticAberration: amount, angle.',
          additionalProperties: true,
        },
        preview: {
          type: 'boolean',
          description: 'Process a downscaled copy and return a PNG data URL without changing the document.',
        },
        previewSize: {
          type: 'number',
          description: 'Longest edge of the preview, 320–1600 (default 900). Ignored unless preview is true.',
        },
      },
      required: ['effect'],
      additionalProperties: true,
    },
    async run(args) {
      requireDocument();
      const preview = args.preview === true;
      const input = Object.assign({}, args);
      if (args.params && typeof args.params === 'object' && !Array.isArray(args.params)) {
        Object.assign(input, args.params);
      }
      delete input.params;
      delete input.target;
      delete input.preview;
      delete input.previewSize;
      const effect = effectsModule.normalize(input);
      const target = args.target && typeof args.target === 'object' ? args.target : {};
      const layer = resolveLayer(target.layer);
      if (layer.kind === 'adjustment') {
        throw new Error(
          'Layer "' + layer.name + '" is an adjustment layer with no pixels. Target a raster layer. Nothing was changed.'
        );
      }
      if (layer.locked) {
        throw new Error(
          'Layer "' + layer.name + '" is locked; unlock it before applying an effect. Nothing was changed.'
        );
      }
      if (!layer.pixels) {
        throw new Error('Layer "' + layer.name + '" has no pixels to process. Nothing was changed.');
      }

      const raw = await engine.decode(store.read(layer.pixels.file));
      let work = raw;
      if (preview) {
        const maxEdge = Math.max(320, Math.min(1600, Math.round(Number(args.previewSize) || 900)));
        if (maxEdge < Math.max(raw.width, raw.height)) {
          const scale = maxEdge / Math.max(raw.width, raw.height);
          const encodedPreview = await engine.encode(raw, {
            format: 'png',
            resize: {
              width: Math.max(1, Math.round(raw.width * scale)),
              height: Math.max(1, Math.round(raw.height * scale)),
            },
          });
          work = await engine.decode(encodedPreview.buffer);
        }
      }
      const paths = fx.temporaryPaths();
      try {
        fs.writeFileSync(paths.inputRaw, work.data);
        fs.writeFileSync(
          paths.job,
          effectsModule.jobFor(effect, {
            inputPath: paths.inputRaw,
            outputPath: paths.outputRaw,
            width: work.width,
            height: work.height,
          })
        );
        const result = await fx.run('--effect', paths.job);
        const output = fs.readFileSync(paths.outputRaw);
        if (output.length !== work.width * work.height * 4) {
          throw new Error('The native effect returned the wrong number of bytes. Nothing was changed.');
        }
        if (preview) {
          const encoded = await engine.encode(
            { data: output, width: work.width, height: work.height, channels: 4 },
            { format: 'png' }
          );
          return {
            content: [
              {
                type: 'text',
                text:
                  'effect preview · ' +
                  effectsModule.summary(effect) +
                  ' · ' +
                  work.width +
                  ' × ' +
                  work.height +
                  ' · ' +
                  Math.max(1, Math.round(result.renderMs)) +
                  ' ms · view only',
              },
            ],
            structuredContent: {
              image: 'data:image/png;base64,' + encoded.buffer.toString('base64'),
              width: work.width,
              height: work.height,
              renderMs: result.renderMs,
              effect: effect.effect,
              engine: result.engine,
            },
          };
        }
        const encoded = await engine.encode(
          { data: output, width: work.width, height: work.height, channels: 4 },
          { format: 'png' }
        );
        const summary = effectsModule.summary(effect) + ' · ' + Math.max(1, Math.round(result.renderMs)) + ' ms';
        commitPixelChanges(
          [{ layer: layer, applied: { buffer: encoded.buffer, width: raw.width, height: raw.height, format: 'png' } }],
          summary,
          'photo_effect'
        );
        await refreshVisuals(true);
        const payload = await statusPayload(false);
        return toolResult(payload, textFor(payload) + ' · ' + summary);
      } finally {
        for (const file of Object.values(paths)) {
          try {
            fs.rmSync(file, { force: true });
          } catch {
            // The files live under our own native cache.
          }
        }
      }
    },
  },
  {
    name: 'photo_style',
    description:
      'Add, edit, enable/disable, reorder, remove or list non-destructive layer styles. Actions: add (type plus params), set (params, enabled, index), remove and list. Types: dropShadow, outerGlow, stroke, innerStroke, bevel. Shadow, glow and stroke paint behind the layer alpha; bevel shades inside it. A style on a group applies to the group’s isolated composite and composes with its mask, opacity and blend mode. Styles are document data (no baked pixels), so every change is undoable and survives save/load. Use photo_catalog section "styles" for parameter ranges and defaults.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'set', 'remove', 'list'] },
        target: {
          type: 'object',
          description: 'Layer or group to change. Defaults to the active layer; omit for `list` to read every layer.',
          properties: { layer: { type: 'string' } },
        },
        styleId: { type: 'string', description: 'Style id from add/list; required for set/remove when the layer has more than one style.' },
        type: { type: 'string', enum: stylesModule.TYPES, description: 'Style type for add.' },
        params: {
          type: 'object',
          description: 'Type-specific parameters. Colours accept hex or rgb()/rgba(). Omitted values use photo_catalog defaults.',
          properties: {
            color: { type: 'string' },
            highlight: { type: 'string' },
            shadow: { type: 'string' },
            opacity: { type: 'number' },
            size: { type: 'number' },
            distance: { type: 'number' },
            angle: { type: 'number' },
            spread: { type: 'number' },
            hardness: { type: 'number' },
            soften: { type: 'number' },
            blend: { type: 'string' },
          },
        },
        enabled: { type: 'boolean', description: 'Toggle an existing style, or create one disabled.' },
        index: { type: 'number', description: 'Position in the layer style stack (0 = first painted).' },
      },
      required: ['action'],
    },
    async run(args) {
      requireDocument();
      const action = String(args.action || '').trim();
      const paramNames = ['color', 'highlight', 'shadow', 'opacity', 'size', 'distance', 'angle', 'spread', 'hardness', 'soften', 'blend'];
      const compact = (value) => {
        const out = {};
        for (const key of Object.keys(value || {})) {
          if (value[key] !== undefined) out[key] = value[key];
        }
        return out;
      };
      const incomingParams = () => {
        const params = compact(args.params || {});
        for (const key of paramNames) {
          if (args[key] !== undefined) params[key] = args[key];
        }
        return params;
      };
      const requireStyles = (layer) => {
        if (!Array.isArray(layer.styles)) layer.styles = [];
        return layer.styles;
      };
      const pickStyle = (layer, styles, required) => {
        const id = args.styleId === undefined ? null : String(args.styleId);
        if (id) {
          const found = styles.find((style) => style.id === id);
          if (!found) {
            throw errorsModule.photoError(
              'NOT_FOUND',
              'Layer "' + layer.name + '" has no style "' + id + '". Nothing was changed.',
              {
                field: 'styleId',
                candidates: styles.map((style) => ({ id: style.id, type: style.type, summary: stylesModule.summary(style) })),
                suggested_call: { tool: 'photo_style', arguments: { action: 'list', target: { layer: layer.id } } },
              }
            );
          }
          return found;
        }
        if (!required && styles.length === 1) return styles[0];
        throw errorsModule.photoError(
          'INVALID_ARGUMENT',
          styles.length
            ? 'styleId is required: layer "' + layer.name + '" has ' + styles.length + ' styles. Nothing was changed.'
            : 'Layer "' + layer.name + '" has no styles. Add one with photo_style action add first.',
          {
            field: 'styleId',
            candidates: styles.map((style) => ({ id: style.id, type: style.type })),
            suggested_call: styles.length
              ? { tool: 'photo_style', arguments: { action: 'list', target: { layer: layer.id } } }
              : { tool: 'photo_style', arguments: { action: 'add', target: { layer: layer.id }, type: 'dropShadow' } },
          }
        );
      };

      if (action === 'list') {
        const layers = args.target && args.target.layer
          ? [resolveLayer(args.target.layer)]
          : document.layers;
        const payloadLayers = layers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          kind: layer.kind,
          styles: requireStyles(layer).map(stylesModule.describeStyle),
        }));
        const count = payloadLayers.reduce((total, layer) => total + layer.styles.length, 0);
        return toolResult(
          { revision: document.revision, layers: payloadLayers, count: count },
          count + ' style' + (count === 1 ? '' : 's') + ' on ' + payloadLayers.filter((layer) => layer.styles.length).length + ' layer' + (payloadLayers.filter((layer) => layer.styles.length).length === 1 ? '' : 's')
        );
      }

      const layer = resolveLayer(args.target && args.target.layer);
      if (layer.kind === 'adjustment') {
        throw errorsModule.photoError(
          'INVALID_ARGUMENT',
          'Adjustment layers have no pixels of their own, so they cannot carry layer styles. Apply the style to a raster layer or group instead. Nothing was changed.',
          {
            field: 'target.layer',
            suggested_call: { tool: 'photo_style', arguments: { action: 'list' } },
          }
        );
      }
      if (layer.locked) {
        throw new Error('Layer "' + layer.name + '" is locked; unlock it before changing styles. Nothing was changed.');
      }
      const styles = requireStyles(layer);
      const before = clone(styles);

      if (action === 'add') {
        const type = String(args.type || '').trim();
        if (!stylesModule.TYPE_INFO[type]) {
          throw errorsModule.photoError(
            'INVALID_ARGUMENT',
            'Unknown style type "' + type + '". Use ' + stylesModule.TYPES.join(', ') + '. Nothing was changed.',
            { field: 'type', allowed: stylesModule.TYPES }
          );
        }
        let style;
        try {
          style = stylesModule.createStyle(type, incomingParams(), {
            id: documentModel.newId('style'),
            enabled: args.enabled !== false,
          });
        } catch (error) {
          throw errorsModule.photoError('INVALID_ARGUMENT', error.message + ' Nothing was changed.', {
            field: 'params',
            allowed: stylesModule.TYPE_INFO[type].params,
          });
        }
        const index = args.index === undefined
          ? styles.length
          : Math.max(0, Math.min(styles.length, Math.round(Number(args.index) || 0)));
        styles.splice(index, 0, style);
        commitStyles(layer, before, styles, 'added ' + type + ' to "' + layer.name + '"');
        await refreshVisuals(true);
        return toolResult(
          {
            revision: document.revision,
            layer: { id: layer.id, name: layer.name, kind: layer.kind },
            style: stylesModule.describeStyle(style),
            styles: styles.map(stylesModule.describeStyle),
          },
          stylesModule.summary(style) + ' · ' + layer.name
        );
      }

      if (action === 'set') {
        const style = pickStyle(layer, styles);
        if (args.type !== undefined && String(args.type) !== style.type) {
          throw errorsModule.photoError(
            'INVALID_ARGUMENT',
            'A style’s type cannot change; remove it and add a ' + String(args.type) + ' instead. Nothing was changed.',
            { field: 'type', current: style.type }
          );
        }
        const params = incomingParams();
        if (Object.keys(params).length) {
          try {
            style.params = stylesModule.normalizeParams(style.type, Object.assign({}, style.params, params));
          } catch (error) {
            throw errorsModule.photoError('INVALID_ARGUMENT', error.message + ' Nothing was changed.', {
              field: 'params',
              allowed: stylesModule.TYPE_INFO[style.type].params,
            });
          }
        }
        if (args.enabled !== undefined) style.enabled = args.enabled !== false;
        if (args.index !== undefined) {
          const from = styles.indexOf(style);
          styles.splice(from, 1);
          const to = Math.max(0, Math.min(styles.length, Math.round(Number(args.index) || 0)));
          styles.splice(to, 0, style);
        }
        if (stylesModule.stylesSignature(before) === stylesModule.stylesSignature(styles)) {
          return toolResult(
            { revision: document.revision, layer: { id: layer.id, name: layer.name }, style: stylesModule.describeStyle(style), styles: styles.map(stylesModule.describeStyle) },
            'style unchanged · ' + layer.name
          );
        }
        commitStyles(layer, before, styles, 'updated ' + stylesModule.summary(style) + ' on "' + layer.name + '"', { coalesceStyleId: style.id });
        await refreshVisuals(true);
        return toolResult(
          {
            revision: document.revision,
            layer: { id: layer.id, name: layer.name, kind: layer.kind },
            style: stylesModule.describeStyle(style),
            styles: styles.map(stylesModule.describeStyle),
          },
          stylesModule.summary(style) + ' · ' + layer.name
        );
      }

      if (action === 'remove') {
        const style = pickStyle(layer, styles);
        const index = styles.indexOf(style);
        styles.splice(index, 1);
        commitStyles(layer, before, styles, 'removed ' + style.type + ' from "' + layer.name + '"');
        await refreshVisuals(true);
        return toolResult(
          {
            revision: document.revision,
            layer: { id: layer.id, name: layer.name, kind: layer.kind },
            removed: { id: style.id, type: style.type, summary: stylesModule.summary(style), index: index },
            styles: styles.map(stylesModule.describeStyle),
          },
          'removed ' + stylesModule.summary(style) + ' · ' + layer.name
        );
      }

      throw errorsModule.photoError(
        'INVALID_ARGUMENT',
        'Unknown photo_style action "' + action + '". Use add, set, remove or list.',
        { field: 'action', allowed: ['add', 'set', 'remove', 'list'] }
      );
    },
  },
  {
    name: 'photo_text',
    description:
      'Create and edit editable text layers. A text layer stores the string, font family, size, weight, italic, line height, letter spacing, alignment, colour, rotation, scale and baseline position; it has no baked pixels, so every set is a field edit that survives snapshots, undo/redo, describe and layer-tree output. The engine rasterises it at composite time, which means opacity, blend mode, masks, layer styles (shadow, stroke, glow, bevel), groups and group styles apply exactly as they do to a raster layer. Actions: create, set, remove, list. x/y is the baseline origin in document pixels and is stored on the layer offset, so photo_layer set offset moves text too. lineHeight is a multiplier of the font size; letterSpacing is in pixels. Creating a text layer and its first set are one undo step; remove restores the layer on undo.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'set', 'remove', 'list'] },
        target: { type: 'object', properties: { layer: { type: 'string', description: 'Text layer id, or "active" (default).' } } },
        content: { type: 'string', description: 'The editable text. Newlines make multiple lines. Required on create.' },
        text: { type: 'string', description: 'Alias for content.' },
        font: { type: 'string', description: 'Font family, e.g. sans-serif, Georgia or an installed photo_font family.' },
        fontFamily: { type: 'string', description: 'Alias for font.' },
        size: { type: 'number', description: 'Font size in pixels, 4–2000 (before scale).' },
        weight: { type: 'number', description: 'Font weight, 100–900.' },
        italic: { type: 'boolean' },
        lineHeight: { type: 'number', description: 'Line height as a multiplier of the font size, 0.5–4 (default 1.25).' },
        letterSpacing: { type: 'number', description: 'Tracking in pixels, -200–1000.' },
        align: { type: 'string', enum: ['left', 'center', 'right'] },
        color: { type: 'string', description: 'Fill colour, e.g. #ffffff or rgb(255, 200, 40).' },
        fill: { type: 'string', description: 'Alias for color.' },
        x: { type: 'number', description: 'Baseline x in document pixels. Stored on the layer offset.' },
        y: { type: 'number', description: 'Baseline y in document pixels. Stored on the layer offset.' },
        rotation: { type: 'number', description: 'Clockwise rotation in degrees, -360–360.' },
        scale: { type: 'number', description: 'Uniform scale multiplier, 0.05–4; size × scale must be at most 4000px.' },
        name: { type: 'string', description: 'Layer name. Defaults to the first line of the text.' },
      },
      required: ['action'],
    },
    async run(args) {
      requireDocument();
      const action = String(args.action || '').trim();
      const summarize = async (summary) => {
        await refreshVisuals(true);
        const payload = await statusPayload(false);
        return toolResult(payload, textFor(payload) + ' · ' + summary);
      };

      if (action === 'list') {
        const selected = args.target && args.target.layer
          ? [resolveLayer(args.target.layer)]
          : textLayers();
        const layers = selected.map((layer) => ({
          id: layer.id,
          name: layer.name,
          visible: layer.visible !== false,
          opacity: layer.opacity === undefined ? 1 : layer.opacity,
          blendMode: layer.blendMode || 'normal',
          frame: frameOf(layer),
          text: layer.kind === 'text'
            ? Object.assign(textModule.describe(layer.text), {
                transform: {
                  x: Math.round(Number(layer.offset && layer.offset.x) || 0),
                  y: Math.round(Number(layer.offset && layer.offset.y) || 0),
                  rotation: layer.text.rotation,
                  scale: layer.text.scale,
                },
              })
            : null,
        }));
        return toolResult(
          { revision: document.revision, layers: layers, count: layers.length },
          layers.length
            ? layers.length + ' editable text layer' + (layers.length === 1 ? '' : 's')
            : 'no editable text layers; create one with photo_text action create'
        );
      }

      if (action === 'create') {
        let text;
        try {
          text = textModule.normalize(args);
        } catch (error) {
          throw textTargetError(error);
        }
        const align = text.align;
        const defaultX = align === 'center'
          ? Math.round(document.canvas.width / 2)
          : align === 'right'
            ? Math.max(0, document.canvas.width - 40)
            : 40;
        const x = args.x === undefined ? defaultX : Math.round(Number(args.x));
        const y = args.y === undefined ? Math.round(document.canvas.height * 0.5) : Math.round(Number(args.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw textTargetError(Object.assign(new Error('x and y must be numbers.'), { field: 'x' }));
        }
        const layer = documentModel.textLayer({
          name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : defaultTextName(text),
          text: text,
          x: x,
          y: y,
        });
        commitTextAdded(layer, 'created text "' + layer.name + '"');
        return summarize('created editable text "' + layer.name + '" at ' + x + ',' + y);
      }

      if (action === 'set') {
        const layer = resolveTextLayer(args.target && args.target.layer);
        if (layer.locked) {
          throw errorsModule.photoError(
            'INVALID_ARGUMENT',
            'Layer "' + layer.name + '" is locked; unlock it before editing text. Nothing was changed.',
            { field: 'target.layer', received: layer.name }
          );
        }
        let text;
        try {
          text = textModule.normalize(args, layer.text);
        } catch (error) {
          throw textTargetError(error);
        }
        const before = {
          text: clone(layer.text),
          offset: clone(layer.offset),
          name: layer.name,
        };
        const after = {
          text: text,
          offset: clone(layer.offset),
          name: args.name === undefined ? layer.name : String(args.name),
        };
        if (args.x !== undefined) {
          const x = Math.round(Number(args.x));
          if (!Number.isFinite(x)) {
            throw textTargetError(Object.assign(new Error('x must be a number.'), { field: 'x' }));
          }
          after.offset.x = x;
        }
        if (args.y !== undefined) {
          const y = Math.round(Number(args.y));
          if (!Number.isFinite(y)) {
            throw textTargetError(Object.assign(new Error('y must be a number.'), { field: 'y' }));
          }
          after.offset.y = y;
        }
        if (
          textModule.signature(before.text) === textModule.signature(after.text) &&
          before.offset.x === after.offset.x &&
          before.offset.y === after.offset.y &&
          before.name === after.name
        ) {
          return summarize('text unchanged on "' + layer.name + '"');
        }
        commitText(
          layer,
          before,
          after,
          'updated text "' + layer.name + '" · ' + textModule.summary(text)
        );
        return summarize('updated editable text "' + layer.name + '"');
      }

      if (action === 'remove') {
        const layer = resolveTextLayer(args.target && args.target.layer);
        commitLayerRemoved(layer, document.layers.indexOf(layer), 'removed text "' + layer.name + '"');
        return summarize('removed editable text "' + layer.name + '" (undo restores it)');
      }

      throw errorsModule.photoError(
        'INVALID_ARGUMENT',
        'Unknown photo_text action "' + action + '". Use create, set, remove or list.',
        { field: 'action', allowed: ['create', 'set', 'remove', 'list'] }
      );
    },
  },
  {
    name: 'photo_describe',
    description:
      'Read the document at a chosen level of detail without returning the whole world. `detail`: summary (id, name, kind, visibility, frame, normalized box and style count per layer), standard (adds masks, styles, adjustment types and summaries) or full (adds offsets, pixel formats and history). Groups carry `parentId`, `depth` and `children`; single raster layers also get `parentId`. Use `fields` to select top-level keys and `layerLimit` to cap layers. This is the context-efficient replacement for reading photo_status every turn.',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        detail: { type: 'string', enum: ['summary', 'standard', 'full'], description: 'How much to return. Default summary.' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these top-level keys, e.g. ["canvas","layers","selection"].',
        },
        layerLimit: { type: 'number', description: 'Maximum layers to list (default 12 / 40 / 200 by detail).' },
        includeHistogram: { type: 'boolean' },
        includePreview: { type: 'boolean', description: 'Include a preview data URL. Omit for text-only context.' },
      },
    },
    async run(args) {
      requireStore();
      const detail = ['summary', 'standard', 'full'].indexOf(String(args.detail)) === -1 ? 'summary' : String(args.detail);
      await refreshVisuals(false);
      const total = document.layers.length;
      const fallback = detail === 'summary' ? 12 : detail === 'standard' ? 40 : 200;
      const limit = Math.max(1, Math.min(200, Math.round(Number(args.layerLimit) || fallback)));
      const layers = document.layers.slice(0, limit).map((layer, index) => describeLayer(layer, index, detail));
      const pixelLayer = document.layers.find((layer) => layer.kind === 'raster' && layer.pixels) || null;
      const payload = {
        loaded: total > 0,
        revision: document.revision,
        documentId: document.id,
        canvas: document.canvas,
        sourceName: document.metadata.sourceName,
        format: pixelLayer ? pixelLayer.pixels.format : null,
                  counts: {
          layers: total,
          visible: document.layers.filter((layer) => layer.visible !== false).length,
          raster: document.layers.filter((layer) => layer.kind === 'raster').length,
          adjustment: document.layers.filter((layer) => layer.kind === 'adjustment').length,
          group: document.layers.filter((layer) => layer.kind === 'group').length,
          text: document.layers.filter((layer) => layer.kind === 'text').length,
          hidden: document.layers.filter((layer) => layer.visible === false).length,
          locked: document.layers.filter((layer) => layer.locked === true).length,
        },
        activeLayerId: document.activeLayerId,
        layers: layers,
        layersTotal: total,
        layersTruncated: total > layers.length,
        selection: document.selection
          ? {
              kind: document.selection.kind,
              summary: document.selection.summary,
              bounds: document.selection.bounds,
              bbox_norm: inspect.normBox(document.selection.bounds, document.canvas),
            }
          : null,
        savedSelections: Object.keys(document.selections || {}),
        scene3d: document.scene && document.scene.model ? { name: document.scene.model.name } : null,
      };
      if (args.includeHistogram === true) payload.histogram = histogramCache;
      if (detail === 'full') {
        payload.history = {
          applied: history.cursor,
          total: history.entries.length,
          entries: historyModule.entriesView(history).slice(-12),
        };
      }
      if (Array.isArray(args.fields) && args.fields.length) {
        const wanted = new Set(args.fields.map((field) => String(field)));
        for (const key of Object.keys(payload)) if (!wanted.has(key)) delete payload[key];
      }
      if (args.includePreview === true) {
        if (!previewDataUrl) await refreshVisuals(true);
        payload.preview = previewDataUrl;
      }
      const text =
        (total ? total + ' layer' + (total === 1 ? '' : 's') : 'empty document') +
        ' · ' +
        document.canvas.width +
        '×' +
        document.canvas.height +
        ' · revision ' +
        document.revision;
      return toolResult(payload, text);
    },
  },
  {
    name: 'photo_delta',
    description:
      'Return what changed since a revision: added, removed and changed layers with their frames and reasons, plus whether the selection or canvas changed. Cheap enough to call after every edit, and the answer to "did my last call do anything?". If the requested revision predates the kept snapshots, `baseline` is false and `snapshotRevision` names the nearest one used.',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        sinceRevision: { type: 'number', description: 'The revision returned by the previous call.' },
      },
      required: ['sinceRevision'],
    },
    async run(args) {
      requireStore();
      const since = Math.round(Number(args.sinceRevision));
      if (!Number.isFinite(since)) {
        throw errorsModule.photoError('INVALID_ARGUMENT', 'sinceRevision must be a revision number.', {
          field: 'sinceRevision',
          received: args.sinceRevision,
        });
      }
      const snapshot = documentModel.revisionSnapshot(document, since);
      if (!snapshot) {
        return toolResult(
          { revision: document.revision, sinceRevision: since, baseline: false, availableFrom: document.revisions.length ? document.revisions[0].revision : document.revision, changed: [], no_op: false },
          'No snapshot at or before revision ' + since + ' is kept; use photo_status for the current state.'
        );
      }
      const delta = inspect.diffSnapshots(snapshot, inspect.snapshotDocument(document));
      const payload = Object.assign(
        {
          revision: document.revision,
          sinceRevision: since,
          snapshotRevision: snapshot.revision,
          baseline: snapshot.revision === since,
          availableFrom: document.revisions.length ? document.revisions[0].revision : snapshot.revision,
        },
        delta
      );
      const text = delta.no_op
        ? 'no change since revision ' + since
        : delta.added.length +
          ' added · ' +
          delta.changed.length +
          ' changed · ' +
          delta.removed.length +
          ' removed since revision ' +
          since;
      return toolResult(payload, text);
    },
  },
  {
    name: 'photo_find',
    description:
      'Resolve layers by name fragment, id, kind, visibility or bounding box. Returns ranked candidates with ids, indices, frames and scores rather than guessing. With `requireOne: true`, two or more matches raise AMBIGUOUS_TARGET and list the candidates; with no match and `requireOne`, it raises NOT_FOUND. Use this before an edit when a layer name is not an exact id.',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment, exact name or layer id.' },
        kind: { type: 'string', enum: ['raster', 'adjustment', 'group'] },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' },
        bbox: { type: 'object', description: 'Only layers whose frame intersects this document-space box.' },
        limit: { type: 'number' },
        requireOne: { type: 'boolean', description: 'Fail unless exactly one layer matches.' },
      },
    },
    async run(args) {
      requireStore();
      const matches = inspect.rankLayers(inspect.snapshotLayers(document), {
        name: args.query,
        kind: args.kind,
        visible: args.visible,
        locked: args.locked,
        bbox: args.bbox,
      });
      const limit = Math.max(1, Math.min(50, Math.round(Number(args.limit) || 20)));
      const shown = matches.slice(0, limit);
      if (args.requireOne === true) {
        if (!matches.length) {
          throw errorsModule.photoError('NOT_FOUND', 'No layer matches "' + String(args.query || '') + '".', {
            candidates: [],
            retryable: false,
            suggested_call: { tool: 'photo_describe', arguments: { detail: 'summary' } },
          });
        }
        if (matches.length > 1) {
          throw errorsModule.photoError(
            'AMBIGUOUS_TARGET',
            matches.length + ' layers match "' + String(args.query || '') + '". Pass one of their ids.',
            { candidates: matches.slice(0, 8), retryable: false }
          );
        }
      }
      return toolResult(
        { query: args.query || null, count: matches.length, matches: shown, truncated: matches.length > shown.length },
        matches.length ? matches.length + ' match' + (matches.length === 1 ? '' : 'es') : 'no matching layer'
      );
    },
  },
  {
    name: 'photo_bounds',
    description:
      'Return exact geometry for one or more layers: the frame box (offset + pixels, or the union of descendants for a group), the alpha-trimmed ink box (union for a group), both normalized to 0..1, centres and corners. Frame bounds say where the layer is; ink bounds say where the visible thing is. `layers` accepts "active" (default), an id, an array of ids, or "all".',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        layers: { description: '"active" | "all" | layer id | array of ids.' },
        includeInk: { type: 'boolean', description: 'Decode raster layers for alpha-trimmed bounds. Default true.' },
      },
    },
    async run(args) {
      requireStore();
      const list = resolveLayerList(args.layers, {});
      const includeInk = args.includeInk !== false;
      const entries = [];
      for (let index = 0; index < list.length; index += 1) {
        const layer = list[index];
        const frame = frameOf(layer);
        const entry = {
          id: layer.id,
          name: layer.name,
          kind: layer.kind,
          index: document.layers.indexOf(layer),
          frame: frame,
          bbox_norm: inspect.normBox(frame, document.canvas),
          center: { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
          anchors: {
            topLeft: inspect.anchorPoint('top-left', frame),
            center: inspect.anchorPoint('center', frame),
            bottomRight: inspect.anchorPoint('bottom-right', frame),
          },
          ink: null,
        };
        if (includeInk && (layer.kind === 'raster' || layer.kind === 'text' || layer.kind === 'group')) {
          const ink = layer.kind === 'group' ? await groupInkBounds(layer) : await inkBoundsOf(layer);
          if (ink && ink.doc) {
            entry.ink = Object.assign({}, ink.doc, {
              bbox_norm: inspect.normBox(ink.doc, document.canvas),
              center: { x: ink.doc.x + ink.doc.width / 2, y: ink.doc.y + ink.doc.height / 2 },
              coverage: ink.layer.coverage,
            });
          } else if (ink && !ink.empty) {
            entry.ink = Object.assign({}, ink, {
              bbox_norm: inspect.normBox(ink, document.canvas),
              center: { x: ink.x + ink.width / 2, y: ink.y + ink.height / 2 },
            });
          } else {
            entry.ink = { empty: true };
          }
        }
        entries.push(entry);
      }
      return toolResult(
        { revision: document.revision, canvas: document.canvas, layers: entries },
        entries.length + ' layer' + (entries.length === 1 ? '' : 's') + ' measured'
      );
    },
  },
  {
    name: 'photo_sample',
    description:
      'Read pixels without opening the image elsewhere. `action: "pixels"` samples exact RGBA, hex, alpha and luminance at document points through an optional layer offset. `palette` returns dominant colours with percentages. `histogram` returns clipping and channel means (set `full: true` for the 256-bin arrays). Use it to verify a colour, find a brand hue or check whether an area is actually empty.',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pixels', 'palette', 'histogram'] },
        points: { type: 'array', description: 'Document-space points as [x,y] or {x,y}.', items: {} },
        layer: { type: 'string', description: 'Sample this raster layer instead of the flattened document.' },
        colors: { type: 'number', description: 'Palette size, 2–64 (default 8).' },
        full: { type: 'boolean', description: 'Return full 256-bin histogram arrays.' },
      },
    },
    async run(args) {
      requireStore();
      const action = String(args.action || 'pixels');
      const layer = args.layer && args.layer !== 'flattened' ? resolveLayer(args.layer) : null;
      if (layer && (layer.kind !== 'raster' || !layer.pixels)) {
        throw errorsModule.photoError('INVALID_ARGUMENT', 'Layer "' + layer.name + '" has no pixels to sample.', {
          field: 'layer',
        });
      }
      const raw = layer
        ? await engine.decode(store.read(layer.pixels.file))
        : (await flattenedRaw()).raw;
      const offset = layer ? frameOf(layer) : { x: 0, y: 0 };
      if (action === 'palette') {
        const result = inspect.palette(raw, args.colors);
        return toolResult(
          Object.assign({ revision: document.revision, space: layer ? 'layer' : 'doc', layerId: layer ? layer.id : null }, result),
          result.colors.length + ' dominant colours'
        );
      }
      if (action === 'histogram') {
        const stats = pixels.histogram(raw);
        const compact = {
          revision: document.revision,
          bins: stats.bins,
          pixels: stats.pixels,
          clipping: stats.clipping,
          mean: stats.mean,
        };
        if (args.full === true) compact.channels = { red: stats.red, green: stats.green, blue: stats.blue, luma: stats.luma };
        return toolResult(compact, 'histogram · ' + stats.pixels + ' pixels · mean luma ' + Math.round(stats.mean.luma));
      }
      if (action !== 'pixels') {
        throw errorsModule.photoError('INVALID_ARGUMENT', 'photo_sample takes action pixels, palette or histogram.', {
          field: 'action',
          allowed: ['pixels', 'palette', 'histogram'],
        });
      }
      if (!Array.isArray(args.points) || !args.points.length) {
        throw errorsModule.photoError('INVALID_ARGUMENT', 'photo_sample action pixels needs a non-empty `points` array.', {
          field: 'points',
        });
      }
      if (args.points.length > 256) {
        throw errorsModule.photoError('LIMIT_EXCEEDED', 'photo_sample reads at most 256 points per call.', {
          field: 'points',
          limit: 256,
          requested: args.points.length,
        });
      }
      const samples = inspect.sampleRaw(raw, args.points, { offset: offset });
      return toolResult(
        { revision: document.revision, space: layer ? 'layer' : 'doc', layerId: layer ? layer.id : null, samples: samples },
        samples.filter((sample) => sample.inside).length + ' of ' + samples.length + ' points sampled'
      );
    },
  },
  {
    name: 'photo_region',
    description:
      'Return a 1:1 or zoomed crop of the document (or one layer) with its document-space mapping. Fine text, hairlines and edges are invisible in a 1400 px preview; scale 2–4 shows them. The result carries bbox, bbox_norm, scale, space and the document size, so what you see can be mapped back to tool coordinates exactly.',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        bbox: { type: 'object', description: 'Document-space {x,y,width,height}.' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        scale: { type: 'number', description: '1–4 output pixels per document pixel (default 1).' },
        layer: { type: 'string', description: 'Crop this layer instead of the flattened document.' },
      },
    },
    async run(args) {
      requireStore();
      requireDocument();
      const requested = inspect.toRect(args.bbox || { x: args.x, y: args.y, width: args.width, height: args.height });
      if (!requested || !(requested.width > 0) || !(requested.height > 0)) {
        throw errorsModule.photoError('INVALID_ARGUMENT', 'photo_region needs a bbox with positive width and height.', {
          field: 'bbox',
          received: args.bbox,
        });
      }
      const scale = Math.max(1, Math.min(4, Number(args.scale) || 1));
      const rect = inspect.clampRect(requested, document.canvas);
      if (!rect) {
        throw errorsModule.photoError('OUT_OF_BOUNDS', 'That bbox does not intersect the canvas.', {
          field: 'bbox',
          received: requested,
          canvas: document.canvas,
        });
      }
      const layer = args.layer ? resolveLayer(args.layer) : null;
      let encoded;
      if (layer) {
        if (layer.kind !== 'raster' || !layer.pixels) {
          throw errorsModule.photoError('UNSUPPORTED', 'Layer "' + layer.name + '" has no pixels to crop.', { field: 'layer' });
        }
        const raw = await engine.decode(store.read(layer.pixels.file));
        const frame = frameOf(layer);
        const local = inspect.clampRect(
          { x: rect.x - frame.x, y: rect.y - frame.y, width: rect.width, height: rect.height },
          { width: raw.width, height: raw.height }
        );
        if (!local) {
          throw errorsModule.photoError('OUT_OF_BOUNDS', 'That bbox does not intersect layer "' + layer.name + '".', {
            field: 'bbox',
            frame: frame,
          });
        }
        const cropped = pixels.crop(raw, local);
        encoded = await engine.encode(cropped, {
          format: 'png',
          resize: { width: Math.round(local.width * scale), height: Math.round(local.height * scale) },
        });
      } else {
        encoded = await engine.encode((await flattenedRaw()).raw, {
          format: 'png',
          resize: { width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) },
        });
      }
      return {
        content: [
          {
            type: 'text',
            text:
              'region ' +
              rect.width +
              '×' +
              rect.height +
              ' at ' +
              rect.x +
              ',' +
              rect.y +
              ' · ×' +
              scale +
              ' · revision ' +
              document.revision,
          },
        ],
        structuredContent: {
          image: 'data:image/png;base64,' + encoded.buffer.toString('base64'),
          bbox: rect,
          bbox_norm: inspect.normBox(rect, document.canvas),
          scale: scale,
          space: 'doc',
          doc: { width: document.canvas.width, height: document.canvas.height },
          width: encoded.width,
          height: encoded.height,
          layerId: layer ? layer.id : null,
          revision: document.revision,
        },
      };
    },
  },
  {
    name: 'photo_measure_text',
    description:
      'Measure text with the same font pipeline photo_draw uses, before committing it: ink width/height, line count, document-space box, overflow against maxWidth or a target box, the font size that fits, and optionally WCAG contrast of `color` against the actual rendered background. Replaces the guess-and-render loop that makes agents ship overflowing or illegible type. Text placement matches photo_draw: x/y is the baseline origin.',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        size: { type: 'number', description: 'Font size in pixels (default 32).' },
        font: { type: 'string' },
        weight: { type: 'number' },
        italic: { type: 'boolean' },
        letterSpacing: { type: 'number' },
        lineHeight: { type: 'number', description: 'Line height in pixels.' },
        align: { type: 'string', enum: ['left', 'center', 'end'] },
        rotation: { type: 'number' },
        x: { type: 'number', description: 'Placement x, used for the document box and contrast sample.' },
        y: { type: 'number', description: 'Placement baseline y.' },
        color: { type: 'string', description: 'Text colour for the contrast check, e.g. #ffffff.' },
        maxWidth: { type: 'number' },
        box: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } },
        checkContrast: { type: 'boolean', description: 'Sample the flattened document behind the text (default true when color and document are present).' },
      },
      required: ['text'],
    },
    async run(args) {
      const text = String(args.text === undefined ? '' : args.text);
      if (!text.trim()) {
        throw errorsModule.photoError('INVALID_ARGUMENT', 'photo_measure_text needs non-empty `text`.', { field: 'text' });
      }
      const size = Math.max(1, Math.min(4000, Number(args.size) || 32));
      const rotation = Math.max(-360, Math.min(360, Number(args.rotation) || 0));
      const command = {
        type: 'text',
        text: text,
        x: 0,
        y: 0,
        size: size,
        font: args.font || 'sans-serif',
        weight: args.weight,
        italic: args.italic === true,
        align: args.align || 'left',
        letterSpacing: args.letterSpacing,
        lineHeight: args.lineHeight,
      };
      let bounds = drawModule.boundsOf([command]);
      if (rotation) {
        const radians = (rotation * Math.PI) / 180;
        const corners = [
          [bounds.x, bounds.y],
          [bounds.x + bounds.width, bounds.y],
          [bounds.x + bounds.width, bounds.y + bounds.height],
          [bounds.x, bounds.y + bounds.height],
        ].map((point) => [
          point[0] * Math.cos(radians) - point[1] * Math.sin(radians),
          point[0] * Math.sin(radians) + point[1] * Math.cos(radians),
        ]);
        const xs = corners.map((point) => point[0]);
        const ys = corners.map((point) => point[1]);
        bounds = {
          x: Math.floor(Math.min.apply(null, xs)),
          y: Math.floor(Math.min.apply(null, ys)),
          width: Math.max(1, Math.ceil(Math.max.apply(null, xs) - Math.min.apply(null, xs))),
          height: Math.max(1, Math.ceil(Math.max.apply(null, ys) - Math.min.apply(null, ys))),
        };
      }
      if (bounds.width * bounds.height > 16000000) {
        throw errorsModule.photoError(
          'LIMIT_EXCEEDED',
          'That text needs a ' + bounds.width + '×' + bounds.height + ' measurement surface, over the 16 MP limit. Measure a shorter line.',
          { limit: 16000000, requested: bounds.width * bounds.height }
        );
      }
      const svg = drawModule.buildSvg(bounds, [command]);
      const family = String(command.font).trim().toLowerCase();
      const custom = fontsModule.families(dataDir).some((name) => name.toLowerCase() === family);
      const mark = await render.rasterizeSvg(
        svg,
        bounds.width,
        bounds.height,
        custom ? { fontDir: fontsModule.fontDir(dataDir) } : null
      );
      const ink = inspect.alphaBounds(mark, { threshold: 8 });
      if (ink.empty) {
        throw errorsModule.photoError(
          'MISSING_FONT',
          'The text rendered as blank. Install the font with photo_font or use an installed family.',
          { field: 'font', received: command.font, retryable: true }
        );
      }
      const offsetX = Number(args.x) || 0;
      const offsetY = Number(args.y) || 0;
      const docBox = {
        x: Math.round(bounds.x + ink.x + offsetX),
        y: Math.round(bounds.y + ink.y + offsetY),
        width: ink.width,
        height: ink.height,
      };
      const lineCount = text.split(/\r?\n/).length;
      const maxWidth = args.maxWidth === undefined ? null : Math.max(1, Number(args.maxWidth) || 1);
      const box =
        args.box && Number(args.box.width) > 0 && Number(args.box.height) > 0
          ? { width: Number(args.box.width), height: Number(args.box.height) }
          : null;
      const issues = [];
      if (maxWidth && ink.width > maxWidth) {
        issues.push({
          code: 'text-overflow',
          message: 'Ink width ' + ink.width + 'px exceeds maxWidth ' + maxWidth + 'px.',
          fix: 'Fit the size to ' + Math.floor((size * maxWidth) / ink.width) + 'px or wrap the text.',
        });
      }
      if (box && (ink.width > box.width || ink.height > box.height)) {
        issues.push({
          code: 'text-overflow',
          message: 'Ink ' + ink.width + '×' + ink.height + ' exceeds the ' + box.width + '×' + box.height + ' box.',
          fix: 'Use fitSize ' + Math.floor(size * Math.min(box.width / ink.width, box.height / ink.height)) + 'px.',
        });
      }
      if (document.layers.length) {
        if (
          docBox.x < 0 ||
          docBox.y < 0 ||
          docBox.x + docBox.width > document.canvas.width ||
          docBox.y + docBox.height > document.canvas.height
        ) {
          issues.push({ code: 'off-canvas', message: 'Part of the text falls outside the canvas.', fix: 'Move x/y inward or reduce size.' });
        }
      }
      if (size < 10) {
        issues.push({ code: 'tiny-text', message: 'At ' + size + 'px this text is below a legible size.', fix: 'Use at least 10px.' });
      }
      let contrast = null;
      const wantsContrast = args.checkContrast !== false && args.color && document.layers.length > 0;
      if (wantsContrast) {
        const flat = await flattenedRaw();
        const red = Math.max(0, Math.min(flat.raw.width - 1, docBox.x));
        const top = Math.max(0, Math.min(flat.raw.height - 1, docBox.y));
        const bottom = Math.max(top + 1, Math.min(flat.raw.height, docBox.y + docBox.height));
        const right = Math.max(red + 1, Math.min(flat.raw.width, docBox.x + docBox.width));
        let luminance = 0;
        let samples = 0;
        let sumRed = 0;
        let sumGreen = 0;
        let sumBlue = 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = red; x < right; x += 1) {
            const index = (y * flat.raw.width + x) * (flat.raw.channels || 4);
            if (flat.raw.data[index + 3] < 16) continue;
            sumRed += flat.raw.data[index];
            sumGreen += flat.raw.data[index + 1];
            sumBlue += flat.raw.data[index + 2];
            luminance += inspect.relativeLuminance(
              flat.raw.data[index],
              flat.raw.data[index + 1],
              flat.raw.data[index + 2]
            );
            samples += 1;
          }
        }
        if (samples) {
          const channels = drawModule.colorChannels(args.color, '#ffffff');
          const textLuminance = inspect.relativeLuminance(channels[0], channels[1], channels[2]);
          const ratio = inspect.contrastRatio(textLuminance, luminance / samples);
          contrast = {
            ratio: ratio,
            wcagAA: ratio >= 4.5,
            wcagAAA: ratio >= 7,
            backgroundHex: inspect.hexOf(sumRed / samples, sumGreen / samples, sumBlue / samples),
            samples: samples,
          };
          if (!contrast.wcagAA) {
            issues.push({
              code: 'low-contrast',
              message: 'Contrast ' + ratio + ':1 is below WCAG AA 4.5:1.',
              fix: 'Darken or lighten the text, or add a scrim behind it.',
            });
          }
        }
      }
      const fit =
        box && ink.width && ink.height
          ? Math.max(1, Math.floor(size * Math.min(box.width / ink.width, box.height / ink.height)))
          : maxWidth && ink.width > maxWidth
            ? Math.max(1, Math.floor((size * maxWidth) / ink.width))
            : null;
      const payload = {
        revision: document.revision,
        text: text,
        font: command.font,
        weight: Number(args.weight) || 400,
        size: size,
        lineCount: lineCount,
        ink: { width: ink.width, height: ink.height, coverage: ink.coverage },
        box: docBox,
        bbox_norm: document.layers.length ? inspect.normBox(docBox, document.canvas) : null,
        baseline: { x: offsetX, y: offsetY },
        rotation: rotation,
        maxWidth: maxWidth,
        targetBox: box,
        overflow: issues.some((issue) => issue.code === 'text-overflow'),
        fitSize: fit,
        contrast: contrast,
        issues: issues,
      };
      return toolResult(
        payload,
        'text ink ' + ink.width + '×' + ink.height + ' · ' + lineCount + ' line' + (lineCount === 1 ? '' : 's') + (issues.length ? ' · ' + issues.length + ' issue' + (issues.length === 1 ? '' : 's') : '')
      );
    },
  },
  {
    name: 'photo_catalog',
    description:
      'Read the engine catalogue without a 200-parameter tool schema: effects with their parameter ranges and defaults, adjustments, layer style types, blend modes, installed fonts, export presets and budgets. Use `section` to ask for one, or `name` for one effect or adjustment description.',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['effects', 'adjustments', 'blendModes', 'fonts', 'presets', 'budgets', 'styles', 'all'] },
        name: { type: 'string', description: 'One effect or adjustment type to describe in detail.' },
      },
    },
    async run(args) {
      requireStore();
      const section = String(args.section || 'all');
      const payload = {};
      if (args.name) {
        const effect = effectsModule.describe(String(args.name));
        if (effect) {
          return toolResult({ effects: [effect] }, effectsModule.summary({ effect: String(args.name) }) + ' · ' + effect.params.length + ' params');
        }
        const adjustment = adjustments.catalog().find((entry) => entry.type === String(args.name));
        if (adjustment) return toolResult({ adjustments: [adjustment] }, adjustment.type + ' · ' + adjustment.params.join(', '));
        const style = stylesModule.describeAll().find((entry) => entry.type === String(args.name));
        if (style) return toolResult({ styles: [style] }, style.type + ' · ' + style.params.join(', '));
        throw errorsModule.photoError('NOT_FOUND', 'No effect, adjustment or style called "' + String(args.name) + '".', {
          field: 'name',
          suggested_call: { tool: 'photo_catalog', arguments: { section: 'effects' } },
        });
      }
      if (section === 'effects' || section === 'all') payload.effects = effectsModule.describeAll();
      if (section === 'adjustments' || section === 'all') payload.adjustments = adjustments.catalog();
      if (section === 'blendModes' || section === 'all') payload.blendModes = blendModule.BLEND_MODES;
      if (section === 'fonts' || section === 'all') payload.fonts = fontsModule.list(dataDir);
      if (section === 'presets' || section === 'all') {
        payload.presets = Object.keys(EXPORT_PRESETS).map((key) => Object.assign({ name: key }, EXPORT_PRESETS[key]));
      }
      if (section === 'styles' || section === 'all') payload.styles = stylesModule.describeAll();
      if (section === 'budgets' || section === 'all') payload.budgets = documentModel.LIMITS;
      const keys = Object.keys(payload);
      return toolResult(payload, keys.map((key) => key + ': ' + (Array.isArray(payload[key]) ? payload[key].length : '')).join(' · '));
    },
  },
  {
    name: 'photo_preflight',
    description:
      'Check an export before rendering it: format support, dimensions and pixel budget, transparency loss on JPEG, preset match, path writability, quality range, active layer styles and an estimated file size. Returns pass/warn/fail checks with fixes, so a broken deliverable is caught in one call instead of after the write.',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute destination, used for the format and writability check.' },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp', 'tiff', 'gif'] },
        width: { type: 'number' },
        height: { type: 'number' },
        quality: { type: 'number' },
        preset: { type: 'string', description: 'A name from photo_catalog presets, e.g. ig_story.' },
      },
    },
    async run(args) {
      requireStore();
      const checks = [];
      const add = (id, level, message, fix) => checks.push({ id: id, level: level, message: message, fix: fix || null });
      let destination = null;
      let extension = null;
      if (args.path !== undefined) {
        destination = requireAbsolutePath(args.path, 'path');
        extension = ops.imageExtension(destination);
      }
      const format = String(args.format || extension || 'png') === 'jpg' ? 'jpeg' : String(args.format || extension || 'png');
      if (['png', 'jpeg', 'webp', 'tiff', 'gif'].indexOf(format) === -1) {
        add('format', 'fail', 'Unsupported export format "' + format + '".', 'Use png, jpeg, webp, tiff or gif.');
      } else {
        add('format', 'pass', 'Exports as ' + format + '.');
      }
      const preset = args.preset ? EXPORT_PRESETS[String(args.preset)] : null;
      if (args.preset && !preset) {
        add('preset', 'fail', 'No preset called "' + String(args.preset) + '".', 'Use one of: ' + Object.keys(EXPORT_PRESETS).join(', ') + '.');
      }
      const width = Math.round(Number(args.width) || (preset ? preset.width : document.canvas.width));
      const height = Math.round(Number(args.height) || (preset ? preset.height : document.canvas.height));
      if (!(width > 0 && height > 0)) {
        add('dimensions', 'fail', 'Width and height must be positive.', 'Pass width and height, or import a document first.');
      } else {
        add('dimensions', 'pass', width + '×' + height + ' (' + ((width * height) / 1e6).toFixed(2) + ' MP).');
        if (width > documentModel.LIMITS.maxCanvasEdge || height > documentModel.LIMITS.maxCanvasEdge) {
          add('dimensions', 'fail', 'Exceeds the ' + documentModel.LIMITS.maxCanvasEdge + 'px edge limit.', 'Resize below the edge limit.');
        }
        if (width * height > documentModel.LIMITS.maxPixels) {
          add('pixels', 'fail', 'Exceeds the ' + documentModel.LIMITS.maxPixels / 1e6 + ' MP budget.', 'Downscale or crop.');
        } else {
          add('pixels', 'pass', 'Within the document pixel budget.');
        }
      }
      if (preset && Number(args.width) && Number(args.height) && (Number(args.width) !== preset.width || Number(args.height) !== preset.height)) {
        add('preset', 'warn', 'Explicit size differs from ' + args.preset + ' (' + preset.width + '×' + preset.height + ').', 'Drop width/height to use the preset exactly.');
      }
      if (destination) {
        const parent = path.dirname(destination);
        let existing = parent;
        while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
        try {
          fs.accessSync(existing, fs.constants.W_OK);
          add('path', 'pass', 'Destination directory is writable.');
        } catch {
          add('path', 'fail', 'Destination directory is not writable: ' + parent, 'Choose a path under a writable folder.');
        }
        if (/\.(png|jpe?g|webp|tiff?|gif)$/i.test(destination) === false) {
          add('extension', 'warn', 'No recognised extension; export will append .png.', 'End the path with the intended extension.');
        }
      }
      if (format === 'jpeg' && document.layers.length) {
        const flat = await flattenedRaw();
        const channels = flat.raw.channels || 4;
        let transparent = 0;
        for (let index = 0; index < flat.raw.width * flat.raw.height; index += 1) {
          if (flat.raw.data[index * channels + 3] < 250) {
            transparent += 1;
            if (transparent > 64) break;
          }
        }
        if (transparent) {
          add('transparency', 'warn', 'JPEG has no alpha; transparent areas will not survive.', 'Export PNG/WebP, or flatten onto a background layer first.');
        } else {
          add('transparency', 'pass', 'No transparency to lose.');
        }
      }
      const quality = args.quality === undefined ? 90 : Number(args.quality);
      if (['jpeg', 'webp'].indexOf(format) !== -1 && (!(quality >= 1) || quality > 100)) {
        add('quality', 'fail', 'Quality must be 1–100.', 'Pass quality between 1 and 100.');
      } else if (['jpeg', 'webp'].indexOf(format) !== -1) {
        add('quality', 'pass', 'Quality ' + quality + '.');
      }
      if (format === 'gif') {
        add('palette', 'warn', 'GIF is limited to 256 colours and 1-bit alpha.', 'Use PNG or WebP for gradients and soft transparency.');
      }
      if (format === 'tiff') {
        add('size', 'warn', 'TIFF is uncompressed here and can be very large.', 'Use PNG for a smaller lossless file, or JPEG for delivery.');
      }
      const styledLayers = document.layers.filter(
        (layer) => layer.visible !== false && Array.isArray(layer.styles) && layer.styles.length
      );
      const enabledStyles = styledLayers.reduce(
        (total, layer) => total + layer.styles.filter((style) => style.enabled !== false).length,
        0
      );
      const styleTypes = Array.from(
        new Set(
          styledLayers.reduce(
            (types, layer) =>
              types.concat(
                layer.styles.filter((style) => style.enabled !== false).map((style) => style.type)
              ),
            []
          )
        )
      );
      const editableText = document.layers.filter(
        (layer) => layer.visible !== false && layer.kind === 'text' && layer.text
      );
      if (editableText.length) {
        add(
          'text',
          'pass',
          editableText.length +
            ' editable text layer' +
            (editableText.length === 1 ? '' : 's') +
            ' will be rasterised into the export.'
        );
        const outside = editableText.filter((layer) => {
          const box = frameOf(layer);
          return box.x < 0 || box.y < 0 || box.x + box.width > document.canvas.width || box.y + box.height > document.canvas.height;
        });
        if (outside.length) {
          add(
            'textBounds',
            'warn',
            outside.length +
              ' text layer' +
              (outside.length === 1 ? '' : 's') +
              ' extend past the canvas and will be clipped.',
            'Move the baseline or reduce the size/scale before exporting.'
          );
        }
      } else {
        add('text', 'pass', 'No editable text layers.');
      }
      if (styledLayers.length) {
        add(
          'styles',
          'pass',
          enabledStyles +
            ' enabled layer style' +
            (enabledStyles === 1 ? '' : 's') +
            ' on ' +
            styledLayers.length +
            ' layer' +
            (styledLayers.length === 1 ? '' : 's') +
            ' will be rendered into the export.'
        );
      } else {
        add('styles', 'pass', 'No layer styles.');
      }
      const estimates = {
        bytes: inspect.estimateBytes(format, width, height, quality),
        bytesLabel: '~' + Math.max(1, Math.round(inspect.estimateBytes(format, width, height, quality) / 1024)) + ' KB',
        method: 'estimate',
      };
      const stylesReport = {
        layers: styledLayers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          count: layer.styles.length,
          enabled: layer.styles.filter((style) => style.enabled !== false).length,
          types: layer.styles.map((style) => style.type),
        })),
        enabled: enabledStyles,
        types: styleTypes,
      };
      const textReport = {
        layers: editableText.map((layer) => ({
          id: layer.id,
          name: layer.name,
          content: layer.text.content,
          size: layer.text.size,
          frame: frameOf(layer),
        })),
        count: editableText.length,
      };
      const ok = !checks.some((check) => check.level === 'fail');
      return toolResult(
        { ok: ok, checks: checks, estimates: estimates, styles: stylesReport, text: textReport, resolved: { path: destination, format: format, width: width, height: height, quality: quality, preset: args.preset || null } },
        (ok ? 'ready to export' : 'export would fail') + ' · ' + width + '×' + height + ' ' + format + ' · ' + estimates.bytesLabel
      );
    },
  },
  {
    name: 'photo_layout',
    description:
      'Align, distribute or space layers by intent instead of arithmetic. `action: "align"` moves the selected layers so their chosen edge or centre meets the same edge of the canvas, the active selection, the safe area or another layer. `distribute` equalizes the gaps between three or more layers along an axis; `space` sets an exact gap. Uses frame bounds by default and alpha-trimmed ink bounds with `useInk: true`. A group moves as one unit: its frame is the union of its descendants and one offset shifts the subtree. `layers: "all"` means top-level layers, not every child. All moved layers are one undo step.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['align', 'distribute', 'space'] },
        layers: { description: '"active" | "all" | layer id | array of ids.' },
        to: { type: 'string', description: 'align target: "canvas" (default), "selection", "safe", or a layer id.' },
        anchor: { type: 'string', enum: inspect.ANCHORS },
        axis: { type: 'string', enum: ['x', 'y'] },
        spacing: { type: 'number', description: 'Gap in pixels for space; omit for equal distribution.' },
        margin: { type: 'number', description: 'Safe-area inset in pixels.' },
        useInk: { type: 'boolean', description: 'Measure alpha-trimmed ink instead of the layer frame.' },
      },
      required: ['action'],
    },
    async run(args) {
      requireDocument();
      const action = String(args.action || 'align');
      const layers = resolveLayerList(args.layers === undefined ? 'active' : args.layers, { topLevel: true });
      if (!layers.length) {
        throw errorsModule.photoError('NOT_FOUND', 'No layers to lay out.', { field: 'layers' });
      }
      const boxes = [];
      for (const layer of layers) {
        const frame = frameOf(layer);
        if (args.useInk === true) {
          const ink = layer.kind === 'group' ? await groupInkBounds(layer) : await inkBoundsOf(layer);
          boxes.push(ink && ink.doc ? ink.doc : ink && !ink.empty ? ink : frame);
        } else {
          boxes.push(frame);
        }
      }
      const items = [];
      if (action === 'align') {
        const anchor = inspect.ANCHORS.indexOf(String(args.anchor)) === -1 ? 'center' : String(args.anchor);
        const targetName = args.to === undefined ? 'canvas' : String(args.to);
        let targetBox;
        if (targetName === 'canvas') targetBox = { x: 0, y: 0, width: document.canvas.width, height: document.canvas.height };
        else if (targetName === 'selection') {
          if (!document.selection || !document.selection.bounds) {
            throw errorsModule.photoError('NOT_FOUND', 'to: "selection" needs an active selection with bounds.', { field: 'to' });
          }
          targetBox = document.selection.bounds;
        } else if (targetName === 'safe') {
          const inset = Math.max(0, Math.round(Number(args.margin) || Math.round(Math.min(document.canvas.width, document.canvas.height) * 0.05)));
          targetBox = { x: inset, y: inset, width: Math.max(1, document.canvas.width - inset * 2), height: Math.max(1, document.canvas.height - inset * 2) };
        } else {
          const target = resolveLayer(targetName);
          targetBox = frameOf(target);
        }
        for (let index = 0; index < layers.length; index += 1) {
          const delta = inspect.alignDelta(boxes[index], targetBox, anchor, anchor);
          items.push({ layer: layers[index], delta: delta, before: boxes[index] });
        }
      } else {
        const axis = args.axis === 'y' || ['top', 'bottom', 'middle'].indexOf(String(args.anchor)) !== -1 ? 'y' : 'x';
        const result = inspect.distributeBoxes(boxes, axis, action === 'space' ? args.spacing : null);
        if (!result || !result.moves) {
          throw errorsModule.photoError('INVALID_ARGUMENT', action + ' needs at least two layers.', { field: 'layers', count: layers.length });
        }
        for (const move of result.moves) {
          const layer = layers[move.index];
          items.push({
            layer: layer,
            delta: axis === 'y' ? { x: 0, y: move.delta } : { x: move.delta, y: 0 },
            before: boxes[move.index],
          });
        }
        if (result.gap < 0) {
          throw errorsModule.photoError('OUT_OF_BOUNDS', 'The layers do not fit with a positive gap.', { gap: result.gap });
        }
      }
      const applied = [];
      for (const item of items) {
        if (!item.delta.x && !item.delta.y) continue;
        // Move by the layer's own offset, not its document frame: a group's
        // children already contribute their positions to the group frame, and
        // writing that frame back as the group offset would double-shift them.
        const raw = item.layer.offset || { x: 0, y: 0 };
        const before = { offset: { x: raw.x, y: raw.y } };
        const after = { offset: { x: raw.x + item.delta.x, y: raw.y + item.delta.y } };
        applied.push({ layer: item.layer, before: before, after: after });
      }
      if (!applied.length) {
        return toolResult(await statusPayload(false), 'Nothing to move: the layers are already aligned.', { no_op: true });
      }
      const summary = action + ' ' + applied.length + ' layer' + (applied.length === 1 ? '' : 's');
      commitLayerPropsMany(applied, summary, 'photo_layout');
      await refreshVisuals(true);
      const payload = await statusPayload(false);
      const moved = applied.map((item) => ({ id: item.layer.id, name: item.layer.name, offset: item.after.offset }));
      return toolResult(payload, textFor(payload) + ' · ' + summary, { moved: moved });
    },
  },
  {
    name: 'photo_diff',
    description:
      'Compare two revisions at preview resolution and report whether an edit actually changed pixels: changed bounding box, changed pixel percentage, MAE, RMSE, PSNR, global SSIM and mean luma delta, optionally with a heatmap. Uses the lossless per-revision renders, so a tiny real change is not hidden by JPEG noise. Defaults to comparing fromRevision with the current revision.',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        fromRevision: { type: 'number' },
        toRevision: { type: 'number', description: 'Defaults to the current revision.' },
        tolerance: { type: 'number', description: 'Per-channel difference ignored as encoding noise, 0–32 (default 2).' },
        includeHeatmap: { type: 'boolean' },
      },
      required: ['fromRevision'],
    },
    async run(args) {
      requireStore();
      requireDocument();
      const from = Math.round(Number(args.fromRevision));
      const to = args.toRevision === undefined ? document.revision : Math.round(Number(args.toRevision));
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw errorsModule.photoError('INVALID_ARGUMENT', 'fromRevision and toRevision must be numbers.', { field: 'fromRevision' });
      }
      if (!store.readRevisionRender(document.revision)) await refreshVisuals(true);
      let left = await renderAtRevision(from);
      let right = await renderAtRevision(to);
      if (!left || !right) {
        const available = store.revisionFiles().map((file) => file.revision).sort((a, b) => a - b);
        throw errorsModule.photoError(
          'MISSING_RESOURCE',
          'No cached render for that revision. Kept revisions: ' + (available.join(', ') || 'none') + '.',
          { available: available, retryable: false }
        );
      }
      if (left.width !== right.width || left.height !== right.height) {
        const resized = await engine.encode(left, {
          format: 'png',
          resize: { width: right.width, height: right.height },
        });
        left = await engine.decode(resized.buffer);
      }
      const metrics = inspect.diffRaws(left, right, { tolerance: args.tolerance === undefined ? 2 : args.tolerance });
      const scale = document.canvas.width ? right.width / document.canvas.width : 1;
      const payload = {
        fromRevision: from,
        toRevision: to,
        space: 'preview_px',
        scale: inspect.round(scale, 4),
        width: right.width,
        height: right.height,
        metrics: metrics,
        bboxDoc: metrics.bbox
          ? {
              x: Math.round(metrics.bbox.x / scale),
              y: Math.round(metrics.bbox.y / scale),
              width: Math.round(metrics.bbox.width / scale),
              height: Math.round(metrics.bbox.height / scale),
            }
          : null,
      };
      if (args.includeHeatmap !== false) {
        const heatmap = inspect.diffHeatmap(left, right);
        if (heatmap) {
          const encoded = await engine.encode(heatmap, { format: 'png' });
          payload.heatmap = 'data:image/png;base64,' + encoded.buffer.toString('base64');
        }
      }
      const text = metrics.sizeMismatch
        ? 'frames have different sizes'
        : metrics.changedPixels
          ? 'changed ' + metrics.changedPct + '% · RMSE ' + metrics.rmse + ' · SSIM ' + metrics.ssim
          : 'no visible change';
      return toolResult(payload, text);
    },
  },
  {
    name: 'photo_recipe',
    description:
      'Run a batch of PhotoNext tool calls as one plan. Each step is { tool, args, alias? }; an alias names a layer the step created, and a later step can refer to it as "$alias" anywhere in its arguments. By default every step becomes one undo group, so a ten-step composition is one user undo; `atomic: true` also undoes the steps already applied if a later step fails. Export, history and recipe calls are not allowed inside a recipe. Use it to collapse a multi-call composition into one round trip.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: { tool: { type: 'string' }, args: { type: 'object' }, alias: { type: 'string' } },
            required: ['tool'],
          },
        },
        atomic: { type: 'boolean', description: 'Undo applied steps if any step fails.' },
        undoGroup: { type: 'boolean', description: 'Make the whole plan one undo group (default true).' },
      },
      required: ['ops'],
    },
    async run(args) {
      requireDocument();
      const list = args.ops;
      if (!Array.isArray(list) || !list.length) {
        throw errorsModule.photoError('INVALID_ARGUMENT', 'photo_recipe needs a non-empty `ops` array.', { field: 'ops' });
      }
      if (list.length > 30) {
        throw errorsModule.photoError('LIMIT_EXCEEDED', 'A recipe holds at most 30 steps.', { limit: 30, requested: list.length });
      }
      const blocked = ['photo_recipe', 'photo_export', 'photo_history', 'photo_import', 'photo_font', 'photo_lut'];
      const aliases = {};
      const steps = [];
      const messages = [];
      const groupId = args.undoGroup === false ? null : documentModel.newId('group');
      const entryCountBefore = history.entries.length;
      const previousGroup = currentGroupId;
      if (groupId) currentGroupId = groupId;
      const substitute = (value) => {
        if (typeof value === 'string') {
          const exact = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
          if (exact) {
            if (!aliases[exact[1]]) {
              throw errorsModule.photoError('NOT_FOUND', 'No earlier recipe step created an alias "' + exact[1] + '".', {
                field: 'alias',
                allowed: Object.keys(aliases),
              });
            }
            return aliases[exact[1]];
          }
          return value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (match, name) => {
            if (!aliases[name]) {
              throw errorsModule.photoError('NOT_FOUND', 'No earlier recipe step created an alias "' + name + '".', {
                field: 'alias',
                allowed: Object.keys(aliases),
              });
            }
            return aliases[name];
          });
        }
        if (Array.isArray(value)) return value.map(substitute);
        if (value && typeof value === 'object') {
          const copy = {};
          for (const [key, entry] of Object.entries(value)) copy[key] = substitute(entry);
          return copy;
        }
        return value;
      };
      try {
        for (let index = 0; index < list.length; index += 1) {
          const step = list[index];
          if (!step || typeof step !== 'object' || typeof step.tool !== 'string') {
            throw errorsModule.photoError('INVALID_ARGUMENT', 'Recipe step ' + (index + 1) + ' needs a `tool`.', { field: 'ops[' + index + ']' });
          }
          if (blocked.indexOf(step.tool) !== -1) {
            throw errorsModule.photoError('UNSUPPORTED', 'Recipe step ' + (index + 1) + ' may not call ' + step.tool + '.', {
              field: 'ops[' + index + '].tool',
              allowed: blocked,
            });
          }
          const tool = TOOLS.find((candidate) => candidate.name === step.tool);
          if (!tool) {
            throw errorsModule.photoError('NOT_FOUND', 'Recipe step ' + (index + 1) + ' names no tool called "' + step.tool + '".', {
              field: 'ops[' + index + '].tool',
              suggested_call: { tool: 'photo_status', arguments: {} },
            });
          }
          const idsBefore = new Set(document.layers.map((layer) => layer.id));
          let stepArgs;
          try {
            stepArgs = substitute(step.args && typeof step.args === 'object' ? step.args : {});
            delete stepArgs.if_revision;
            delete stepArgs.op_id;
            await tool.run(stepArgs);
          } catch (error) {
            const structured = errorsModule.structured(error);
            structured.step = index + 1;
            structured.tool = step.tool;
            if (args.atomic === true && groupId) {
              const undone = await undoTillOutOfGroup(groupId);
              structured.undone_steps = undone;
            }
            throw errorsModule.photoError(structured.code, 'Recipe step ' + (index + 1) + ' (' + step.tool + ') failed: ' + structured.message, structured);
          }
          const created = document.layers.filter((layer) => !idsBefore.has(layer.id));
          if (step.alias && created.length) aliases[String(step.alias)] = created[0].id;
          const latest = document.activity[document.activity.length - 1];
          steps.push({
            index: index + 1,
            tool: step.tool,
            ok: true,
            alias: step.alias || null,
            createdIds: created.map((layer) => layer.id),
            summary: latest ? latest.summary : null,
          });
          if (latest && latest.summary) messages.push(latest.summary);
        }
      } finally {
        currentGroupId = previousGroup;
      }
      await refreshVisuals(true);
      const payload = await statusPayload(false);
      const createdTotal = history.entries.length - entryCountBefore;
      return toolResult(payload, 'recipe · ' + steps.length + ' steps · ' + createdTotal + ' history entr' + (createdTotal === 1 ? 'y' : 'ies'), {
        recipe: { steps: steps, aliases: aliases, groupId: groupId, undoGroup: Boolean(groupId) },
      });
    },
  },
  {
    name: 'photo_lut',
    description:
      'Install and manage 3D colour lookup tables (.cube) for grading. `install` copies an absolute .cube path into extension storage (2–65 cube size, up to 32 MB) and returns its name; `list` shows installed looks; `show` reports one; `remove` deletes one. Apply a look with photo_adjust adjustments: [{ "type": "lut3d", "name": "<name>", "intensity": 100 }]. The LUT travels with the document, so the same file reproduces the same grade anywhere.',
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['install', 'list', 'show', 'remove'] },
        path: { type: 'string', description: 'Absolute .cube path for install.' },
        name: { type: 'string', description: 'Look name. Defaults to the TITLE or file name.' },
        replace: { type: 'boolean', description: 'Replace an installed look with the same name.' },
      },
      required: ['action'],
    },
    async run(args) {
      requireStore();
      const action = String(args.action || 'list');
      if (action === 'list') {
        const looks = lutModule.list();
        return toolResult(
          { luts: looks },
          looks.length ? 'installed LUTs: ' + looks.map((look) => look.name).join(', ') : 'no LUTs installed'
        );
      }
      if (action === 'install') {
        if (args.path === undefined) {
          throw errorsModule.photoError('INVALID_ARGUMENT', 'photo_lut install needs an absolute `path`.', { field: 'path' });
        }
        const source = requireAbsolutePath(args.path, 'path');
        const entry = lutModule.installFromPath(source, {
          name: args.name,
          replace: args.replace === true,
        });
        return toolResult(
          { lut: entry, luts: lutModule.list() },
          'installed LUT "' + entry.name + '" · ' + entry.size + '³ · ' + Math.round(entry.bytes / 1024) + ' KB',
          { next_actions: [{ tool: 'photo_adjust', arguments: { adjustments: [{ type: 'lut3d', lut: entry.name }] } }] }
        );
      }
      if (action === 'show') {
        const entry = lutModule.list().find(
          (look) => String(look.name).toLowerCase() === String(args.name || '').toLowerCase()
        );
        if (!entry) {
          throw errorsModule.photoError('NOT_FOUND', 'No LUT called "' + String(args.name || '') + '".', {
            field: 'name',
            allowed: lutModule.list().map((look) => look.name),
          });
        }
        return toolResult({ lut: entry }, entry.name + ' · ' + entry.size + '³ · ' + entry.bytes + ' bytes');
      }
      if (action === 'remove') {
        const removed = lutModule.remove(args.name);
        if (!removed) {
          throw errorsModule.photoError('NOT_FOUND', 'No LUT called "' + String(args.name || '') + '".', {
            field: 'name',
            allowed: lutModule.list().map((look) => look.name),
          });
        }
        return toolResult({ luts: lutModule.list() }, 'removed LUT "' + String(args.name) + '"');
      }
      throw errorsModule.photoError('INVALID_ARGUMENT', 'photo_lut takes action install, list, show or remove.', {
        field: 'action',
        allowed: ['install', 'list', 'show', 'remove'],
      });
    },
  },
  {
    name: 'photo_status',
    description:
      'Read the document without changing it: dimensions, format, layer tree (raster and adjustment layers, blend mode, opacity, mask, styles), selection, histogram, history depth, blend modes, supported adjustments, capabilities, budgets, recent activity, last export, and (when the revision changed) a preview data URL. The PhotoNext panel polls this; the agent can use it to verify an edit instead of assuming it worked.',
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        sinceRevision: {
          type: 'number',
          description: 'Return the preview only when the document is newer than this revision.',
        },
      },
    },
    async run(args) {
      const since = Number(args.sinceRevision);
      const includePreview = !Number.isFinite(since) || since !== document.revision;
      const payload = await statusPayload(includePreview);
      return toolResult(payload);
    },
  },
];

// Every tool accepts the same two control fields: a revision guard and a retry
// key. Injecting them once keeps the twenty-odd schemas honest instead of
// relying on each one to remember.
for (const tool of TOOLS) {
  if (!tool.inputSchema.properties) tool.inputSchema.properties = {};
  tool.inputSchema.properties.if_revision = {
    type: 'number',
    description: 'Reject this call with REVISION_CONFLICT unless the document is still at this revision.',
  };
  tool.inputSchema.properties.op_id = {
    type: 'string',
    description: 'Idempotency key: repeating a call with the same op_id returns the first result instead of applying it twice.',
  };
}

// ---------------------------------------------------------------------------
// MCP over stdio: Content-Length framing, tools/list and tools/call
// ---------------------------------------------------------------------------

let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function descriptor(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: tool.readOnly === true,
    requiresApproval: tool.requiresApproval ?? tool.readOnly !== true,
  };
}

/**
 * The uniform result envelope.
 *
 * Every call answers the same small set of questions — where was I, where am I,
 * what changed, did anything change at all — so a model updates its world model
 * in one step instead of re-reading the document after each edit.
 */
function envelopeFor(tool, beforeSnapshot, beforeRevision) {
  const afterSnapshot = inspect.snapshotDocument(document);
  const delta = inspect.diffSnapshots(beforeSnapshot, afterSnapshot);
  const warnings = [];
  for (const layer of delta.added.concat(delta.changed)) {
    const target = documentModel.layerById(document, layer.id);
    if (!target) continue;
    if (target.visible === false) {
      warnings.push('Layer "' + target.name + '" is hidden, so this edit is not visible in the composite.');
    } else if (Number(target.opacity) === 0) {
      warnings.push('Layer "' + target.name + '" has zero opacity, so this edit is not visible.');
    }
  }
  if (!tool.readOnly && delta.no_op) {
    warnings.push('No pixel, layer or selection change was recorded. Check the target layer is visible and the values differ from the current ones.');
  }
  const latestEntry = history.entries[history.entries.length - 1];
  const undoGroup =
    latestEntry && latestEntry.groupId && latestEntry.revisionAfter === document.revision
      ? latestEntry.groupId
      : null;
  return {
    ok: true,
    revision_before: beforeRevision,
    revision_after: document.revision,
    changed: delta.changed.map((layer) => ({ id: layer.id, name: layer.name, reasons: layer.reasons, frame: layer.frame })),
    created_ids: delta.added.map((layer) => layer.id),
    removed_ids: delta.removed.map((layer) => layer.id),
    selection_changed: delta.selectionChanged,
    no_op: delta.no_op,
    warnings: warnings,
    undo_group: undoGroup,
    next_actions: !tool.readOnly && delta.no_op
      ? [{ tool: 'photo_describe', arguments: { detail: 'summary' } }]
      : [],
  };
}

async function callTool(id, params) {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    replyError(id, -32602, 'Unknown tool: ' + (name || '(none given)'));
    return;
  }
  const raw = params.arguments;
  const args = Object.assign({}, raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});

  // Concurrency guard and retry key are part of every tool's contract, but they
  // are not arguments of the operation itself.
  const ifRevision = args.if_revision === undefined ? null : Number(args.if_revision);
  delete args.if_revision;
  const opId = typeof args.op_id === 'string' && args.op_id.trim() ? args.op_id.trim().slice(0, 120) : null;
  delete args.op_id;

  if (ifRevision !== null) {
    if (!Number.isFinite(ifRevision)) {
      const structured = errorsModule.structured(
        errorsModule.photoError('INVALID_ARGUMENT', 'if_revision must be a revision number.', {
          field: 'if_revision',
          received: raw && raw.if_revision,
        })
      );
      reply(id, {
        content: [{ type: 'text', text: structured.message }],
        structuredContent: { ok: false, revision: document.revision, error: structured },
        isError: true,
      });
      return;
    }
    if (ifRevision !== document.revision) {
      const snapshot = documentModel.revisionSnapshot(document, ifRevision);
      const delta = snapshot
        ? inspect.diffSnapshots(snapshot, inspect.snapshotDocument(document))
        : null;
      const current = inspect.snapshotDocument(document);
      const changed = delta
        ? delta.changed.map((layer) => ({ id: layer.id, name: layer.name, reasons: layer.reasons }))
        : (current.layers || []).map((layer) => ({ id: layer.id, name: layer.name, reasons: ['unknown'] }));
      const structured = errorsModule.structured(
        errorsModule.photoError(
          'REVISION_CONFLICT',
          'The document changed since revision ' +
            ifRevision +
            '; it is now revision ' +
            document.revision +
            '. Re-read it and retry.',
          {
            current_revision: document.revision,
            expected_revision: ifRevision,
            changed: changed,
            retryable: true,
            suggested_call: { tool: 'photo_delta', arguments: { sinceRevision: ifRevision } },
          }
        )
      );
      reply(id, {
        content: [{ type: 'text', text: structured.message }],
        structuredContent: { ok: false, revision: document.revision, error: structured },
        isError: true,
      });
      return;
    }
  }

  if (opId && opCache.has(name + '\u0000' + opId)) {
    const cached = JSON.parse(opCache.get(name + '\u0000' + opId));
    reply(id, cached);
    return;
  }

  const beforeSnapshot = inspect.snapshotDocument(document);
  const beforeRevision = document.revision;
  let pointer = null;
  try {
    // Publish the geometry before the pixels are written so a status poll can
    // start the cursor while a slow draw is still running. Import and history
    // describe the document after it changes, so they are computed below.
    if (name !== 'photo_import' && name !== 'photo_history') {
      try {
        const described = pointerModule.describe(name, args, document);
        if (described) {
          pointer = Object.assign({}, described, { id: 'pointer-' + ++pointerSerial });
        }
      } catch {
        pointer = null;
      }
    }
    activePointer = pointer;

    const result = await tool.run(args);

    // Attach where this call worked so the panel's pointer can follow it. The
    // activity entry was written by the tool itself; a pointer is decoration and
    // must never turn a successful edit into a failed tool call.
    try {
      if (!pointer) {
        const described = pointerModule.describe(name, args, document);
        if (described) {
          pointer = Object.assign({}, described, { id: 'pointer-' + ++pointerSerial });
        }
      }
      const latest = document.activity[document.activity.length - 1];
      if (pointer && latest && latest.tool === name) {
        latest.pointer = pointer;
        persist();
      }
    } catch {
      /* a pointer is optional */
    }
    activePointer = null;

    const structured =
      result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)
        ? Object.assign({}, result.structuredContent, envelopeFor(tool, beforeSnapshot, beforeRevision))
        : Object.assign({}, result.structuredContent === undefined ? {} : { value: result.structuredContent }, envelopeFor(tool, beforeSnapshot, beforeRevision));
    const response = {
      content: result.content || [],
      structuredContent: structured,
      ...(result.isError ? { isError: true } : {}),
    };
    if (opId) {
      if (opCache.size >= OP_CACHE_LIMIT) opCache.delete(opCache.keys().next().value);
      opCache.set(name + '\u0000' + opId, JSON.stringify(response));
    }
    reply(id, response);
  } catch (error) {
    activePointer = null;
    const message = messageOf(error);
    log('error', message);
    const structured = errorsModule.structured(error);
    reply(id, {
      content: [{ type: 'text', text: message }],
      structuredContent: { ok: false, revision: document.revision, error: structured },
      isError: true,
    });
  }
}

function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const method = message.method;
  const params =
    message.params && typeof message.params === 'object' && !Array.isArray(message.params)
      ? message.params
      : {};

  if (typeof method === 'string') {
    if (message.id === undefined || message.id === null) {
      if (method === 'exit') process.exit(0);
      return;
    }
    switch (method) {
      case 'initialize':
        reply(message.id, {
          protocolVersion:
            typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'photonext', version: '0.14.0' },
          instructions:
            'PhotoNext works on one document at a time: layers with blend modes and masks, a selection, non-destructive adjustment layers, vector drawing, 3D model compositing and an undo history. Read with photo_describe (not photo_status) and resolve layers with photo_find before editing; pass if_revision to reject a stale edit and op_id to make a retry safe. Every result carries revision_before/after, changed layers and created_ids. Verify pixels with photo_diff, geometry with photo_bounds, baked type with photo_measure_text, editable type with photo_text and a deliverable with photo_preflight. Batch a composition with photo_recipe: aliases name created layers, and the whole plan is one undo group.',
        });
        return;
      case 'tools/list':
        reply(message.id, { tools: TOOLS.map(descriptor) });
        return;
      case 'tools/call':
        void callTool(message.id, params);
        return;
      case 'ping':
        reply(message.id, {});
        return;
      case 'shutdown':
        reply(message.id, {});
        return;
      default:
        replyError(message.id, -32601, "PhotoNext does not implement '" + method + "'.");
        return;
    }
  }
}

function findHeaderEnd(chunk) {
  for (let index = 0; index < chunk.length; index += 1) {
    if (
      chunk[index] === 13 &&
      chunk[index + 1] === 10 &&
      chunk[index + 2] === 13 &&
      chunk[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = findHeaderEnd(buffer);
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    try {
      handle(JSON.parse(body));
    } catch (error) {
      log('error', 'unreadable message: ' + messageOf(error));
    }
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (error) => {
  log('error', 'uncaught: ' + messageOf(error));
});
