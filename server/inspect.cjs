/*
 * Inspection arithmetic: geometry, layer addressing, ink bounds, diffs.
 *
 * None of this touches the process state, the filesystem or the renderer. That
 * is the point — the questions that make an agent loop trustworthy ("where is
 * this layer really", "which layer did they mean", "did that edit change a
 * pixel") are arithmetic over a raw RGBA buffer and a layer list, and arithmetic
 * is what a unit test can pin exactly.
 *
 * Coordinates are document pixels unless a function name says `norm` or `local`.
 * Top-left origin, y down, which is the same space every drawing and selection
 * tool already uses.
 */
'use strict';

const stylesModule = require('./styles.cjs');
const textModule = require('./text.cjs');

const CHANNELS = 4;

function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function round(value, places) {
  const factor = Math.pow(10, places === undefined ? 2 : places);
  return Math.round(value * factor) / factor;
}

/** Accept {x,y,width,height}, {x,y,w,h} or [x,y,w,h]. */
function toRect(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 4) {
    return {
      x: Number(value[0]) || 0,
      y: Number(value[1]) || 0,
      width: Number(value[2]) || 0,
      height: Number(value[3]) || 0,
    };
  }
  if (typeof value === 'object') {
    return {
      x: Number(value.x) || 0,
      y: Number(value.y) || 0,
      width: Number(value.width !== undefined ? value.width : value.w) || 0,
      height: Number(value.height !== undefined ? value.height : value.h) || 0,
    };
  }
  return null;
}

function clampRect(rect, canvas) {
  const box = toRect(rect);
  if (!box || !canvas) return null;
  const x = Math.max(0, Math.min(canvas.width, Math.round(box.x)));
  const y = Math.max(0, Math.min(canvas.height, Math.round(box.y)));
  const right = Math.max(x + 1, Math.min(canvas.width, Math.round(box.x + box.width)));
  const bottom = Math.max(y + 1, Math.min(canvas.height, Math.round(box.y + box.height)));
  return { x: x, y: y, width: right - x, height: bottom - y };
}

/** A layer's frame in document space: its own pixels plus its offset. */
function frameOf(layer) {
  if (!layer) return null;
  const offset = layer.offset || { x: 0, y: 0 };
  if (layer.kind === 'text' && layer.text) {
    const bounds = textModule.layout(layer.text);
    return {
      x: Math.round(Number(offset.x) || 0) + bounds.x,
      y: Math.round(Number(offset.y) || 0) + bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  }
  const pixels = layer.pixels || null;
  const width = pixels ? Number(pixels.width) || 0 : Number(layer.width) || 0;
  const height = pixels ? Number(pixels.height) || 0 : Number(layer.height) || 0;
  return {
    x: Math.round(Number(offset.x) || 0),
    y: Math.round(Number(offset.y) || 0),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function isEmptyBox(box) {
  return !box || !(box.width > 0) || !(box.height > 0);
}

function unionBoxes(boxes) {
  const valid = (boxes || []).filter((box) => !isEmptyBox(box));
  if (!valid.length) return null;
  const left = Math.min.apply(null, valid.map((box) => box.x));
  const top = Math.min.apply(null, valid.map((box) => box.y));
  const right = Math.max.apply(null, valid.map((box) => box.x + box.width));
  const bottom = Math.max.apply(null, valid.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function intersectBoxes(left, right) {
  if (isEmptyBox(left) || isEmptyBox(right)) return null;
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) return null;
  return { x: x, y: y, width: rightEdge - x, height: bottomEdge - y };
}

/** A box in 0..1 document space, so a model can reason independently of size. */
function normBox(box, canvas) {
  if (isEmptyBox(box) || !canvas || !canvas.width || !canvas.height) return null;
  return {
    x: round(box.x / canvas.width, 4),
    y: round(box.y / canvas.height, 4),
    width: round(box.width / canvas.width, 4),
    height: round(box.height / canvas.height, 4),
  };
}

const ANCHORS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
];

function anchorPoint(anchor, box) {
  const name = ANCHORS.indexOf(anchor) === -1 ? 'center' : anchor;
  const left = box.x;
  const centreX = box.x + box.width / 2;
  const right = box.x + box.width;
  const top = box.y;
  const centreY = box.y + box.height / 2;
  const bottom = box.y + box.height;
  const x = name.indexOf('left') !== -1 ? left : name.indexOf('right') !== -1 ? right : centreX;
  const y = name.indexOf('top') !== -1 ? top : name.indexOf('bottom') !== -1 ? bottom : centreY;
  return { x: round(x, 2), y: round(y, 2) };
}

/**
 * The offset delta that moves `box` so its named anchor meets `target`'s named
 * anchor. `anchor` and `targetAnchor` default to the same edge, which is what
 * "align these layers left" means.
 */
function alignDelta(box, target, anchor, targetAnchor) {
  const from = anchorPoint(anchor || 'center', box);
  const to = anchorPoint(targetAnchor || anchor || 'center', target);
  return { x: Math.round(to.x - from.x), y: Math.round(to.y - from.y) };
}

/** Where a canvas-relative anchor sits, e.g. `safe.center` or `top-left`. */
function canvasAnchor(anchor, canvas, margin) {
  const pad = Math.max(0, Number(margin) || 0);
  const box = {
    x: pad,
    y: pad,
    width: Math.max(1, canvas.width - pad * 2),
    height: Math.max(1, canvas.height - pad * 2),
  };
  return anchorPoint(String(anchor || 'center').replace(/^safe[.-]/, ''), box);
}

/**
 * Alpha-trimmed ink bounds in the buffer's own pixel space.
 *
 * Frame bounds answer "where is the layer"; ink bounds answer "where is the
 * visible thing". Centring a logo by its frame is a classic agent error because
 * transparent padding is part of the frame.
 */
function alphaBounds(raw, options) {
  const settings = options || {};
  const threshold = Math.max(0, Math.min(255, Number(settings.threshold) || 0));
  const { data, width, height } = raw;
  const channels = raw.channels || CHANNELS;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let covered = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(row + x) * channels + 3];
      if (alpha <= threshold) continue;
      covered += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < left || bottom < top) {
    return { x: 0, y: 0, width: 0, height: 0, coverage: 0, empty: true };
  }
  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
    coverage: round(covered / (width * height), 4),
    empty: false,
  };
}

/** A deterministic identity for "did this layer change" without hashing bytes. */
function fingerprint(layer) {
  if (!layer) return '';
  const pixels = layer.pixels || {};
  const mask = layer.mask || {};
  const adjustments = Array.isArray(layer.adjustments) ? layer.adjustments : [];
  return [
    layer.name,
    layer.kind,
    layer.visible ? 1 : 0,
    layer.locked ? 1 : 0,
    round(Number(layer.opacity) || 0, 3),
    layer.blendMode,
    layer.offset ? Math.round(Number(layer.offset.x) || 0) : 0,
    layer.offset ? Math.round(Number(layer.offset.y) || 0) : 0,
    layer.parentId || '',
    pixels.file || '',
    pixels.width || 0,
    pixels.height || 0,
    mask.file || '',
    mask.inverted ? 1 : 0,
    adjustments.length,
    Array.isArray(layer.effects) ? layer.effects.length : 0,
    stylesModule.stylesSignature(layer.styles),
    layer.kind === 'text' ? textModule.signature(layer.text) : '',
  ].join('|');
}

/** The offset contributed by group ancestors, for snapshot geometry. */
function snapshotAncestorOffset(document, layer) {
  let x = 0;
  let y = 0;
  let current = layer;
  const seen = new Set();
  while (current && current.parentId) {
    if (seen.has(current.parentId)) break;
    seen.add(current.parentId);
    const parent = (document.layers || []).find((candidate) => candidate.id === current.parentId);
    if (!parent || parent.kind !== 'group') break;
    x += Math.round(Number(parent.offset && parent.offset.x) || 0);
    y += Math.round(Number(parent.offset && parent.offset.y) || 0);
    current = parent;
  }
  return { x: x, y: y };
}

/** Document-space frame including group offsets and group unions. */
function snapshotFrame(document, layer, seen) {
  if (!layer) return null;
  if (layer.kind === 'group') {
    const visited = seen || new Set();
    if (visited.has(layer.id)) return frameOf(layer);
    visited.add(layer.id);
    const frames = (document.layers || [])
      .filter((candidate) => candidate.parentId === layer.id)
      .map((member) => snapshotFrame(document, member, visited))
      .filter(Boolean);
    const union = unionBoxes(frames);
    if (union) return union;
    const offset = snapshotAncestorOffset(document, layer);
    return {
      x: Math.round(offset.x + (Number(layer.offset && layer.offset.x) || 0)),
      y: Math.round(offset.y + (Number(layer.offset && layer.offset.y) || 0)),
      width: 0,
      height: 0,
    };
  }
  const base = frameOf(layer);
  const offset = snapshotAncestorOffset(document, layer);
  return {
    x: Math.round(base.x + offset.x),
    y: Math.round(base.y + offset.y),
    width: base.width,
    height: base.height,
  };
}

/** The compact layer list stored per revision: enough to describe a delta. */
function snapshotLayers(document) {
  return (document.layers || []).map((layer, index) => {
    const children =
      layer.kind === 'group'
        ? (document.layers || []).filter((candidate) => candidate.parentId === layer.id).length
        : 0;
    return {
      id: layer.id,
      index: index,
      name: layer.name,
      kind: layer.kind,
      visible: layer.visible !== false,
      opacity: Number(layer.opacity === undefined ? 1 : layer.opacity),
      blendMode: layer.blendMode || 'normal',
      parentId: layer.parentId || null,
      children: children,
      frame: snapshotFrame(document, layer),
      mask: Boolean(layer.mask && layer.mask.file),
      styles: stylesModule.stylesSignature(layer.styles),
      styleCount: (layer.styles || []).filter((style) => style.enabled !== false).length,
      text: layer.kind === 'text' ? textModule.signature(layer.text) : '',
      summary: layer.summary || null,
      active: layer.id === document.activeLayerId,
      fingerprint: fingerprint(layer) + '|children:' + children,
    };
  });
}

function snapshotDocument(document) {
  return {
    revision: document.revision,
    canvas: { width: document.canvas.width, height: document.canvas.height },
    activeLayerId: document.activeLayerId,
    selection: document.selection
      ? {
          kind: document.selection.kind,
          summary: document.selection.summary,
          bounds: document.selection.bounds || null,
          maskFile: document.selection.maskFile || null,
        }
      : null,
    layers: snapshotLayers(document),
  };
}

/** Added, removed and changed layers between two snapshots. */
function diffSnapshots(before, after) {
  const earlier = before || { layers: [] };
  const later = after || { layers: [] };
  const beforeById = new Map((earlier.layers || []).map((layer) => [layer.id, layer]));
  const afterById = new Map((later.layers || []).map((layer) => [layer.id, layer]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const layer of later.layers || []) {
    const previous = beforeById.get(layer.id);
    if (!previous) {
      added.push(layer);
      continue;
    }
    if (previous.fingerprint !== layer.fingerprint) {
      const reasons = [];
      if (previous.frame && layer.frame) {
        if (
          previous.frame.x !== layer.frame.x ||
          previous.frame.y !== layer.frame.y ||
          previous.frame.width !== layer.frame.width ||
          previous.frame.height !== layer.frame.height
        ) {
          reasons.push('geometry');
        }
      }
      if (previous.visible !== layer.visible) reasons.push('visibility');
      if (previous.opacity !== layer.opacity) reasons.push('opacity');
      if (previous.blendMode !== layer.blendMode) reasons.push('blendMode');
      if (previous.mask !== layer.mask) reasons.push('mask');
      if ((previous.styles || '') !== (layer.styles || '')) reasons.push('styles');
      if ((previous.text || '') !== (layer.text || '')) reasons.push('text');
      if (previous.name !== layer.name) reasons.push('name');
      if ((previous.parentId || null) !== (layer.parentId || null)) reasons.push('group');
      if ((previous.children || 0) !== (layer.children || 0)) reasons.push('children');
      if (!reasons.length) reasons.push('pixels');
      changed.push(Object.assign({}, layer, { reasons: reasons, previous: previous }));
    }
  }
  for (const layer of earlier.layers || []) {
    if (!afterById.has(layer.id)) removed.push(layer);
  }
  const selectionChanged =
    JSON.stringify((earlier.selection && earlier.selection.maskFile) || null) !==
    JSON.stringify((later.selection && later.selection.maskFile) || null);
  const canvasChanged =
    !earlier.canvas ||
    !later.canvas ||
    earlier.canvas.width !== later.canvas.width ||
    earlier.canvas.height !== later.canvas.height;
  const layerBoxes = changed.concat(added).map((layer) => layer.frame);
  return {
    added: added.map(brief),
    removed: removed.map(brief),
    changed: changed.map((layer) => Object.assign(brief(layer), { reasons: layer.reasons })),
    selectionChanged: selectionChanged,
    canvasChanged: canvasChanged,
    changedBounds: unionBoxes(layerBoxes),
    no_op:
      !added.length &&
      !removed.length &&
      !changed.length &&
      !selectionChanged &&
      !canvasChanged,
  };
}

function brief(layer) {
  return {
    id: layer.id,
    name: layer.name,
    kind: layer.kind,
    index: layer.index,
    visible: layer.visible,
    frame: layer.frame,
  };
}

/**
 * Rank the layers a query could mean. Address-by-id is exact; everything else
 * is a graded match so an ambiguous name returns its candidates instead of
 * silently editing the bottom layer.
 */
function rankLayers(layers, query) {
  const q = query && typeof query === 'object' ? query : { name: String(query || '') };
  const name = String(q.name || q.query || '').trim();
  const needle = name.toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);
  const kind = q.kind ? String(q.kind) : null;
  const matches = [];
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    const layerName = String(layer.name || '').toLowerCase();
    let score = 0;
    if (q.id && layer.id === q.id) score = 1000;
    else if (needle && layer.id && layer.id.toLowerCase() === needle) score = 950;
    else if (needle && layerName === needle) score = 900;
    else if (needle && layerName.startsWith(needle)) score = 700;
    else if (needle && layerName.includes(needle)) score = 500;
    else if (tokens.length && tokens.every((token) => layerName.includes(token))) score = 300;
    else if (!needle) score = 10;
    if (!score) continue;
    if (kind && layer.kind !== kind) continue;
    if (q.visible !== undefined && Boolean(layer.visible) !== Boolean(q.visible)) continue;
    if (q.active === true && !layer.active) continue;
    if (q.locked !== undefined && Boolean(layer.locked) !== Boolean(q.locked)) continue;
    const frame = layer.frame || frameOf(layer);
    if (q.bbox) {
      const box = toRect(q.bbox);
      if (!box || !intersectBoxes(box, frame)) continue;
    }
    matches.push({
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      index: index,
      visible: layer.visible,
      score: score,
      frame: frame,
      summary: layer.summary || null,
    });
  }
  matches.sort((left, right) => right.score - left.score || left.index - right.index);
  return matches;
}

function hexOf(r, g, b) {
  return (
    '#' +
    [r, g, b]
      .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Sample exact pixels, in document coordinates. */
function sampleRaw(raw, points, options) {
  const settings = options || {};
  const offset = settings.offset || { x: 0, y: 0 };
  const channels = raw.channels || CHANNELS;
  const results = [];
  for (const point of points || []) {
    const source = Array.isArray(point) ? { x: point[0], y: point[1] } : point;
    const docX = Math.round(Number(source && source.x));
    const docY = Math.round(Number(source && source.y));
    const x = docX - Math.round(Number(offset.x) || 0);
    const y = docY - Math.round(Number(offset.y) || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= raw.width || y >= raw.height) {
      results.push({ x: docX, y: docY, inside: false });
      continue;
    }
    const index = (y * raw.width + x) * channels;
    const r = raw.data[index];
    const g = raw.data[index + 1];
    const b = raw.data[index + 2];
    const a = raw.data[index + 3];
    results.push({
      x: docX,
      y: docY,
      inside: true,
      rgba: { r: r, g: g, b: b, a: a },
      hex: hexOf(r, g, b),
      alpha: round(a / 255, 3),
      luma: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b),
      luminance: round(relativeLuminance(r, g, b), 4),
    });
  }
  return results;
}

function relativeLuminance(r, g, b) {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(lumaA, lumaB) {
  const light = Math.max(lumaA, lumaB);
  const dark = Math.min(lumaA, lumaB);
  return round((light + 0.05) / (dark + 0.05), 2);
}

/** Dominant colours by 5-bit bucket, averaged back in full precision. */
function palette(raw, maxColors) {
  const limit = Math.max(2, Math.min(64, Math.round(Number(maxColors) || 8)));
  const { data, width, height } = raw;
  const channels = raw.channels || CHANNELS;
  const buckets = new Map();
  let total = 0;
  for (let index = 0; index < width * height; index += 1) {
    const base = index * channels;
    const alpha = data[base + 3];
    if (alpha < 8) continue;
    const r = data[base];
    const g = data[base + 1];
    const b = data[base + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { count: 0, r: 0, g: 0, b: 0, a: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.a += alpha;
    total += 1;
  }
  const sorted = Array.from(buckets.values())
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
  return {
    pixels: total,
    colors: sorted.map((bucket) => {
      const r = bucket.r / bucket.count;
      const g = bucket.g / bucket.count;
      const b = bucket.b / bucket.count;
      return {
        hex: hexOf(r, g, b),
        rgb: { r: Math.round(r), g: Math.round(g), b: Math.round(b) },
        alpha: round(bucket.a / bucket.count / 255, 3),
        count: bucket.count,
        pct: round((bucket.count / Math.max(1, total)) * 100, 2),
        luma: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b),
      };
    }),
  };
}

/**
 * Pixel differences between two same-size frames.
 *
 * `changed` uses a tolerance so re-encoding noise does not count as an edit,
 * while `mae`/`rmse`/`psnr` stay exact. `ssim` is a single global window: cheap,
 * comparable between calls, and labelled as global rather than windowed.
 */
function diffRaws(left, right, options) {
  if (left.width !== right.width || left.height !== right.height) {
    return {
      sizeMismatch: true,
      left: { width: left.width, height: left.height },
      right: { width: right.width, height: right.height },
    };
  }
  const settings = options || {};
  const tolerance = Math.max(0, Math.min(255, Number(settings.tolerance) || 0));
  const channels = Math.min(left.channels || CHANNELS, right.channels || CHANNELS);
  const pixels = left.width * left.height;
  let changed = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let leftLumaSum = 0;
  let rightLumaSum = 0;
  let leftLumaSq = 0;
  let rightLumaSq = 0;
  let lumaProduct = 0;
  let leftX = left.width;
  let leftY = left.height;
  let rightX = -1;
  let rightY = -1;
  for (let index = 0; index < pixels; index += 1) {
    const base = index * channels;
    const lr = left.data[base];
    const lg = left.data[base + 1];
    const lb = left.data[base + 2];
    const rr = right.data[base];
    const rg = right.data[base + 1];
    const rb = right.data[base + 2];
    const dr = rr - lr;
    const dg = rg - lg;
    const db = rb - lb;
    const magnitude = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
    if (magnitude > tolerance) {
      changed += 1;
      const x = index % left.width;
      const y = Math.floor(index / left.width);
      if (x < leftX) leftX = x;
      if (x > rightX) rightX = x;
      if (y < leftY) leftY = y;
      if (y > rightY) rightY = y;
    }
    sumAbs += (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) / 3;
    sumSq += (dr * dr + dg * dg + db * db) / 3;
    const ly = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    const ry = 0.2126 * rr + 0.7152 * rg + 0.0722 * rb;
    leftLumaSum += ly;
    rightLumaSum += ry;
    leftLumaSq += ly * ly;
    rightLumaSq += ry * ry;
    lumaProduct += ly * ry;
  }
  const mae = sumAbs / pixels;
  const mse = sumSq / pixels;
  const rmse = Math.sqrt(mse);
  const meanLeft = leftLumaSum / pixels;
  const meanRight = rightLumaSum / pixels;
  const varianceLeft = Math.max(0, leftLumaSq / pixels - meanLeft * meanLeft);
  const varianceRight = Math.max(0, rightLumaSq / pixels - meanRight * meanRight);
  const covariance = lumaProduct / pixels - meanLeft * meanRight;
  const c1 = Math.pow(0.01 * 255, 2);
  const c2 = Math.pow(0.03 * 255, 2);
  const ssim =
    ((2 * meanLeft * meanRight + c1) * (2 * covariance + c2)) /
    ((meanLeft * meanLeft + meanRight * meanRight + c1) *
      (varianceLeft + varianceRight + c2));
  return {
    sizeMismatch: false,
    width: left.width,
    height: left.height,
    pixels: pixels,
    changedPixels: changed,
    changedPct: round((changed / pixels) * 100, 3),
    bbox:
      rightX >= leftX
        ? { x: leftX, y: leftY, width: rightX - leftX + 1, height: rightY - leftY + 1 }
        : null,
    mae: round(mae, 3),
    rmse: round(rmse, 3),
    psnr: mse === 0 ? null : round(10 * Math.log10((255 * 255) / mse), 2),
    ssim: round(Math.max(-1, Math.min(1, ssim)), 5),
    meanLumaDelta: round(meanRight - meanLeft, 3),
  };
}

/** A red-on-black heatmap of where the frames differ, for a visual check. */
function diffHeatmap(left, right) {
  if (left.width !== right.width || left.height !== right.height) return null;
  const channels = Math.min(left.channels || CHANNELS, right.channels || CHANNELS);
  const data = Buffer.alloc(left.width * left.height * 4);
  for (let index = 0; index < left.width * left.height; index += 1) {
    const base = index * channels;
    const out = index * 4;
    const delta =
      (Math.abs(left.data[base] - right.data[base]) +
        Math.abs(left.data[base + 1] - right.data[base + 1]) +
        Math.abs(left.data[base + 2] - right.data[base + 2])) /
      3;
    const heat = Math.min(255, Math.round(delta * 3));
    data[out] = heat;
    data[out + 1] = Math.round(heat * 0.55);
    data[out + 2] = Math.round(heat * 0.22);
    data[out + 3] = 255;
  }
  return { data: data, width: left.width, height: left.height, channels: 4 };
}

/** Rough encoded-size estimate; always labelled as an estimate. */
function estimateBytes(format, width, height, quality) {
  const pixels = Math.max(1, width * height);
  const q = Math.max(1, Math.min(100, Number(quality) || 90));
  switch (format) {
    case 'jpeg':
      return Math.round(pixels * (0.055 + (q / 100) * 0.11));
    case 'webp':
      return Math.round(pixels * (0.04 + (q / 100) * 0.08));
    case 'tiff':
      return pixels * 3;
    case 'gif':
      return pixels * 0.35;
    default:
      return Math.round(pixels * 0.55 + 2048);
  }
}

/**
 * Equal-gap layout for a set of boxes along one axis: keep the outer edges where
 * they are and move the boxes between them so every gap matches.
 */
function distributeBoxes(boxes, axis, gap) {
  const items = boxes
    .map((box, index) => ({ box: box, index: index }))
    .sort((left, right) =>
      axis === 'y'
        ? left.box.y - right.box.y || left.index - right.index
        : left.box.x - right.box.x || left.index - right.index
    );
  if (items.length < 2) return [];
  const start = items[0].box;
  const end = items[items.length - 1].box;
  const span =
    axis === 'y'
      ? end.y + end.height - start.y
      : end.x + end.width - start.x;
  const used = items.reduce(
    (total, item) => total + (axis === 'y' ? item.box.height : item.box.width),
    0
  );
  const evenGap =
    gap === undefined || gap === null
      ? Math.round((span - used) / (items.length - 1))
      : Math.round(Number(gap));
  const moves = [];
  let cursor = axis === 'y' ? start.y : start.x;
  for (const item of items) {
    const current = axis === 'y' ? item.box.y : item.box.x;
    moves.push({ index: item.index, delta: Math.round(cursor - current) });
    cursor += (axis === 'y' ? item.box.height : item.box.width) + evenGap;
  }
  return { moves: moves, gap: evenGap, span: span };
}

/** Fit text into a box with a proportional size search. */
function fitSize(measure, target, options) {
  const settings = options || {};
  const min = settings.min === undefined ? 6 : Number(settings.min);
  const max = settings.max === undefined ? 400 : Number(settings.max);
  let low = min;
  let high = max;
  let best = min;
  for (let step = 0; step < 18; step += 1) {
    const middle = (low + high) / 2;
    const ink = measure(middle);
    if (!ink || !ink.width || !ink.height) break;
    if (ink.width <= target.width && ink.height <= target.height) {
      best = middle;
      low = middle;
    } else {
      high = middle;
    }
    if (high - low < 0.5) break;
  }
  return round(best, 2);
}

module.exports = {
  ANCHORS: ANCHORS,
  alignDelta: alignDelta,
  alphaBounds: alphaBounds,
  anchorPoint: anchorPoint,
  canvasAnchor: canvasAnchor,
  clampRect: clampRect,
  contrastRatio: contrastRatio,
  diffHeatmap: diffHeatmap,
  diffRaws: diffRaws,
  diffSnapshots: diffSnapshots,
  distributeBoxes: distributeBoxes,
  estimateBytes: estimateBytes,
  fingerprint: fingerprint,
  fitSize: fitSize,
  frameOf: frameOf,
  hexOf: hexOf,
  isEmptyBox: isEmptyBox,
  intersectBoxes: intersectBoxes,
  normBox: normBox,
  palette: palette,
  rankLayers: rankLayers,
  relativeLuminance: relativeLuminance,
  round: round,
  sampleRaw: sampleRaw,
  snapshotDocument: snapshotDocument,
  snapshotLayers: snapshotLayers,
  toRect: toRect,
  unionBoxes: unionBoxes,
};
