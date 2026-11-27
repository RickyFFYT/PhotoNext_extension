/*
 * Layer styles: persistent, editable records attached to a layer or group.
 *
 * This module is deliberately pure metadata. It validates parameters, assigns
 * defaults and describes what the renderer will do; it never touches pixels and
 * never caches a derived image. The document stores only these records, so a
 * style survives save/load, undo/redo and revision snapshots without growing
 * the document with baked effects.
 *
 * Units: `size`, `distance` and `spread` are document pixels; `angle` is
 * degrees clockwise with 0 = right and 90 = down; `opacity` is 0..1.
 */
'use strict';

const blendModule = require('./blend.cjs');

const TYPES = ['dropShadow', 'outerGlow', 'stroke', 'innerStroke', 'bevel'];

const TYPE_INFO = {
  dropShadow: {
    label: 'Drop shadow',
    params: ['color', 'opacity', 'size', 'distance', 'angle', 'spread', 'blend'],
  },
  outerGlow: {
    label: 'Outer glow',
    params: ['color', 'opacity', 'size', 'spread', 'hardness', 'blend'],
  },
  stroke: {
    label: 'Stroke',
    params: ['color', 'opacity', 'size', 'blend'],
  },
  innerStroke: {
    label: 'Inner stroke',
    params: ['color', 'opacity', 'size', 'blend'],
  },
  bevel: {
    label: 'Bevel & emboss',
    params: ['highlight', 'shadow', 'opacity', 'size', 'angle', 'soften', 'blend'],
  },
};

const DEFAULTS = {
  dropShadow: {
    color: '#000000',
    opacity: 0.6,
    size: 14,
    distance: 8,
    angle: 120,
    spread: 0,
    blend: 'normal',
  },
  outerGlow: {
    color: '#ffd479',
    opacity: 0.7,
    size: 18,
    spread: 10,
    hardness: 35,
    blend: 'normal',
  },
  stroke: {
    color: '#ffffff',
    opacity: 1,
    size: 4,
    blend: 'normal',
  },
  innerStroke: {
    color: '#ffffff',
    opacity: 1,
    size: 3,
    blend: 'normal',
  },
  bevel: {
    highlight: '#ffffff',
    shadow: '#000000',
    opacity: 0.75,
    size: 8,
    angle: 225,
    soften: 35,
    blend: 'normal',
  },
};

const NAMED_COLORS = {
  black: [0, 0, 0, 255],
  white: [255, 255, 255, 255],
  red: [255, 0, 0, 255],
  green: [0, 128, 0, 255],
  blue: [0, 0, 255, 255],
  yellow: [255, 255, 0, 255],
  cyan: [0, 255, 255, 255],
  magenta: [255, 0, 255, 255],
  gray: [128, 128, 128, 255],
  grey: [128, 128, 128, 255],
  transparent: [0, 0, 0, 0],
};

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() and a few names. */
function parseColor(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (NAMED_COLORS[text]) return NAMED_COLORS[text].slice();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const body = hex[1];
    if (body.length === 3 || body.length === 4) {
      return [
        parseInt(body[0] + body[0], 16),
        parseInt(body[1] + body[1], 16),
        parseInt(body[2] + body[2], 16),
        body.length === 4 ? parseInt(body[3] + body[3], 16) : 255,
      ];
    }
    if (body.length === 6 || body.length === 8) {
      return [
        parseInt(body.slice(0, 2), 16),
        parseInt(body.slice(2, 4), 16),
        parseInt(body.slice(4, 6), 16),
        body.length === 8 ? parseInt(body.slice(6, 8), 16) : 255,
      ];
    }
  }
  const rgb = /^rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/.exec(text);
  if (rgb) {
    const alpha = rgb[4] === undefined
      ? 1
      : rgb[4].indexOf('%') !== -1
        ? Number(rgb[4]) / 100
        : Number(rgb[4]);
    return [
      Math.max(0, Math.min(255, Math.round(Number(rgb[1])))),
      Math.max(0, Math.min(255, Math.round(Number(rgb[2])))),
      Math.max(0, Math.min(255, Math.round(Number(rgb[3])))),
      Math.max(0, Math.min(255, Math.round(alpha * 255))),
    ];
  }
  throw new Error(
    'Colour "' + String(value) + '" is not a hex, rgb()/rgba() or basic named colour.'
  );
}

function clampNumber(value, fallback, min, max, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(label + ' must be a number between ' + min + ' and ' + max + '.');
  }
  if (parsed < min || parsed > max) {
    throw new Error(label + ' must be between ' + min + ' and ' + max + ' (received ' + parsed + ').');
  }
  return parsed;
}

/** Validate and order a parameter object for one style type. */
function normalizeParams(type, input) {
  const info = TYPE_INFO[type];
  if (!info) {
    throw new Error('Unknown style type "' + String(type) + '". Use ' + TYPES.join(', ') + '.');
  }
  const provided = input || {};
  for (const key of Object.keys(provided)) {
    if (info.params.indexOf(key) === -1) {
      throw new Error(
        'Style ' + type + ' has no parameter "' + key + '". Allowed: ' + info.params.join(', ') + '.'
      );
    }
  }
  const merged = Object.assign({}, DEFAULTS[type], provided);
  const ordered = {};
  for (const key of info.params) {
    const value = merged[key];
    if (key === 'color' || key === 'highlight' || key === 'shadow') {
      parseColor(value);
      ordered[key] = String(value).trim();
    } else if (key === 'blend') {
      ordered[key] = blendModule.normalizeMode(String(value || 'normal').trim());
    } else if (key === 'opacity') {
      ordered[key] = clampNumber(value, 1, 0, 1, 'opacity');
    } else if (key === 'angle') {
      ordered[key] = clampNumber(value, 0, -360, 360, 'angle');
    } else if (key === 'size') {
      const max = type === 'stroke' || type === 'innerStroke' || type === 'bevel' ? 60 : 100;
      ordered[key] = clampNumber(value, 0, type === 'stroke' || type === 'innerStroke' || type === 'bevel' ? 0.5 : 0, max, 'size');
    } else if (key === 'distance') {
      ordered[key] = clampNumber(value, 8, 0, 500, 'distance');
    } else if (key === 'spread') {
      ordered[key] = clampNumber(value, 0, 0, 100, 'spread');
    } else if (key === 'hardness' || key === 'soften') {
      ordered[key] = clampNumber(value, 0, 0, 100, key);
    }
  }
  return ordered;
}

function createStyle(type, params, options) {
  const settings = options || {};
  return {
    id: settings.id || 'style_' + Math.random().toString(36).slice(2, 10),
    type: type,
    enabled: settings.enabled === undefined ? true : settings.enabled !== false,
    params: normalizeParams(type, params),
  };
}

function summary(style) {
  if (!style) return '';
  const label = TYPE_INFO[style.type] ? TYPE_INFO[style.type].label : style.type;
  if (!style.enabled) return label + ' (off)';
  const params = style.params || {};
  if (style.type === 'dropShadow') {
    return label + ' · ' + params.size + 'px blur · ' + params.distance + 'px · ' + Math.round(params.opacity * 100) + '%';
  }
  if (style.type === 'outerGlow') {
    return label + ' · ' + params.size + 'px · ' + Math.round(params.opacity * 100) + '%';
  }
  if (style.type === 'stroke' || style.type === 'innerStroke') {
    return label + ' · ' + params.size + 'px · ' + Math.round(params.opacity * 100) + '%';
  }
  return label + ' · ' + params.size + 'px · ' + params.angle + '°';
}

/** How far beyond its own alpha a style can paint, for bounds/preflight. */
function outerMargin(style) {
  if (!style || style.enabled === false) return 0;
  const params = style.params || {};
  if (style.type === 'dropShadow') {
    return Math.ceil(Number(params.distance || 0) + Number(params.size || 0) * 2.5 + 3);
  }
  if (style.type === 'outerGlow') return Math.ceil(Number(params.size || 0) * 2.5 + 2);
  if (style.type === 'stroke') return Math.ceil(Number(params.size || 0) + 1);
  return 0;
}

function styleSignature(style) {
  return [style.id, style.type, style.enabled ? 1 : 0, JSON.stringify(style.params || {})].join('|');
}

function stylesSignature(styles) {
  return (styles || []).map(styleSignature).join(';');
}

function describeAll() {
  return TYPES.map((type) => ({
    type: type,
    label: TYPE_INFO[type].label,
    params: TYPE_INFO[type].params,
    defaults: DEFAULTS[type],
  }));
}

function describeStyle(style) {
  return {
    id: style.id,
    type: style.type,
    enabled: style.enabled !== false,
    params: style.params,
    summary: summary(style),
  };
}

module.exports = {
  TYPES: TYPES,
  TYPE_INFO: TYPE_INFO,
  DEFAULTS: DEFAULTS,
  createStyle: createStyle,
  describeAll: describeAll,
  describeStyle: describeStyle,
  normalizeParams: normalizeParams,
  outerMargin: outerMargin,
  parseColor: parseColor,
  styleSignature: styleSignature,
  stylesSignature: stylesSignature,
  summary: summary,
};
