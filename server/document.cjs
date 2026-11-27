/*
 * The document, not the working copy.
 *
 * Almost every Photoshop-shaped feature is an operation on a document: a layer
 * stack, a selection, a history, canvas metadata. M1 introduces that shape while
 * the surface still has the four original tools, so the model can be tested on
 * its own before any new tool depends on it.
 *
 * No I/O here on purpose: sizes, limits, ids, the layer tree and the activity
 * log are arithmetic, and arithmetic is what a unit test can pin.
 */
'use strict';

const inspect = require('./inspect.cjs');
const stylesModule = require('./styles.cjs');
const textModule = require('./text.cjs');

const LIMITS = {
  maxCanvasEdge: 12000,
  maxPixels: 80000000,
  maxLayers: 20,
};

// Enough to answer "what changed since revision N" for a long working session
// without letting the sidecar grow without bound. Each entry is a few hundred
// bytes per layer; the pixels live in the history snapshots, not here.
const MAX_REVISIONS = 80;

function isoNow() {
  return new Date().toISOString();
}

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function emptyDocument() {
  return {
    format: 'mnphoto-document',
    version: 1,
    id: newId('doc'),
    canvas: { width: 0, height: 0 },
    background: 'transparent',
    layers: [],
    activeLayerId: null,
    // The live selection is one mask; named slots keep masks the agent saved.
    selection: null,
    selections: {},
    // A 3D scene is metadata on this document, not a second document. The
    // rendered object is still an ordinary raster layer and history entry.
    scene: null,
    metadata: { createdAt: isoNow(), sourceName: null, sourceFormat: null },
    activity: [],
    // Compact snapshots, one per revision, for delta inspection. A snapshot is
    // metadata only: it never duplicates pixels or masks.
    revisions: [],
    revision: 0,
    updatedAt: null,
  };
}

/**
 * One raster layer. `file` is relative to the extension's data directory, so a
 * document never carries an absolute path that a moved store would break.
 */
function rasterLayer(options) {
  const pixels = {
    file: options.file,
    width: Math.round(Number(options.width)),
    height: Math.round(Number(options.height)),
    format: options.format || 'png',
  };
  return {
    id: options.id || newId('layer'),
    name: String(options.name || 'Layer 1'),
    kind: 'raster',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    offset: { x: 0, y: 0 },
    pixels: pixels,
    mask: null,
    styles: [],
    parentId: null,
  };
}

/**
 * One adjustment layer. It has no pixels of its own: the stack is the layer,
 * and flatten applies it to everything below. That is what makes it cheap to
 * undo and trivial to replay.
 */
function adjustmentLayer(options) {
  return {
    id: options.id || newId('layer'),
    name: String(options.name || 'Adjustment'),
    kind: 'adjustment',
    visible: options.visible !== false,
    locked: false,
    opacity: options.opacity === undefined ? 1 : Number(options.opacity),
    blendMode: options.blendMode || 'normal',
    offset: { x: 0, y: 0 },
    pixels: null,
    adjustments: Array.isArray(options.adjustments) ? options.adjustments : [],
    summary: options.summary || null,
    mask: null,
    styles: [],
    parentId: null,
  };
}

/**
 * A group is a compositing container, not a second document. It has no pixels
 * of its own: children point at it through `parentId`, they are rendered into
 * an isolated transparent buffer in stack order, and that buffer is then
 * composited with the group's blend mode, opacity and mask. Groups can nest.
 *
 * The group owns an `offset` that is added to every descendant at render time,
 * so moving a group is one property change instead of N child edits.
 */
function groupLayer(options) {
  return {
    id: options.id || newId('layer'),
    name: String(options.name || 'Group'),
    kind: 'group',
    visible: options.visible !== false,
    locked: false,
    opacity: options.opacity === undefined ? 1 : Number(options.opacity),
    blendMode: options.blendMode || 'normal',
    offset: { x: 0, y: 0 },
    pixels: null,
    mask: null,
    styles: [],
    parentId: options.parentId || null,
  };
}

/**
 * An editable text layer. It stores type, not pixels: the engine rasterises it
 * at composite time, so changing the string or a font field is a field edit and
 * undo replays the old record instead of restoring a cached bitmap.
 *
 * The baseline sits at the layer offset, matching photo_draw and photo_text.
 * Rotation and scale are part of the record; the frame is the rotated ink box.
 */
function textLayer(options) {
  const settings = options || {};
  const text = textModule.normalize(settings.text || settings, settings.previousText || null);
  return {
    id: settings.id || newId('layer'),
    name: String(settings.name || textModule.summary(text)),
    kind: 'text',
    visible: settings.visible !== false,
    locked: false,
    opacity: settings.opacity === undefined ? 1 : Number(settings.opacity),
    blendMode: settings.blendMode || 'normal',
    offset: {
      x: Math.round(Number(settings.x) || 0),
      y: Math.round(Number(settings.y) || 0),
    },
    pixels: null,
    text: text,
    mask: null,
    styles: [],
    parentId: settings.parentId || null,
  };
}

/** A named error, because "too big" without the limit is not actionable. */
function assertCanvas(width, height) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    throw new Error(
      'The image reports an unusable size (' + width + '×' + height + '). Nothing was changed.'
    );
  }
  if (w > LIMITS.maxCanvasEdge || h > LIMITS.maxCanvasEdge) {
    throw new Error(
      'The image is ' +
        w +
        '×' +
        h +
        ', beyond the ' +
        LIMITS.maxCanvasEdge +
        '-pixel edge limit. Nothing was changed.'
    );
  }
  const megapixels = (w * h) / 1e6;
  if (w * h > LIMITS.maxPixels) {
    throw new Error(
      'The image is ' +
        w +
        '×' +
        h +
        ' (' +
        Math.round(megapixels) +
        ' MP), beyond the ' +
        LIMITS.maxPixels / 1e6 +
        ' MP document budget. Nothing was changed.'
    );
  }
  return { width: w, height: h };
}

function fromImport(options) {
  const document = emptyDocument();
  document.canvas = assertCanvas(options.width, options.height);
  document.metadata.sourceName = options.name || null;
  document.metadata.sourceFormat = options.format || null;
  addLayer(
    document,
    rasterLayer({
      file: options.file,
      width: document.canvas.width,
      height: document.canvas.height,
      format: options.format,
      name: options.name || 'Background',
    })
  );
  return document;
}

function layerById(document, id) {
  return document.layers.find((layer) => layer.id === id) || null;
}

function groupMembers(document, groupId) {
  return document.layers.filter((layer) => layer.parentId === groupId);
}

/** How deep a layer sits. A top-level layer is 0; a child of one group is 1. */
function depthOf(document, layer) {
  let depth = 0;
  let current = layer;
  const seen = new Set();
  while (current && current.parentId) {
    if (seen.has(current.parentId)) break;
    seen.add(current.parentId);
    const parent = layerById(document, current.parentId);
    if (!parent || parent.kind !== 'group') break;
    depth += 1;
    current = parent;
  }
  return depth;
}

/** True when `candidateId` is `ancestorId` or sits underneath it. */
function isWithin(document, candidateId, ancestorId) {
  let current = layerById(document, candidateId);
  const seen = new Set();
  while (current) {
    if (current.id === ancestorId) return true;
    if (!current.parentId || seen.has(current.parentId)) return false;
    seen.add(current.parentId);
    current = layerById(document, current.parentId);
  }
  return false;
}

/** Every layer under a group, recursively. */
function descendantsOf(document, groupId) {
  return document.layers.filter(
    (layer) => layer.id !== groupId && isWithin(document, layer.id, groupId)
  );
}

/**
 * The offset contributed by a layer's group ancestors. Raster pixels and the
 * group's own `offset` compose additively; a group frame therefore includes
 * its own offset through its children, without double-counting it.
 */
function ancestorOffset(document, layer) {
  let x = 0;
  let y = 0;
  let current = layer;
  const seen = new Set();
  while (current && current.parentId) {
    if (seen.has(current.parentId)) break;
    seen.add(current.parentId);
    const parent = layerById(document, current.parentId);
    if (!parent || parent.kind !== 'group') break;
    x += Math.round(Number(parent.offset && parent.offset.x) || 0);
    y += Math.round(Number(parent.offset && parent.offset.y) || 0);
    current = parent;
  }
  return { x: x, y: y };
}

/**
 * Document-space frame. For a group it is the union of its descendants' frames,
 * so alignment, bounds and hit-testing treat the group as one object. Returns a
 * zero-size box at the group anchor for an empty group rather than null, so a
 * caller never has to special-case "no pixels yet".
 */
function frameOf(document, layer, seen) {
  if (!layer) return null;
  const visited = seen || new Set();
  if (visited.has(layer.id)) return inspect.frameOf(layer);
  visited.add(layer.id);
  if (layer.kind === 'group') {
    const frames = groupMembers(document, layer.id)
      .map((member) => frameOf(document, member, visited))
      .filter(Boolean);
    const union = inspect.unionBoxes(frames);
    if (union) return union;
    const offset = ancestorOffset(document, layer);
    return {
      x: Math.round(offset.x + (Number(layer.offset && layer.offset.x) || 0)),
      y: Math.round(offset.y + (Number(layer.offset && layer.offset.y) || 0)),
      width: 0,
      height: 0,
    };
  }
  const base =
    layer.kind === 'text' && layer.text
      ? (() => {
          const bounds = textModule.layout(layer.text);
          return {
            x: (Math.round(Number(layer.offset && layer.offset.x) || 0) + bounds.x),
            y: (Math.round(Number(layer.offset && layer.offset.y) || 0) + bounds.y),
            width: bounds.width,
            height: bounds.height,
          };
        })()
      : inspect.frameOf(layer);
  const offset = ancestorOffset(document, layer);
  return {
    x: Math.round(base.x + offset.x),
    y: Math.round(base.y + offset.y),
    width: base.width,
    height: base.height,
  };
}

/** Layers that composite directly into the document, not inside a group. */
function topLevelLayers(document) {
  return document.layers.filter((layer) => {
    if (!layer.parentId) return true;
    const parent = layerById(document, layer.parentId);
    return !parent || parent.kind !== 'group';
  });
}

function activeLayer(document) {
  return (
    layerById(document, document.activeLayerId) ||
    document.layers.find((layer) => layer.visible) ||
    document.layers[0] ||
    null
  );
}

function addLayer(document, layer) {
  if (document.layers.length >= LIMITS.maxLayers) {
    throw new Error(
      'A document holds at most ' +
        LIMITS.maxLayers +
        ' layers; this one already has ' +
        document.layers.length +
        '. Nothing was changed.'
    );
  }
  document.layers.push(layer);
  document.activeLayerId = layer.id;
  return layer;
}

/** Remove a layer, keeping an active layer selected. Returns false if absent. */
function removeLayer(document, id) {
  const index = document.layers.findIndex((layer) => layer.id === id);
  if (index === -1) return false;
  document.layers.splice(index, 1);
  if (document.activeLayerId === id) {
    const next = document.layers[index] || document.layers[index - 1] || null;
    document.activeLayerId = next ? next.id : null;
  }
  bumpRevision(document);
  return true;
}

/** What `photo_status` reports: the tree without the pixel buffers. */
function layerTree(document) {
  return document.layers.map((layer, index) => {
    const frame = frameOf(document, layer);
    return {
    index,
    id: layer.id,
    name: layer.name,
    kind: layer.kind,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    offset: layer.offset,
    parentId: layer.parentId || null,
    depth: depthOf(document, layer),
    children: layer.kind === 'group' ? groupMembers(document, layer.id).length : 0,
    width:
      layer.kind === 'group' || layer.kind === 'text'
        ? frame
          ? frame.width
          : 0
        : layer.pixels
          ? layer.pixels.width
          : 0,
    height:
      layer.kind === 'group' || layer.kind === 'text'
        ? frame
          ? frame.height
          : 0
        : layer.pixels
          ? layer.pixels.height
          : 0,
    text:
      layer.kind === 'text' && layer.text
        ? Object.assign(textModule.describe(layer.text), {
            transform: {
              x: Math.round(Number(layer.offset && layer.offset.x) || 0),
              y: Math.round(Number(layer.offset && layer.offset.y) || 0),
              rotation: layer.text.rotation,
              scale: layer.text.scale,
            },
          })
        : null,
    adjustments:
      layer.kind === 'adjustment' && Array.isArray(layer.adjustments) ? layer.adjustments.length : 0,
    summary: layer.summary || null,
    styles: (layer.styles || []).map(stylesModule.describeStyle),
    styleCount: (layer.styles || []).filter((style) => style.enabled !== false).length,
    mask: layer.mask
      ? {
          feather: layer.mask.feather || 0,
          inverted: layer.mask.inverted === true,
          width: layer.mask.width || 0,
          height: layer.mask.height || 0,
        }
      : null,
    active: layer.id === document.activeLayerId,
    };
  });
}

/** Reorder a layer to an absolute stack index (0 = bottom). */
function moveLayer(document, id, index) {
  const current = document.layers.findIndex((layer) => layer.id === id);
  if (current === -1) return false;
  const target = Math.max(0, Math.min(document.layers.length - 1, Math.round(Number(index)) || 0));
  const [layer] = document.layers.splice(current, 1);
  document.layers.splice(target, 0, layer);
  bumpRevision(document);
  return true;
}

/** A content change: bump the revision so the polled preview refreshes once. */
function bumpRevision(document) {
  document.revision += 1;
  document.updatedAt = isoNow();
  if (!Array.isArray(document.revisions)) document.revisions = [];
  const snapshot = inspect.snapshotDocument(document);
  const last = document.revisions[document.revisions.length - 1];
  if (last && last.revision === snapshot.revision) document.revisions.pop();
  document.revisions.push(snapshot);
  if (document.revisions.length > MAX_REVISIONS) {
    document.revisions.splice(0, document.revisions.length - MAX_REVISIONS);
  }
}

/** The snapshot recorded at a revision, or the nearest earlier one. */
function revisionSnapshot(document, revision) {
  const target = Math.round(Number(revision));
  if (!Number.isFinite(target)) return null;
  const list = Array.isArray(document.revisions) ? document.revisions : [];
  let best = null;
  for (const snapshot of list) {
    if (snapshot.revision === target) return snapshot;
    if (snapshot.revision <= target && (!best || snapshot.revision > best.revision)) best = snapshot;
  }
  return best;
}

/** Record the last operations for the panel, including ones history cannot undo. */
function recordActivity(document, tool, summary) {
  document.activity.push({ at: isoNow(), tool: tool, summary: summary });
  if (document.activity.length > 40) document.activity = document.activity.slice(-40);
  bumpRevision(document);
}

module.exports = {
  LIMITS: LIMITS,
  MAX_REVISIONS: MAX_REVISIONS,
  revisionSnapshot: revisionSnapshot,
  addLayer: addLayer,
  adjustmentLayer: adjustmentLayer,
  activeLayer: activeLayer,
  ancestorOffset: ancestorOffset,
  depthOf: depthOf,
  descendantsOf: descendantsOf,
  frameOf: frameOf,
  groupLayer: groupLayer,
  groupMembers: groupMembers,
  isWithin: isWithin,
  topLevelLayers: topLevelLayers,
  assertCanvas: assertCanvas,
  bumpRevision: bumpRevision,
  emptyDocument: emptyDocument,
  fromImport: fromImport,
  isoNow: isoNow,
  layerById: layerById,
  layerTree: layerTree,
  moveLayer: moveLayer,
  newId: newId,
  rasterLayer: rasterLayer,
  textLayer: textLayer,
  recordActivity: recordActivity,
  removeLayer: removeLayer,
};
