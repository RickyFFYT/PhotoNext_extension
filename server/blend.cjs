/*
 * Blend modes, as arithmetic.
 *
 * Photoshop's modes are the W3C compositing formulas with Photoshop's names;
 * the M0 spike is why the extension computes them itself instead of asking
 * libvips (its native soft-light was 26 levels off the documented result).
 *
 * Colours are floats 0–1 here. Alpha compositing is `pixels.blend`, which uses
 * these per-channel functions — keeping the two apart is what lets a golden test
 * pin `overlay(0.25, 0.5) = 0.25` without a buffer.
 */
'use strict';

const BLEND_MODES = [
  'normal',
  'darken',
  'multiply',
  'colorBurn',
  'linearBurn',
  'darkerColor',
  'lighten',
  'screen',
  'colorDodge',
  'linearDodge',
  'lighterColor',
  'overlay',
  'softLight',
  'hardLight',
  'vividLight',
  'linearLight',
  'pinLight',
  'hardMix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
];

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function luminance(color) {
  return 0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2];
}

function saturation(color) {
  return Math.max(color[0], color[1], color[2]) - Math.min(color[0], color[1], color[2]);
}

function clipColor(color) {
  const l = luminance(color);
  const min = Math.min(color[0], color[1], color[2]);
  const max = Math.max(color[0], color[1], color[2]);
  const result = color.slice();
  if (min < 0) {
    for (let index = 0; index < 3; index += 1) {
      result[index] = l + ((result[index] - l) * l) / Math.max(1e-9, l - min);
    }
  }
  if (max > 1) {
    for (let index = 0; index < 3; index += 1) {
      result[index] = l + ((result[index] - l) * (1 - l)) / Math.max(1e-9, max - l);
    }
  }
  return result;
}

function setLuminance(color, target) {
  const delta = target - luminance(color);
  return clipColor([color[0] + delta, color[1] + delta, color[2] + delta]);
}

function setSaturation(color, target) {
  const max = Math.max(color[0], color[1], color[2]);
  const min = Math.min(color[0], color[1], color[2]);
  const result = [0, 0, 0];
  if (max === min) return result;
  const scale = target / (max - min);
  const middle = color[1] === max ? 2 : color[2] === max ? 4 : 0;
  for (let index = 0; index < 3; index += 1) {
    const channel = (index + middle) % 3;
    result[channel] = ((color[index] - min) * scale) || 0;
  }
  // The middle channel is the one between min and max; the formula above sets
  // the rotated channels, so recompute the third from the target saturation.
  result[0] = clamp01((color[0] - min) * scale);
  result[1] = clamp01((color[1] - min) * scale);
  result[2] = clamp01((color[2] - min) * scale);
  return result;
}

/** One channel of a separable mode. */
function blendChannel(mode, base, source) {
  switch (mode) {
    case 'normal':
      return source;
    case 'darken':
      return Math.min(base, source);
    case 'multiply':
      return base * source;
    case 'colorBurn':
      return source === 0 ? 0 : 1 - Math.min(1, (1 - base) / source);
    case 'linearBurn':
      return clamp01(base + source - 1);
    case 'lighten':
      return Math.max(base, source);
    case 'screen':
      return base + source - base * source;
    case 'colorDodge':
      return source >= 1 ? 1 : Math.min(1, base / (1 - source));
    case 'linearDodge':
      return clamp01(base + source);
    case 'overlay':
      return base <= 0.5 ? 2 * base * source : 1 - 2 * (1 - base) * (1 - source);
    case 'softLight': {
      if (source <= 0.5) return base - (1 - 2 * source) * base * (1 - base);
      const d = base <= 0.25 ? ((16 * base - 12) * base + 4) * base : Math.sqrt(base);
      return base + (2 * source - 1) * (d - base);
    }
    case 'hardLight':
      return source <= 0.5 ? 2 * base * source : 1 - 2 * (1 - base) * (1 - source);
    case 'vividLight':
      return source <= 0.5
        ? source === 0
          ? 0
          : 1 - Math.min(1, (1 - base) / (2 * source))
        : 2 * source - 1 >= 1
          ? 1
          : Math.min(1, base / (1 - (2 * source - 1)));
    case 'linearLight':
      return clamp01(base + 2 * source - 1);
    case 'pinLight':
      return source <= 0.5 ? Math.min(base, 2 * source) : Math.max(base, 2 * source - 1);
    case 'hardMix':
      return blendChannel('vividLight', base, source) >= 0.5 ? 1 : 0;
    case 'difference':
      return Math.abs(base - source);
    case 'exclusion':
      return base + source - 2 * base * source;
    case 'subtract':
      return clamp01(base - source);
    case 'divide':
      return source === 0 ? 1 : Math.min(1, base / source);
    default:
      throw new Error('Unknown blend mode: ' + mode);
  }
}

const SEPARABLE = new Set(
  BLEND_MODES.filter(
    (mode) => ['hue', 'saturation', 'color', 'luminosity', 'darkerColor', 'lighterColor'].indexOf(mode) === -1
  )
);

/** Blend two 0–1 RGB triples. `darkerColor`/`lighterColor` pick a whole pixel. */
function blendColor(mode, base, source) {
  if (mode === 'darkerColor') return luminance(source) < luminance(base) ? source.slice() : base.slice();
  if (mode === 'lighterColor') return luminance(source) > luminance(base) ? source.slice() : base.slice();
  if (mode === 'hue') return setLuminance(setSaturation(source, saturation(base)), luminance(base));
  if (mode === 'saturation') return setLuminance(setSaturation(base, saturation(source)), luminance(base));
  if (mode === 'color') return setLuminance(source, luminance(base));
  if (mode === 'luminosity') return setLuminance(base, luminance(source));
  return [
    clamp01(blendChannel(mode, base[0], source[0])),
    clamp01(blendChannel(mode, base[1], source[1])),
    clamp01(blendChannel(mode, base[2], source[2])),
  ];
}

function normalizeMode(value) {
  if (value === undefined || value === null || value === '') return 'normal';
  const key = String(value);
  if (BLEND_MODES.indexOf(key) !== -1) return key;
  const lower = key.toLowerCase();
  const found = BLEND_MODES.find((mode) => mode.toLowerCase() === lower);
  if (found) return found;
  throw new Error(
    'Unknown blend mode "' + key + '". Use one of: ' + BLEND_MODES.join(', ') + '.'
  );
}

module.exports = {
  BLEND_MODES: BLEND_MODES,
  SEPARABLE: SEPARABLE,
  blendChannel: blendChannel,
  blendColor: blendColor,
  clamp01: clamp01,
  luminance: luminance,
  normalizeMode: normalizeMode,
  saturation: saturation,
  setLuminance: setLuminance,
  setSaturation: setSaturation,
};
