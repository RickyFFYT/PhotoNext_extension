/*
 * The adjustment vocabulary: one name, one set of validated parameters.
 *
 * This module is the contract between the agent and the engine. It exists so
 * that a typo is a named error ("brightnessContrast takes brightness, not
 * brightnes") instead of a silently ignored parameter, and so the engine can
 * assume every value it receives is already in range.
 *
 * A stack is applied in a fixed order, not in the order the caller listed it:
 * white balance and exposure before tone curves, curves before colour, spatial
 * operations last. That is the order an editor applies camera corrections, and
 * it makes two calls with the same operations produce the same pixels.
 */
'use strict';

const ORDER = [
  'whiteBalance',
  'exposure',
  'brightnessContrast',
  'gamma',
  'levels',
  'curves',
  'shadowsHighlights',
  'autoTone',
  'posterize',
  'threshold',
  'invert',
  'grayscale',
  'blackAndWhite',
  'colorBalance',
  'hueSaturation',
  'vibrance',
  'channelMixer',
  'gradientMap',
  'lut3d',
  'splitToning',
  'photoFilter',
  'clarity',
  'dehaze',
  'boxBlur',
  'gaussianBlur',
  'medianBlur',
  'motionBlur',
  'unsharpMask',
  'smartSharpen',
  'denoise',
  'vignette',
  'grain',
];

const TYPES = ORDER.slice();

const CHANNELS = ['rgb', 'red', 'green', 'blue'];
const HUE_BAND_NAMES = ['master', 'reds', 'oranges', 'yellows', 'greens', 'aquas', 'blues', 'purples', 'magentas'];
const FILTER_COLORS = {
  warming: '#ec8a00',
  cooling: '#85b0ff',
  sepia: '#ac7a33',
  deepRed: '#ff0000',
  deepBlue: '#0000ff',
  deepGreen: '#00ff00',
  deepYellow: '#ffff00',
};

function numberParam(params, key, options) {
  const settings = options || {};
  const fallback = settings.fallback === undefined ? 0 : settings.fallback;
  if (params[key] === undefined || params[key] === null) return fallback;
  const value = Number(params[key]);
  if (!Number.isFinite(value)) {
    throw new Error('"' + key + '" must be a number.');
  }
  const min = settings.min === undefined ? -Infinity : settings.min;
  const max = settings.max === undefined ? Infinity : settings.max;
  if (value < min || value > max) {
    throw new Error('"' + key + '" must be between ' + min + ' and ' + max + ' (got ' + value + ').');
  }
  return value;
}

function booleanParam(params, key, fallback) {
  if (params[key] === undefined) return fallback;
  return params[key] === true;
}

function enumParam(params, key, allowed, fallback) {
  if (params[key] === undefined || params[key] === null) return fallback;
  const value = String(params[key]);
  if (allowed.indexOf(value) === -1) {
    throw new Error('"' + key + '" must be one of: ' + allowed.join(', ') + '.');
  }
  return value;
}

function assertKeys(params, allowed, type) {
  for (const key of Object.keys(params)) {
    if (key === 'type' || key === 'name') continue;
    if (allowed.indexOf(key) === -1) {
      throw new Error(
        'Unknown parameter "' + key + '" for ' + type + '. It takes: ' + allowed.join(', ') + '.'
      );
    }
  }
}

function pair(params, key, fallback) {
  const value = params[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('"' + key + '" must be [x, y, z] with three numbers.');
  }
  return value.map((entry) => numberParam({ value: entry }, 'value', { min: -100, max: 100 }));
}

function normalizeColorBalance(params) {
  const readRow = (row, name) => {
    if (!row || typeof row !== 'object') return { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 };
    assertKeys(row, ['cyanRed', 'magentaGreen', 'yellowBlue'], name);
    return {
      cyanRed: numberParam(row, 'cyanRed', { min: -100, max: 100 }),
      magentaGreen: numberParam(row, 'magentaGreen', { min: -100, max: 100 }),
      yellowBlue: numberParam(row, 'yellowBlue', { min: -100, max: 100 }),
    };
  };
  // Two shapes are accepted: three tonal rows, or one flat row with a
  // `tonalRange` naming where it belongs.
  const hasRows = ['shadows', 'midtones', 'highlights'].some((key) => params[key] !== undefined);
  if (hasRows) {
    assertKeys(params, ['shadows', 'midtones', 'highlights'], 'colorBalance');
    return {
      shadows: readRow(params.shadows, 'colorBalance.shadows'),
      midtones: readRow(params.midtones, 'colorBalance.midtones'),
      highlights: readRow(params.highlights, 'colorBalance.highlights'),
    };
  }
  assertKeys(
    params,
    ['cyanRed', 'magentaGreen', 'yellowBlue', 'tonalRange'],
    'colorBalance'
  );
  const range = enumParam(params, 'tonalRange', ['shadows', 'midtones', 'highlights'], 'midtones');
  const row = {
    cyanRed: numberParam(params, 'cyanRed', { min: -100, max: 100 }),
    magentaGreen: numberParam(params, 'magentaGreen', { min: -100, max: 100 }),
    yellowBlue: numberParam(params, 'yellowBlue', { min: -100, max: 100 }),
  };
  return {
    shadows: range === 'shadows' ? row : { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
    midtones: range === 'midtones' ? row : { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
    highlights: range === 'highlights' ? row : { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
  };
}

function normalizeOne(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Adjustment ' + (index + 1) + ' must be an object with a "type".');
  }
  const type = String(input.type || input.name || '');
  if (!type) {
    throw new Error('Adjustment ' + (index + 1) + ' needs a "type". Supported: ' + TYPES.join(', ') + '.');
  }
  if (TYPES.indexOf(type) === -1) {
    throw new Error(
      'Unknown adjustment "' +
        type +
        '". Supported: ' +
        TYPES.join(', ') +
        '. Nothing was changed.'
    );
  }
  const params = Object.assign({}, input);
  // `name` is the layer-name parameter for adjustment layers; a LUT needs its
  // own look name, so accept `lut` (and `name` as a convenience alias) before
  // the generic name is removed.
  const lutName = input.lut !== undefined ? input.lut : input.name;
  delete params.name;
  delete params.lut;
  switch (type) {
    case 'whiteBalance':
      assertKeys(params, ['temperature', 'tint'], type);
      return {
        type: type,
        temperature: numberParam(params, 'temperature', { min: 1000, max: 40000, fallback: 6500 }),
        tint: numberParam(params, 'tint', { min: -100, max: 100 }),
      };
    case 'exposure':
      assertKeys(params, ['stops'], type);
      return { type: type, stops: numberParam(params, 'stops', { min: -10, max: 10 }) };
    case 'brightnessContrast':
      assertKeys(params, ['brightness', 'contrast'], type);
      return {
        type: type,
        brightness: numberParam(params, 'brightness', { min: -100, max: 100 }),
        contrast: numberParam(params, 'contrast', { min: -100, max: 100 }),
      };
    case 'gamma':
      assertKeys(params, ['gamma'], type);
      return { type: type, gamma: numberParam(params, 'gamma', { min: 0.01, max: 10, fallback: 1 }) };
    case 'levels':
      assertKeys(
        params,
        ['channel', 'inBlack', 'inWhite', 'gamma', 'outBlack', 'outWhite'],
        type
      );
      return {
        type: type,
        channel: enumParam(params, 'channel', CHANNELS, 'rgb'),
        inBlack: numberParam(params, 'inBlack', { min: 0, max: 255 }),
        inWhite: numberParam(params, 'inWhite', { min: 0, max: 255, fallback: 255 }),
        gamma: numberParam(params, 'gamma', { min: 0.01, max: 10, fallback: 1 }),
        outBlack: numberParam(params, 'outBlack', { min: 0, max: 255 }),
        outWhite: numberParam(params, 'outWhite', { min: 0, max: 255, fallback: 255 }),
      };
    case 'curves':
      assertKeys(params, ['channel', 'points'], type);
      if (!Array.isArray(params.points)) {
        throw new Error(
          'curves needs "points": an array of [x, y] pairs in 0–255, e.g. [[0,0],[128,140],[255,255]].'
        );
      }
      if (params.points.length < 2) {
        throw new Error('A curve needs at least two control points, each [x, y] in 0–255.');
      }
      return {
        type: type,
        channel: enumParam(params, 'channel', CHANNELS, 'rgb'),
        points: params.points,
      };
    case 'shadowsHighlights':
      assertKeys(params, ['shadows', 'highlights', 'radius'], type);
      return {
        type: type,
        shadows: numberParam(params, 'shadows', { min: -100, max: 100 }),
        highlights: numberParam(params, 'highlights', { min: -100, max: 100 }),
        radius: numberParam(params, 'radius', { min: 1, max: 100, fallback: 30 }),
      };
    case 'autoTone':
      assertKeys(params, ['mode', 'clip'], type);
      return {
        type: type,
        mode: enumParam(params, 'mode', ['contrast', 'levels', 'equalize'], 'contrast'),
        clip: numberParam(params, 'clip', { min: 0, max: 10, fallback: 0.5 }),
      };
    case 'posterize':
      assertKeys(params, ['levels'], type);
      return { type: type, levels: numberParam(params, 'levels', { min: 2, max: 255, fallback: 4 }) };
    case 'threshold':
      assertKeys(params, ['level'], type);
      return {
        type: type,
        level: numberParam(params, 'level', { min: 0, max: 255, fallback: 128 }),
      };
    case 'invert':
    case 'grayscale':
      assertKeys(params, [], type);
      return { type: type };
    case 'blackAndWhite':
      assertKeys(params, ['red', 'green', 'blue'], type);
      return {
        type: type,
        red: numberParam(params, 'red', { min: 0, max: 400, fallback: 30 }),
        green: numberParam(params, 'green', { min: 0, max: 400, fallback: 59 }),
        blue: numberParam(params, 'blue', { min: 0, max: 400, fallback: 11 }),
      };
    case 'colorBalance':
      return Object.assign({ type: type }, normalizeColorBalance(params));
    case 'hueSaturation':
      assertKeys(params, ['hue', 'saturation', 'lightness', 'band'], type);
      return {
        type: type,
        hue: numberParam(params, 'hue', { min: -180, max: 180 }),
        saturation: numberParam(params, 'saturation', { min: -100, max: 100 }),
        lightness: numberParam(params, 'lightness', { min: -100, max: 100 }),
        band: enumParam(params, 'band', HUE_BAND_NAMES, 'master'),
      };
    case 'vibrance':
      assertKeys(params, ['amount'], type);
      return { type: type, amount: numberParam(params, 'amount', { min: -100, max: 100 }) };
    case 'channelMixer':
      assertKeys(params, ['red', 'green', 'blue'], type);
      return {
        type: type,
        red: pair(params, 'red', [100, 0, 0]),
        green: pair(params, 'green', [0, 100, 0]),
        blue: pair(params, 'blue', [0, 0, 100]),
      };
    case 'gradientMap':
      assertKeys(params, ['stops'], type);
      if (!Array.isArray(params.stops) || params.stops.length < 2) {
        throw new Error(
          'gradientMap needs "stops": at least two objects like { "position": 0, "color": "#101820" }.'
        );
      }
      return {
        type: type,
        stops: params.stops.map((stop, stopIndex) => {
          if (!stop || typeof stop !== 'object') {
            throw new Error('gradientMap stop ' + (stopIndex + 1) + ' must be an object.');
          }
          assertKeys(stop, ['position', 'color'], 'gradientMap stop');
          return {
            position: numberParam(stop, 'position', { min: 0, max: 1, fallback: 0 }),
            color: stop.color === undefined ? '#000000' : stop.color,
          };
        }),
      };
    case 'lut3d':
      assertKeys(params, ['intensity'], type);
      if (typeof lutName !== 'string' || !lutName.trim()) {
        throw new Error('lut3d needs the installed `lut` name. photo_lut lists them.');
      }
      return {
        type: type,
        lut: lutName.trim(),
        intensity: numberParam(params, 'intensity', { min: 0, max: 100, fallback: 100 }),
      };
    case 'splitToning':
      assertKeys(
        params,
        ['shadowHue', 'shadowSaturation', 'highlightHue', 'highlightSaturation', 'balance'],
        type
      );
      return {
        type: type,
        shadowHue: numberParam(params, 'shadowHue', { min: 0, max: 360, fallback: 220 }),
        shadowSaturation: numberParam(params, 'shadowSaturation', { min: 0, max: 100 }),
        highlightHue: numberParam(params, 'highlightHue', { min: 0, max: 360, fallback: 40 }),
        highlightSaturation: numberParam(params, 'highlightSaturation', { min: 0, max: 100 }),
        balance: numberParam(params, 'balance', { min: 0, max: 100, fallback: 50 }),
      };
    case 'photoFilter':
      assertKeys(params, ['color', 'density'], type);
      return {
        type: type,
        color:
          params.color === undefined
            ? FILTER_COLORS.warming
            : FILTER_COLORS[params.color] || params.color,
        density: numberParam(params, 'density', { min: 0, max: 100, fallback: 25 }),
      };
    case 'clarity':
      assertKeys(params, ['amount', 'radius'], type);
      return {
        type: type,
        amount: numberParam(params, 'amount', { min: -100, max: 100 }),
        radius: numberParam(params, 'radius', { min: 1, max: 100, fallback: 30 }),
      };
    case 'dehaze':
      assertKeys(params, ['amount'], type);
      return { type: type, amount: numberParam(params, 'amount', { min: 0, max: 100 }) };
    case 'denoise':
      assertKeys(params, ['amount', 'radius', 'preserveEdges'], type);
      return {
        type: type,
        amount: numberParam(params, 'amount', { min: 0, max: 100, fallback: 50 }),
        radius: numberParam(params, 'radius', { min: 1, max: 4, fallback: 2 }),
        preserveEdges: numberParam(params, 'preserveEdges', { min: 0, max: 100, fallback: 60 }),
      };
    case 'boxBlur':
    case 'gaussianBlur':
      assertKeys(params, ['radius'], type);
      return {
        type: type,
        radius: numberParam(params, 'radius', { min: 0, max: 250, fallback: 2 }),
      };
    case 'medianBlur':
      assertKeys(params, ['radius'], type);
      return {
        type: type,
        radius: numberParam(params, 'radius', { min: 0, max: 5, fallback: 1 }),
      };
    case 'motionBlur':
      assertKeys(params, ['angle', 'distance', 'taps'], type);
      return {
        type: type,
        angle: numberParam(params, 'angle', { min: 0, max: 360 }),
        distance: numberParam(params, 'distance', { min: 1, max: 200, fallback: 10 }),
        taps: numberParam(params, 'taps', { min: 2, max: 64, fallback: 16 }),
      };
    case 'unsharpMask':
      assertKeys(params, ['amount', 'radius', 'threshold'], type);
      return {
        type: type,
        amount: numberParam(params, 'amount', { min: 0, max: 500, fallback: 100 }),
        radius: numberParam(params, 'radius', { min: 0.1, max: 100, fallback: 1 }),
        threshold: numberParam(params, 'threshold', { min: 0, max: 255 }),
      };
    case 'smartSharpen':
      assertKeys(params, ['amount', 'radius', 'threshold', 'reduceNoise'], type);
      return {
        type: type,
        amount: numberParam(params, 'amount', { min: 0, max: 500, fallback: 100 }),
        radius: numberParam(params, 'radius', { min: 0.1, max: 100, fallback: 1 }),
        threshold: numberParam(params, 'threshold', { min: 0, max: 255 }),
        reduceNoise: numberParam(params, 'reduceNoise', { min: 0, max: 100 }),
      };
    case 'vignette':
      assertKeys(params, ['amount', 'midpoint', 'feather', 'roundness'], type);
      return {
        type: type,
        amount: numberParam(params, 'amount', { min: -100, max: 100 }),
        midpoint: numberParam(params, 'midpoint', { min: 0, max: 100, fallback: 50 }),
        feather: numberParam(params, 'feather', { min: 1, max: 100, fallback: 50 }),
        roundness: numberParam(params, 'roundness', { min: -100, max: 100 }),
      };
    case 'grain':
      assertKeys(params, ['amount', 'size', 'monochrome', 'seed'], type);
      return {
        type: type,
        amount: numberParam(params, 'amount', { min: 0, max: 100 }),
        size: numberParam(params, 'size', { min: 1, max: 10, fallback: 1 }),
        monochrome: booleanParam(params, 'monochrome', true),
        seed: numberParam(params, 'seed', { min: 1, max: 2147483647, fallback: 1 }),
      };
    default:
      throw new Error('Adjustment "' + type + '" is declared but not implemented.');
  }
}

/** Validate and put a stack in the engine's fixed order. */
function normalize(input) {
  const list = Array.isArray(input) ? input : input && typeof input === 'object' ? [input] : [];
  if (!list.length) {
    throw new Error(
      'photo_adjust needs at least one adjustment: "adjustments": [{ "type": "curves", "points": [[0,0],[255,200]] }].'
    );
  }
  const normalised = list.map((item, index) => normalizeOne(item, index));
  return normalised
    .map((operation, index) => ({ operation, index, rank: ORDER.indexOf(operation.type) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.operation);
}

function summary(stack) {
  const parts = (stack || []).map((operation) => {
    switch (operation.type) {
      case 'whiteBalance':
        return 'white balance ' + Math.round(operation.temperature) + 'K' + (operation.tint ? ' tint ' + operation.tint : '');
      case 'exposure':
        return 'exposure ' + (operation.stops >= 0 ? '+' : '') + operation.stops + ' EV';
      case 'brightnessContrast':
        return 'brightness ' + operation.brightness + ' contrast ' + operation.contrast;
      case 'gamma':
        return 'gamma ' + operation.gamma;
      case 'levels':
        return 'levels ' + operation.channel;
      case 'curves':
        return 'curves ' + operation.channel + ' (' + operation.points.length + ' points)';
      case 'autoTone':
        return 'auto ' + operation.mode;
      case 'posterize':
        return 'posterize ' + operation.levels;
      case 'threshold':
        return 'threshold ' + operation.level;
      case 'invert':
        return 'inverted';
      case 'grayscale':
        return 'grayscale';
      case 'blackAndWhite':
        return 'black & white mix';
      case 'colorBalance':
        return 'colour balance';
      case 'hueSaturation':
        return operation.band === 'master'
          ? 'HSL h' + operation.hue + ' s' + operation.saturation + ' l' + operation.lightness
          : 'HSL ' + operation.band;
      case 'vibrance':
        return 'vibrance ' + operation.amount;
      case 'channelMixer':
        return 'channel mixer';
      case 'gradientMap':
        return 'gradient map';
      case 'splitToning':
        return 'split toning';
      case 'photoFilter':
        return 'photo filter ' + operation.density + '%';
      case 'clarity':
        return 'clarity ' + operation.amount;
      case 'dehaze':
        return 'dehaze ' + operation.amount;
      case 'boxBlur':
      case 'gaussianBlur':
        return operation.type.replace('Blur', ' blur ') + operation.radius;
      case 'medianBlur':
        return 'median blur ' + operation.radius;
      case 'motionBlur':
        return 'motion blur ' + operation.angle + '° ' + operation.distance + 'px';
      case 'unsharpMask':
        return 'unsharp ' + operation.amount + '% r' + operation.radius;
      case 'smartSharpen':
        return 'smart sharpen ' + operation.amount + '% r' + operation.radius;
      case 'shadowsHighlights':
        return 'shadows ' + operation.shadows + ' highlights ' + operation.highlights;
      case 'vignette':
        return 'vignette ' + operation.amount;
      case 'grain':
        return 'grain ' + operation.amount;
      case 'denoise':
        return 'denoise ' + operation.amount + ' r' + operation.radius;
      case 'lut3d':
        return 'LUT ' + operation.lut + ' ' + operation.intensity + '%';
      default:
        return operation.type;
    }
  });
  return parts.length ? parts.join(' · ') : 'no adjustments';
}

/** The tool schema advertises the names; this keeps one list, not two. */
function catalog() {
  return TYPES.map((type) => {
    switch (type) {
      case 'curves':
        return { type: type, params: ['channel?', 'points'] };
      case 'levels':
        return { type: type, params: ['channel?', 'inBlack?', 'inWhite?', 'gamma?', 'outBlack?', 'outWhite?'] };
      case 'hueSaturation':
        return { type: type, params: ['hue?', 'saturation?', 'lightness?', 'band?'] };
      case 'whiteBalance':
        return { type: type, params: ['temperature?', 'tint?'] };
      case 'brightnessContrast':
        return { type: type, params: ['brightness?', 'contrast?'] };
      case 'exposure':
        return { type: type, params: ['stops?'] };
      case 'channelMixer':
        return { type: type, params: ['red?', 'green?', 'blue?'] };
      case 'colorBalance':
        return { type: type, params: ['shadows?', 'midtones?', 'highlights?'] };
      case 'gradientMap':
        return { type: type, params: ['stops'] };
      case 'vignette':
        return { type: type, params: ['amount?', 'midpoint?', 'feather?', 'roundness?'] };
      case 'unsharpMask':
      case 'smartSharpen':
        return { type: type, params: ['amount?', 'radius?', 'threshold?'] };
      case 'motionBlur':
        return { type: type, params: ['angle?', 'distance?', 'taps?'] };
      case 'boxBlur':
      case 'gaussianBlur':
        return { type: type, params: ['radius?'] };
      case 'medianBlur':
        return { type: type, params: ['radius?'] };
      case 'grain':
        return { type: type, params: ['amount?', 'size?', 'monochrome?', 'seed?'] };
      case 'denoise':
        return { type: type, params: ['amount?', 'radius?', 'preserveEdges?'] };
      case 'lut3d':
        return { type: type, params: ['lut', 'intensity?'] };
      case 'autoTone':
        return { type: type, params: ['mode?', 'clip?'] };
      case 'posterize':
        return { type: type, params: ['levels?'] };
      case 'threshold':
        return { type: type, params: ['level?'] };
      case 'shadowsHighlights':
        return { type: type, params: ['shadows?', 'highlights?', 'radius?'] };
      case 'splitToning':
        return {
          type: type,
          params: ['shadowHue?', 'shadowSaturation?', 'highlightHue?', 'highlightSaturation?', 'balance?'],
        };
      case 'photoFilter':
        return { type: type, params: ['color?', 'density?'] };
      case 'clarity':
        return { type: type, params: ['amount?', 'radius?'] };
      case 'dehaze':
        return { type: type, params: ['amount?'] };
      case 'blackAndWhite':
        return { type: type, params: ['red?', 'green?', 'blue?'] };
      case 'vibrance':
        return { type: type, params: ['amount?'] };
      default:
        return { type: type, params: [] };
    }
  });
}

module.exports = {
  ORDER: ORDER,
  TYPES: TYPES,
  catalog: catalog,
  normalize: normalize,
  summary: summary,
};
