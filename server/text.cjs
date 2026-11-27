/*
 * Editable text layers: a string plus typography, not a picture of a string.
 *
 * The document stores this record verbatim. Nothing here rasterises anything;
 * the engine asks for a layout and an SVG at composite time, which keeps the
 * editable content out of the pixel store and makes undo a field change.
 *
 * `x`/`y` live on the layer offset (the same offset every other layer uses, so
 * groups and `photo_layer set offset` move text too). Rotation and scale are
 * part of this record and are applied to the text command before it is laid
 * out, so the frame, mask, styles and hit-testing all agree with the pixels.
 */
'use strict';

const drawModule = require('./draw.cjs');
const stylesModule = require('./styles.cjs');

const LIMITS = {
  maxContentLength: 2000,
  minSize: 4,
  maxSize: 2000,
  minWeight: 100,
  maxWeight: 900,
  minLineHeight: 0.5,
  maxLineHeight: 4,
  minLetterSpacing: -200,
  maxLetterSpacing: 1000,
  minScale: 0.05,
  maxScale: 4,
  maxSurfacePixels: 16000000,
};

const DEFAULTS = {
  font: 'sans-serif',
  size: 48,
  weight: 400,
  italic: false,
  lineHeight: 1.25,
  letterSpacing: 0,
  align: 'left',
  color: '#ffffff',
  rotation: 0,
  scale: 1,
};

function invalid(message, field, extra) {
  const error = new Error(message);
  error.field = field;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  throw error;
}

function numberIn(value, fallback, min, max, field, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    invalid((label || field) + ' must be a number.', field, { received: value });
  }
  if (number < min || number > max) {
    invalid(
      (label || field) + ' must be between ' + min + ' and ' + max + ', got ' + number + '.',
      field,
      { min: min, max: max, received: number }
    );
  }
  return number;
}

function colorHex(value, fallback) {
  const source = value === undefined ? fallback : value;
  let rgba;
  try {
    rgba = stylesModule.parseColor(source);
  } catch (error) {
    invalid(
      '`color` must be a hex, rgb() or named colour (for example #ffffff).',
      'color',
      { received: value }
    );
  }
  if (!rgba) {
    invalid(
      '`color` must be a hex, rgb() or named colour (for example #ffffff).',
      'color',
      { received: value }
    );
  }
  const channels = rgba.slice(0, 4).map((channel) => {
    const rounded = Math.max(0, Math.min(255, Math.round(Number(channel) || 0)));
    return rounded.toString(16).padStart(2, '0');
  });
  return '#' + channels.join('');
}

function normalizeAlign(value, fallback) {
  if (value === undefined) return fallback;
  const align = String(value).trim().toLowerCase();
  if (align === 'end' || align === 'right') return 'right';
  if (align === 'center' || align === 'centre') return 'center';
  if (align === 'start' || align === 'left') return 'left';
  invalid('`align` must be left, center or right.', 'align', { received: value });
}

function fontName(value, fallback) {
  const font = String(value === undefined ? fallback : value).trim();
  if (!font || font.length > 160 || /[\u0000-\u001f]/.test(font)) {
    invalid('`font` must be a non-empty family name under 160 characters.', 'font', {
      received: value,
    });
  }
  return font;
}

function contentString(value, fallback) {
  const content = String(value === undefined ? (fallback === undefined ? '' : fallback) : value);
  if (!content.trim()) {
    invalid('A text layer needs non-empty `content`. Nothing was changed.', 'content');
  }
  if (content.length > LIMITS.maxContentLength) {
    invalid(
      '`content` is ' +
        content.length +
        ' characters; text layers hold at most ' +
        LIMITS.maxContentLength +
        '.',
      'content',
      { limit: LIMITS.maxContentLength, received: content.length }
    );
  }
  return content;
}

/** Merge a partial edit into the previous record and return a complete record. */
function normalize(input, previous) {
  const source = input && typeof input === 'object' ? input : {};
  const base = Object.assign({}, DEFAULTS, previous || {});
  const content =
    source.content !== undefined
      ? contentString(source.content)
      : source.text !== undefined
        ? contentString(source.text)
        : contentString(base.content);
  const size = numberIn(source.size, base.size, LIMITS.minSize, LIMITS.maxSize, 'size', '`size`');
  const scale = numberIn(
    source.scale,
    base.scale,
    LIMITS.minScale,
    LIMITS.maxScale,
    'scale',
    '`scale`'
  );
  if (size * scale > 4000) {
    invalid(
      '`size` × `scale` is ' +
        Number((size * scale).toFixed(2)) +
        'px; the renderer accepts at most 4000px of type. Lower the size or scale.',
      'size',
      { limit: 4000, received: Number((size * scale).toFixed(2)) }
    );
  }
  return {
    content: content,
    font: fontName(
      source.font !== undefined
        ? source.font
        : source.fontFamily !== undefined
          ? source.fontFamily
          : base.font,
      base.font
    ),
    size: size,
    weight: numberIn(
      source.weight,
      base.weight,
      LIMITS.minWeight,
      LIMITS.maxWeight,
      'weight',
      '`weight`'
    ),
    italic:
      source.italic !== undefined
        ? source.italic === true
        : source.style !== undefined
          ? String(source.style).toLowerCase() === 'italic'
          : base.italic === true,
    lineHeight: numberIn(
      source.lineHeight,
      base.lineHeight,
      LIMITS.minLineHeight,
      LIMITS.maxLineHeight,
      'lineHeight',
      '`lineHeight`'
    ),
    letterSpacing: numberIn(
      source.letterSpacing,
      base.letterSpacing,
      LIMITS.minLetterSpacing,
      LIMITS.maxLetterSpacing,
      'letterSpacing',
      '`letterSpacing`'
    ),
    align: normalizeAlign(source.align, base.align),
    color: colorHex(
      source.color !== undefined
        ? source.color
        : source.fill !== undefined
          ? source.fill
          : base.color,
      base.color
    ),
    rotation: numberIn(
      source.rotation,
      base.rotation,
      -360,
      360,
      'rotation',
      '`rotation`'
    ),
    scale: scale,
  };
}

/** A draw command in layer-local space. x/y are added by the compositor. */
function command(record) {
  const size = record.size * record.scale;
  return {
    type: 'text',
    text: record.content,
    x: 0,
    y: 0,
    size: size,
    font: record.font,
    weight: record.weight,
    italic: record.italic === true,
    align: record.align === 'right' ? 'end' : record.align,
    color: record.color,
    lineHeight: size * record.lineHeight,
    letterSpacing: record.letterSpacing * record.scale,
    rotation: record.rotation,
  };
}

/**
 * Layer-local ink box. This uses the same estimate `photo_draw` uses, then
 * rotates the corners around the baseline origin, so the engine's render
 * surface and the layer frame are one number.
 */
function layout(record) {
  let bounds = drawModule.boundsOf([command(record)]);
  if (record.rotation) {
    const radians = (record.rotation * Math.PI) / 180;
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
  if (bounds.width * bounds.height > LIMITS.maxSurfacePixels) {
    invalid(
      'That text needs a ' +
        bounds.width +
        '×' +
        bounds.height +
        ' render surface, over the 16 MP limit. Use a smaller size or shorter lines.',
      'size',
      { limit: LIMITS.maxSurfacePixels, requested: bounds.width * bounds.height }
    );
  }
  return bounds;
}

function svg(record, bounds) {
  return drawModule.buildSvg(bounds || layout(record), [command(record)]);
}

function signature(record) {
  if (!record) return '';
  return [
    record.content,
    record.font,
    record.size,
    record.weight,
    record.italic ? 1 : 0,
    record.lineHeight,
    record.letterSpacing,
    record.align,
    record.color,
    record.rotation,
    record.scale,
  ].join('|');
}

function lineCount(record) {
  return String(record.content || '').split(/\r?\n/).length;
}

function summary(record) {
  if (!record) return 'text';
  const first = String(record.content).split(/\r?\n/)[0];
  const label = first.length > 32 ? first.slice(0, 31) + '…' : first;
  return (
    '“' +
    label +
    '” · ' +
    Number(record.size.toFixed(2)) +
    'px ' +
    record.font +
    ' · ' +
    record.align
  );
}

function describe(record) {
  return Object.assign({}, record, {
    lineCount: lineCount(record),
    summary: summary(record),
  });
}

module.exports = {
  DEFAULTS: DEFAULTS,
  LIMITS: LIMITS,
  command: command,
  describe: describe,
  layout: layout,
  lineCount: lineCount,
  normalize: normalize,
  signature: signature,
  summary: summary,
  svg: svg,
};
