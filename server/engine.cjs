/*
 * The engine: document in, pixels out.
 *
 * It owns the things the tools must not each reinvent:
 *
 * - decoding and encoding through `render.cjs`, always as RGBA;
 * - running an adjustment stack, optionally clipped to a coverage mask;
 * - flattening a document — raster layers composited bottom-up with their blend
 *   mode, opacity, offset and mask, adjustment layers applied to everything below
 *   them, exactly as Photoshop stacks them;
 * - geometry plans, with native code for rotate/flip/crop/resize and the raw
 *   sampler for skew and perspective.
 *
 * The heavy passes go to libvips (`render.blurRaw`, `render.medianRaw`,
 * `render.rotateRaw`); the passes the extension defines itself — blend formulas,
 * curves, HSL, warps — stay in JS so the result is the documented one, not
 * whatever the native library happens to compute.
 */
'use strict';

const blendModule = require('./blend.cjs');
const drawModule = require('./draw.cjs');
const pixels = require('./pixels.cjs');
const render = require('./render.cjs');
const textModule = require('./text.cjs');
const transformModule = require('./transform.cjs');

const CHANNELS = 4;

async function decode(buffer) {
  const backend = render.requireBackend();
  const { data, info } = await backend(buffer, { failOn: 'none' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: data, width: info.width, height: info.height, channels: info.channels };
}

async function encode(raw, options) {
  const settings = options || {};
  return render.encodeRaw(raw, {
    format: settings.format || 'png',
    quality: settings.quality,
    resize: settings.resize,
  });
}

function transparent(width, height) {
  return {
    data: Buffer.alloc(width * height * CHANNELS),
    width: width,
    height: height,
    channels: CHANNELS,
  };
}

/** Decode a stored coverage mask to canvas-sized bytes. */
async function decodeMask(buffer, width, height) {
  const backend = render.requireBackend();
  const { data, info } = await backend(buffer, { failOn: 'none' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(width * height);
  if (info.width === width && info.height === height) {
    for (let index = 0; index < mask.length; index += 1) mask[index] = data[index * info.channels];
    return mask;
  }
  // A mask is stored at canvas size, so a mismatch means the document was
  // resized; nearest sampling keeps it usable instead of throwing.
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(info.height - 1, Math.floor((y * info.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(info.width - 1, Math.floor((x * info.width) / width));
      mask[y * width + x] = data[(sourceY * info.width + sourceX) * info.channels];
    }
  }
  return mask;
}

async function encodeMask(mask, width, height) {
  const backend = render.requireBackend();
  return backend(Buffer.from(mask), {
    raw: { width: width, height: height, channels: 1 },
  })
    .png()
    .toBuffer();
}

/** Project a canvas-sized mask into a layer's own pixel space. */
function maskForRaw(mask, canvasWidth, canvasHeight, raw, offset) {
  if (!mask) return null;
  const ox = offset ? Math.round(offset.x || 0) : 0;
  const oy = offset ? Math.round(offset.y || 0) : 0;
  if (raw.width === canvasWidth && raw.height === canvasHeight && ox === 0 && oy === 0) return mask;
  const result = new Uint8Array(raw.width * raw.height);
  for (let y = 0; y < raw.height; y += 1) {
    const canvasY = y + oy;
    for (let x = 0; x < raw.width; x += 1) {
      const canvasX = x + ox;
      result[y * raw.width + x] =
        canvasX >= 0 && canvasY >= 0 && canvasX < canvasWidth && canvasY < canvasHeight
          ? mask[canvasY * canvasWidth + canvasX]
          : 0;
    }
  }
  return result;
}

function blendMasked(base, adjusted, mask) {
  const channels = base.channels || CHANNELS;
  const output = Buffer.from(base.data);
  for (let index = 0; index < mask.length; index += 1) {
    const coverage = mask[index] / 255;
    if (!coverage) continue;
    const pixelIndex = index * channels;
    if (coverage >= 1) {
      output[pixelIndex] = adjusted.data[pixelIndex];
      output[pixelIndex + 1] = adjusted.data[pixelIndex + 1];
      output[pixelIndex + 2] = adjusted.data[pixelIndex + 2];
      output[pixelIndex + 3] = adjusted.data[pixelIndex + 3];
      continue;
    }
    for (let channel = 0; channel < channels; channel += 1) {
      output[pixelIndex + channel] = Math.round(
        base.data[pixelIndex + channel] * (1 - coverage) +
          adjusted.data[pixelIndex + channel] * coverage
      );
    }
  }
  return { data: output, width: base.width, height: base.height, channels: channels };
}

async function applyOperation(raw, operation) {
  switch (operation.type) {
    case 'whiteBalance':
      return pixels.applyGains(raw, whiteBalanceGainsOf(operation));
    case 'exposure':
      return pixels.applyLuts(raw, requireTone().exposureLut(operation.stops));
    case 'brightnessContrast':
      return pixels.applyLuts(
        raw,
        requireTone().brightnessContrastLut(operation.brightness, operation.contrast)
      );
    case 'gamma':
      return pixels.applyLuts(raw, requireTone().gammaLut(operation.gamma));
    case 'levels':
      return applyChannelLut(raw, operation.channel, requireTone().levelsLut(operation));
    case 'curves':
      return applyChannelLut(raw, operation.channel, requireTone().curvesLut(operation.points));
    case 'shadowsHighlights':
      return pixels.applyShadowsHighlights(raw, operation);
    case 'autoTone': {
      const tone = requireTone();
      const stats = pixels.histogram(raw);
      if (operation.mode === 'equalize') {
        return pixels.applyLuts(raw, [
          tone.equalizeLut(stats.red),
          tone.equalizeLut(stats.green),
          tone.equalizeLut(stats.blue),
        ]);
      }
      if (operation.mode === 'levels') {
        return pixels.applyLuts(raw, [
          tone.stretchLut(stats.red, operation.clip),
          tone.stretchLut(stats.green, operation.clip),
          tone.stretchLut(stats.blue, operation.clip),
        ]);
      }
      return pixels.applyLuts(raw, tone.autoContrastLut(stats.luma, operation.clip));
    }
    case 'posterize':
      return pixels.applyLuts(raw, requireTone().posterizeLut(operation.levels));
    case 'threshold':
      return pixels.applyThreshold(raw, operation.level);
    case 'invert':
      return pixels.applyLuts(raw, requireTone().invertLut());
    case 'grayscale':
      return pixels.applyGrayscale(raw);
    case 'blackAndWhite':
      return pixels.applyBlackAndWhite(raw, requireTone().blackAndWhiteWeights(operation));
    case 'colorBalance':
      return pixels.applyColorBalance(raw, operation);
    case 'hueSaturation':
      return pixels.applyHsl(raw, operation);
    case 'vibrance':
      return pixels.applyHsl(raw, { vibrance: operation.amount });
    case 'channelMixer':
      return pixels.applyMatrix(raw, requireTone().channelMixerMatrix(operation));
    case 'gradientMap':
      return pixels.applyGradientMap(raw, requireTone().gradientMapLut(operation.stops));
    case 'lut3d':
      return requireLut().applyToRaw(raw, operation);
    case 'splitToning':
      return pixels.applySplitTone(raw, operation);
    case 'photoFilter':
      return pixels.applyPhotoFilter(raw, {
        color: requireTone().parseColor(operation.color),
        density: operation.density,
      });
    case 'clarity': {
      const blurred = await render.blurRaw(copyRaw(raw), operation.radius);
      return pixels.clarity(raw, operation, blurred);
    }
    case 'dehaze':
      return pixels.dehaze(raw, operation);
    case 'boxBlur':
      return pixels.boxBlur(raw, operation.radius);
    case 'gaussianBlur':
      return render.blurRaw(raw, operation.radius);
    case 'medianBlur':
      return render.medianRaw(raw, 2 * operation.radius + 1);
    case 'motionBlur':
      return pixels.motionBlur(raw, operation);
    case 'unsharpMask': {
      const blurred = await render.blurRaw(copyRaw(raw), operation.radius);
      return pixels.unsharpMask(raw, operation, blurred);
    }
    case 'smartSharpen': {
      if (operation.reduceNoise) await render.medianRaw(raw, 3);
      const blurred = await render.blurRaw(copyRaw(raw), operation.radius);
      return pixels.unsharpMask(raw, operation, blurred);
    }
    case 'denoise':
      return pixels.denoise(raw, operation);
    case 'vignette':
      return pixels.vignette(raw, operation);
    case 'grain':
      return pixels.grain(raw, operation);
    default:
      throw new Error(
        'Adjustment "' + operation.type + '" was accepted by the schema but has no engine pass.'
      );
  }
}

function copyRaw(raw) {
  return {
    data: Buffer.from(raw.data),
    width: raw.width,
    height: raw.height,
    channels: raw.channels,
  };
}

function applyChannelLut(raw, channel, lut) {
  if (channel === 'rgb') return pixels.applyLuts(raw, lut);
  const index = channel === 'red' ? 0 : channel === 'green' ? 1 : 2;
  return pixels.applyOperationToChannel(raw, index, lut);
}

function whiteBalanceGainsOf(operation) {
  return requireTone().whiteBalanceGains(operation.temperature, operation.tint);
}

let toneModule = null;
function requireTone() {
  if (!toneModule) toneModule = require('./tone.cjs');
  return toneModule;
}

let lutModule = null;
function requireLut() {
  if (!lutModule) lutModule = require('./lut.cjs');
  return lutModule;
}

/**
 * Draw vector commands onto a layer.
 *
 * The commands are in canvas coordinates and may cover a small fraction of an
 * 80-megapixel document, so only their padded bounds are rasterised. The result
 * is composited at that offset with the layer's own mask (already projected into
 * layer space), which is also how a selection clips a drawing.
 */
async function drawToBuffer(buffer, commands, options) {
  const settings = options || {};
  const canvas = settings.canvas || null;
  const raw = await decode(buffer);
  const list = drawModule.normalizeCommands(commands);
  const layerOffset = rawOffset(settings.offset);
  const opacity = settings.opacity === undefined ? 1 : settings.opacity;
  // A selection or layer mask is canvas-sized. Project it once into the layer's
  // own pixels: both the vector compositor and the bucket fill index coverage
  // in layer space, and doing it once keeps an offset layer's mask aligned.
  const mask =
    settings.mask && canvas
      ? maskForRaw(settings.mask, canvas.width, canvas.height, raw, layerOffset)
      : settings.mask || null;
  let drawn = raw;
  let bounds = null;
  let group = [];

  const flushVectors = async () => {
    if (!group.length) return;
    let groupBounds = drawModule.boundsOf(group);
    if (canvas) {
      const left = Math.max(-raw.width, Math.min(canvas.width + raw.width, groupBounds.x));
      const top = Math.max(-raw.height, Math.min(canvas.height + raw.height, groupBounds.y));
      const right = Math.min(canvas.width + raw.width, groupBounds.x + groupBounds.width);
      const bottom = Math.min(canvas.height + raw.height, groupBounds.y + groupBounds.height);
      groupBounds = {
        x: Math.floor(left),
        y: Math.floor(top),
        width: Math.max(1, Math.ceil(right - left)),
        height: Math.max(1, Math.ceil(bottom - top)),
      };
    }
    const svg = drawModule.buildSvg(groupBounds, group);
    const customFamilies = new Set(
      (settings.customFonts || []).map((family) => String(family).trim().toLowerCase())
    );
    const needsFreshFontconfig = group.some(
      (command) =>
        command &&
        String(command.type || '').toLowerCase() === 'text' &&
        customFamilies.has(String(command.font || '').trim().toLowerCase())
    );
    const mark = await render.rasterizeSvg(
      svg,
      groupBounds.width,
      groupBounds.height,
      needsFreshFontconfig && settings.fontDir ? { fontDir: settings.fontDir } : null
    );
    drawn = pixels.blend(drawn, mark, {
      mode: 'normal',
      opacity: opacity,
      offset: {
        x: groupBounds.x - layerOffset.x,
        y: groupBounds.y - layerOffset.y,
      },
      mask: mask,
    });
    bounds = groupBounds;
    group = [];
  };

  for (const command of list) {
    const type = String(command.type || '').toLowerCase();
    if (type === 'clone') {
      await flushVectors();
      const points = clonePoints(command).map((point) => ({
        x: point[0] - layerOffset.x,
        y: point[1] - layerOffset.y,
      }));
      if (!points.length) {
        throw new Error('A clone command needs points (or x and y). Nothing was changed.');
      }
      const from = command.from || command.source;
      const anchor = Array.isArray(from)
        ? { x: Number(from[0]), y: Number(from[1]) }
        : from && typeof from === 'object'
          ? { x: Number(from.x), y: Number(from.y) }
          : null;
      const offset = anchor
        ? { x: anchor.x - (points[0].x + layerOffset.x), y: anchor.y - (points[0].y + layerOffset.y) }
        : command.offset && typeof command.offset === 'object'
          ? { x: Number(command.offset.x) || 0, y: Number(command.offset.y) || 0 }
          : { x: 0, y: 0 };
      drawn = pixels.cloneStamp(drawn, {
        points: points,
        offset: offset,
        width: command.width,
        softness: command.softness,
        opacity: (opacity * (command.opacity === undefined ? 1 : command.opacity)),
        mask: mask,
      });
      const cloneBox = {
        x: Math.floor(Math.min.apply(null, points.map((point) => point.x)) - Number(command.width || 48) / 2),
        y: Math.floor(Math.min.apply(null, points.map((point) => point.y)) - Number(command.width || 48) / 2),
        width: 1,
        height: 1,
      };
      cloneBox.width = Math.ceil(
        Math.max.apply(null, points.map((point) => point.x)) + Number(command.width || 48) / 2 - cloneBox.x
      );
      cloneBox.height = Math.ceil(
        Math.max.apply(null, points.map((point) => point.y)) + Number(command.width || 48) / 2 - cloneBox.y
      );
      bounds = bounds ? unionRect(bounds, cloneBox) : cloneBox;
      continue;
    }
    if (type !== 'fill') {
      group.push(command);
      continue;
    }
    await flushVectors();
    const fillX = Math.round(Number(command.x));
    const fillY = Math.round(Number(command.y));
    const localX = fillX - layerOffset.x;
    const localY = fillY - layerOffset.y;
    if (
      !Number.isFinite(localX) ||
      !Number.isFinite(localY) ||
      localX < 0 ||
      localY < 0 ||
      localX >= drawn.width ||
      localY >= drawn.height
    ) {
      throw new Error('The fill seed is outside the layer. Nothing was changed.');
    }
    drawn = pixels.floodFill(drawn, {
      x: localX,
      y: localY,
      color: drawModule.colorChannels(command.color, '#000000'),
      tolerance: command.tolerance,
      contiguous: command.contiguous !== false,
      opacity: opacity * (command.opacity === undefined ? 1 : command.opacity),
      mask: mask,
    });
    bounds = {
      x: fillX,
      y: fillY,
      width: 1,
      height: 1,
    };
  }
  await flushVectors();
  if (!bounds) bounds = { x: 0, y: 0, width: drawn.width, height: drawn.height };
  const encoded = await encode(drawn, { format: 'png' });
  return {
    buffer: encoded.buffer,
    width: drawn.width,
    height: drawn.height,
    format: 'png',
    histogram: pixels.histogram(drawn),
    bounds: bounds,
  };
}

function clonePoints(command) {
  const list = [];
  const push = (value) => {
    if (Array.isArray(value) && value.length >= 2) {
      const x = Number(value[0]);
      const y = Number(value[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) list.push([x, y]);
    }
  };
  if (Array.isArray(command.points)) for (const point of command.points) push(point);
  if (Array.isArray(command.paths)) {
    for (const path of command.paths) if (Array.isArray(path)) for (const point of path) push(point);
  }
  if (!list.length && Number.isFinite(Number(command.x)) && Number.isFinite(Number(command.y))) {
    push([Number(command.x), Number(command.y)]);
  }
  return list;
}

function unionRect(left, right) {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    x: x,
    y: y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y,
  };
}

function rawOffset(offset) {
  return {
    x: offset ? Math.round(Number(offset.x) || 0) : 0,
    y: offset ? Math.round(Number(offset.y) || 0) : 0,
  };
}

/** Run a stack; with `mask`, only the masked coverage changes. */
async function applyStack(raw, stack, options) {
  const settings = options || {};
  const original = settings.mask ? copyRaw(raw) : null;
  let current = raw;
  for (const operation of stack || []) current = await applyOperation(current, operation);
  if (original && settings.mask) current = blendMasked(original, current, settings.mask);
  return current;
}

/** Adjust a layer and return a lossless PNG working result. */
async function applyToBuffer(buffer, stack, options) {
  const settings = options || {};
  const raw = await decode(buffer);
  let mask = settings.mask || null;
  if (mask && settings.canvas) {
    mask = maskForRaw(mask, settings.canvas.width, settings.canvas.height, raw, settings.offset);
  }
  const adjusted = await applyStack(raw, stack, { mask: mask });
  const encoded = await encode(adjusted, { format: 'png' });
  return {
    buffer: encoded.buffer,
    width: adjusted.width,
    height: adjusted.height,
    format: 'png',
    histogram: pixels.histogram(adjusted),
  };
}

/**
 * Flatten visible layers, including nested groups.
 *
 * A group renders its children bottom-to-top into an isolated transparent
 * buffer, then composites that buffer with its own blend mode, opacity and
 * mask. Adjustment layers apply to the composite below them in their own
 * container, so an adjustment inside a group cannot reach outside it and a
 * top-level adjustment still sees every group below it.
 *
 * Raster pixels sit at `layer.offset` plus every group ancestor's offset; a
 * group's offset is therefore one value that moves the whole subtree.
 */
/**
 * Rasterise one text layer into its local ink box. This is the only place a
 * text record becomes pixels; flatten and inspection both call it so the
 * exported frame and the reported ink bounds cannot disagree.
 */
async function renderTextLayer(layer, options) {
  const settings = options || {};
  if (!layer || layer.kind !== 'text' || !layer.text) {
    throw new Error('renderTextLayer needs a text layer with a text record.');
  }
  const bounds = textModule.layout(layer.text);
  const family = String(layer.text.font || '').trim().toLowerCase();
  const customFamilies = new Set(
    (settings.customFonts || []).map((name) => String(name).trim().toLowerCase())
  );
  const mark = await render.rasterizeSvg(
    textModule.svg(layer.text, bounds),
    bounds.width,
    bounds.height,
    settings.fontDir && customFamilies.has(family) ? { fontDir: settings.fontDir } : null
  );
  return {
    raw: {
      data: mark.data,
      width: mark.width,
      height: mark.height,
      channels: mark.channels || CHANNELS,
    },
    bounds: bounds,
  };
}

async function flattenDocument(document, store, options) {
  const settings = options || {};
  const canvas = document.canvas;
  const allLayers = document.layers || [];
  const groups = new Map(
    allLayers.filter((layer) => layer.kind === 'group').map((layer) => [layer.id, layer])
  );
  const rendered = allLayers.filter((layer) => layer.visible !== false);
  const customFamilies = new Set(
    (settings.customFonts || []).map((family) => String(family).trim().toLowerCase())
  );
  const visibleSources = rendered.filter(
    (layer) =>
      (layer.kind === 'raster' && layer.pixels && store.exists(layer.pixels.file)) ||
      (layer.kind === 'text' && layer.text)
  );
  if (!visibleSources.length) {
    throw new Error('The document has no visible raster or text layer to render. Nothing was changed.');
  }

  const byParent = new Map();
  for (const layer of rendered) {
    const parentId = layer.parentId && groups.has(layer.parentId) ? layer.parentId : null;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(layer);
  }
  const roots = rendered.filter(
    (layer) => !layer.parentId || !groups.has(layer.parentId)
  );

  const composite = async (layers, inherited, depth) => {
    if (depth > 8) throw new Error('Groups nest at most 8 deep. Nothing was changed.');
    let base = transparent(canvas.width, canvas.height);
    for (const layer of layers) {
      if (layer.kind === 'group') {
        const children = byParent.get(layer.id) || [];
        if (!children.length) continue;
        const inner = await composite(
          children,
          {
            x: inherited.x + Math.round(Number(layer.offset && layer.offset.x) || 0),
            y: inherited.y + Math.round(Number(layer.offset && layer.offset.y) || 0),
          },
          depth + 1
        );
        const styledInner = layer.styles && layer.styles.length
          ? pixels.applyLayerStyles(inner, layer.styles)
          : inner;
        let mask = null;
        if (layer.mask && layer.mask.file) {
          mask = await decodeMask(store.read(layer.mask.file), canvas.width, canvas.height);
          if (layer.mask.inverted) mask = mask.map((value) => 255 - value);
        }
        base = pixels.blend(base, styledInner, {
          mode: blendModule.normalizeMode(layer.blendMode),
          opacity: layer.opacity === undefined ? 1 : layer.opacity,
          offset: { x: 0, y: 0 },
          mask: mask,
        });
        continue;
      }
      if (layer.kind === 'raster' && layer.pixels && store.exists(layer.pixels.file)) {
        let decoded = await decode(store.read(layer.pixels.file));
        const offset = {
          x: inherited.x + Math.round(Number(layer.offset && layer.offset.x) || 0),
          y: inherited.y + Math.round(Number(layer.offset && layer.offset.y) || 0),
        };
        if (layer.styles && layer.styles.length) {
          const margin = pixels.styleMargin(layer.styles);
          decoded = pixels.applyLayerStyles(pixels.padRaw(decoded, margin), layer.styles);
          offset.x -= margin;
          offset.y -= margin;
        }
        let mask = null;
        if (layer.mask && layer.mask.file) {
          const canvasMask = await decodeMask(
            store.read(layer.mask.file),
            canvas.width,
            canvas.height
          );
          mask = maskForRaw(canvasMask, canvas.width, canvas.height, decoded, offset);
          if (layer.mask.inverted) mask = mask.map((value) => 255 - value);
        }
        base = pixels.blend(base, decoded, {
          mode: blendModule.normalizeMode(layer.blendMode),
          opacity: layer.opacity === undefined ? 1 : layer.opacity,
          offset: offset,
          mask: mask,
        });
      } else if (layer.kind === 'text' && layer.text) {
        // Text is rasterised here, per composite, from the stored record. The
        // pixels never enter document.json, so editing the string or a font
        // field cannot leave a stale cached bitmap behind.
        const renderedText = await renderTextLayer(layer, {
          fontDir: settings.fontDir,
          customFonts: Array.from(customFamilies),
        });
        let decoded = renderedText.raw;
        let offset = {
          x: inherited.x + Math.round(Number(layer.offset && layer.offset.x) || 0) + renderedText.bounds.x,
          y: inherited.y + Math.round(Number(layer.offset && layer.offset.y) || 0) + renderedText.bounds.y,
        };
        if (layer.styles && layer.styles.length) {
          const margin = pixels.styleMargin(layer.styles);
          decoded = pixels.applyLayerStyles(pixels.padRaw(decoded, margin), layer.styles);
          offset.x -= margin;
          offset.y -= margin;
        }
        let mask = null;
        if (layer.mask && layer.mask.file) {
          const canvasMask = await decodeMask(
            store.read(layer.mask.file),
            canvas.width,
            canvas.height
          );
          mask = maskForRaw(canvasMask, canvas.width, canvas.height, decoded, offset);
          if (layer.mask.inverted) mask = mask.map((value) => 255 - value);
        }
        base = pixels.blend(base, decoded, {
          mode: blendModule.normalizeMode(layer.blendMode),
          opacity: layer.opacity === undefined ? 1 : layer.opacity,
          offset: offset,
          mask: mask,
        });
      } else if (
        layer.kind === 'adjustment' &&
        Array.isArray(layer.adjustments) &&
        layer.adjustments.length
      ) {
        let mask = null;
        if (layer.mask && layer.mask.file) {
          mask = await decodeMask(store.read(layer.mask.file), canvas.width, canvas.height);
          if (layer.mask.inverted) mask = mask.map((value) => 255 - value);
        }
        const adjusted = await applyStack(copyRaw(base), layer.adjustments);
        base = pixels.blend(base, adjusted, {
          mode: 'normal',
          opacity: layer.opacity === undefined ? 1 : layer.opacity,
          mask: mask,
        });
      }
    }
    return base;
  };

  // One plain top-level raster layer is already the flattened document;
  // returning its stored bytes avoids a re-encode and keeps it lossless.
  const single = roots.length === 1 ? roots[0] : null;
  const plain =
    single &&
    single.kind === 'raster' &&
    single.pixels &&
    !single.parentId &&
    !(single.mask && single.mask.file) &&
    !(single.styles && single.styles.length) &&
    (!single.blendMode || single.blendMode === 'normal') &&
    (single.opacity === undefined || single.opacity >= 1);
  let base;
  let buffer;
  if (plain) {
    buffer = store.read(single.pixels.file);
    base = await decode(buffer);
  } else {
    base = await composite(roots, { x: 0, y: 0 }, 0);
    buffer = (await encode(base, { format: 'png' })).buffer;
  }

  return {
    buffer: buffer,
    raw: base,
    width: canvas.width,
    height: canvas.height,
    histogram: pixels.histogram(base),
  };
}

async function histogramOf(buffer) {
  return pixels.histogram(await decode(buffer));
}

/** Execute the ordered geometry plan from `ops.planEdit`. */
async function applyEditPlan(buffer, plan, options) {
  const settings = options || {};
  const format = plan.format || settings.format || 'png';
  const backend = render.requireBackend();
  let image = backend(buffer, { failOn: 'none' });
  let raw = null;

  const toRaw = async () => {
    raw = await decode(await image.png().toBuffer());
    image = null;
  };
  const toImage = async () => {
    image = backend(raw.data, {
      raw: { width: raw.width, height: raw.height, channels: raw.channels || CHANNELS },
    });
    raw = null;
  };

  for (const operation of plan.operations) {
    if (operation.kind === 'rotate' && operation.degrees % 90 !== 0) {
      if (!raw) await toRaw();
      raw = await render.rotateRaw(raw, operation.degrees, { fit: operation.fit || 'expand' });
      continue;
    }
    if (
      operation.kind === 'rotate' ||
      operation.kind === 'flip' ||
      operation.kind === 'crop' ||
      operation.kind === 'resize'
    ) {
      if (raw) await toImage();
      if (operation.kind === 'rotate') {
        image = image.rotate(operation.degrees, {
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        });
      } else if (operation.kind === 'flip') {
        image = operation.axis === 'horizontal' ? image.flop() : image.flip();
      } else if (operation.kind === 'crop') {
        image = image.extract({
          left: operation.rect.x,
          top: operation.rect.y,
          width: operation.rect.width,
          height: operation.rect.height,
        });
      } else {
        image = image.resize(operation.size.width, operation.size.height, {
          fit: 'fill',
          kernel: 'lanczos3',
        });
      }
      continue;
    }

    if (!raw) await toRaw();
    if (operation.kind === 'skew') {
      // Shear about the centre, then move the result so the sheared bounds start
      // at (0,0): skew must not clip the corners that leave the old canvas.
      const matrix = transformModule.skew(operation.x, operation.y, raw.width / 2, raw.height / 2);
      const corners = transformModule
        .corners(raw.width, raw.height)
        .map((corner) => transformModule.apply(matrix, corner.x, corner.y));
      const minX = Math.min.apply(null, corners.map((point) => point.x));
      const minY = Math.min.apply(null, corners.map((point) => point.y));
      const maxX = Math.max.apply(null, corners.map((point) => point.x));
      const maxY = Math.max.apply(null, corners.map((point) => point.y));
      raw = pixels.warp(raw, {
        matrix: transformModule.multiply(
          [1, 0, -minX, 0, 1, -minY, 0, 0, 1],
          matrix
        ),
        width: Math.max(1, Math.ceil(maxX - minX - 1e-9)),
        height: Math.max(1, Math.ceil(maxY - minY - 1e-9)),
        sampler: operation.sampler,
      });
    } else if (operation.kind === 'perspective') {
      raw = pixels.warp(raw, {
        matrix: transformModule.homography(
          transformModule.corners(raw.width, raw.height),
          operation.corners
        ),
        width: operation.width || raw.width,
        height: operation.height || raw.height,
        sampler: operation.sampler,
      });
    } else if (operation.kind === 'canvas') {
      const width = operation.width;
      const height = operation.height;
      const offset = transformModule.anchorOffset(
        raw.width,
        raw.height,
        width,
        height,
        operation.anchor
      );
      if (width <= raw.width && height <= raw.height) {
        raw = pixels.crop(raw, { x: offset.x, y: offset.y, width: width, height: height });
      } else {
        raw = pixels.extend(raw, {
          width: width,
          height: height,
          offsetX: offset.x,
          offsetY: offset.y,
          background: operation.background,
        });
      }
    } else if (operation.kind === 'trim') {
      const box = pixels.trimBox(raw, operation);
      if (box.width !== raw.width || box.height !== raw.height) raw = pixels.crop(raw, box);
    } else {
      throw new Error('Unknown edit operation: ' + operation.kind);
    }
  }

  if (raw) return render.encodeRaw(raw, { format: format });
  const output = await render.encodeBuffer(image, format).toBuffer();
  const size = await render.readImage(output);
  return { buffer: output, width: size.width, height: size.height, format: format };
}

module.exports = {
  applyEditPlan: applyEditPlan,
  applyStack: applyStack,
  applyToBuffer: applyToBuffer,
  decode: decode,
  decodeMask: decodeMask,
  drawToBuffer: drawToBuffer,
  encode: encode,
  encodeMask: encodeMask,
  flattenDocument: flattenDocument,
  renderTextLayer: renderTextLayer,
  histogramOf: histogramOf,
  maskForRaw: maskForRaw,
  transparent: transparent,
};
