/*
 * The destructive effect vocabulary.
 *
 * These are the operations the adjustment stack does not cover, implemented in
 * the native engine rather than as a second JS pixel loop: polar warps, a
 * Kuwahara oil filter, rotated halftone screens, pixel sorting, bloom, mosaic,
 * wave displacement and chromatic aberration. Every parameter is validated
 * here, so the C++ side can trust every value it receives.
 */
'use strict';

const TYPES = [
  'radialBlur',
  'zoomBlur',
  'lensDistortion',
  'whirl',
  'mosaic',
  'oilify',
  'halftone',
  'pixelSort',
  'glow',
  'wave',
  'chromaticAberration',
  'motionBlur',
  'kaleidoscope',
  'stainedGlass',
  'dither',
  'glitch',
  'pencilSketch',
  'posterEdges',
  'watercolor',
  'paperGrain',
];

/**
 * The public parameter contract, in one place.
 *
 * `normalize` still owns validation, because a parameter can be an enum or a
 * colour and a table cannot express every rule. This table exists so an agent
 * can ask what an effect takes, its range and its default, without a
 * 200-parameter tool schema and without guessing. The sidebar builds its
 * controls from the same descriptions on the server side of the contract.
 */
const PARAMS = {
  radialBlur: [
    { key: 'amount', label: 'Amount', min: 1, max: 200, step: 1, default: 30, unit: 'px' },
    { key: 'centerX', label: 'Center X', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'centerY', label: 'Center Y', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'samples', label: 'Samples', min: 4, max: 64, step: 1, default: 16 },
  ],
  zoomBlur: [
    { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.15 },
    { key: 'centerX', label: 'Center X', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'centerY', label: 'Center Y', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'samples', label: 'Samples', min: 4, max: 64, step: 1, default: 18 },
  ],
  lensDistortion: [
    { key: 'k1', label: 'K1', min: -1, max: 1, step: 0.01, default: -0.25 },
    { key: 'k2', label: 'K2', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'scale', label: 'Scale', min: 0.5, max: 2, step: 0.01, default: 1 },
  ],
  whirl: [
    { key: 'angle', label: 'Angle', min: -720, max: 720, step: 5, default: 120, unit: '°' },
    { key: 'radius', label: 'Radius', min: 0.05, max: 1.5, step: 0.01, default: 0.45 },
    { key: 'centerX', label: 'Center X', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'centerY', label: 'Center Y', min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  mosaic: [{ key: 'cell', label: 'Cell', min: 2, max: 128, step: 1, default: 12, unit: 'px' }],
  oilify: [
    { key: 'radius', label: 'Radius', min: 1, max: 5, step: 1, default: 2 },
    { key: 'levels', label: 'Levels', min: 8, max: 64, step: 1, default: 24 },
  ],
  halftone: [
    { key: 'cell', label: 'Cell', min: 2, max: 64, step: 1, default: 8, unit: 'px' },
    { key: 'angle', label: 'Angle', min: 0, max: 180, step: 1, default: 15, unit: '°' },
    { key: 'ink', label: 'Ink', kind: 'color', default: '#000000' },
  ],
  pixelSort: [
    { key: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1, default: 128 },
    { key: 'direction', label: 'Direction', kind: 'enum', options: ['horizontal', 'vertical'], default: 'horizontal' },
    { key: 'minLength', label: 'Min run', min: 2, max: 512, step: 1, default: 4, unit: 'px' },
    { key: 'reverse', label: 'Reverse', kind: 'boolean', default: false },
  ],
  glow: [
    { key: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1, default: 190 },
    { key: 'radius', label: 'Radius', min: 1, max: 80, step: 1, default: 12, unit: 'px' },
    { key: 'intensity', label: 'Intensity', min: 0, max: 3, step: 0.05, default: 0.8 },
  ],
  wave: [
    { key: 'amplitude', label: 'Amplitude', min: 1, max: 100, step: 1, default: 12, unit: 'px' },
    { key: 'wavelength', label: 'Wavelength', min: 4, max: 400, step: 1, default: 48, unit: 'px' },
    { key: 'phase', label: 'Phase', min: 0, max: 360, step: 1, default: 0, unit: '°' },
    { key: 'axis', label: 'Axis', kind: 'enum', options: ['horizontal', 'vertical', 'both'], default: 'both' },
  ],
  chromaticAberration: [
    { key: 'amount', label: 'Amount', min: 0, max: 40, step: 1, default: 6, unit: 'px' },
    { key: 'angle', label: 'Angle', min: 0, max: 360, step: 1, default: 0, unit: '°' },
  ],
  motionBlur: [
    { key: 'distance', label: 'Distance', min: 1, max: 200, step: 1, default: 24, unit: 'px' },
    { key: 'angle', label: 'Angle', min: 0, max: 360, step: 1, default: 0, unit: '°' },
    { key: 'samples', label: 'Samples', min: 4, max: 64, step: 1, default: 18 },
  ],
  kaleidoscope: [
    { key: 'segments', label: 'Mirrors', min: 3, max: 24, step: 1, default: 8 },
    { key: 'angle', label: 'Angle', min: 0, max: 360, step: 1, default: 0, unit: '°' },
    { key: 'centerX', label: 'Center X', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'centerY', label: 'Center Y', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'zoom', label: 'Zoom', min: 0.2, max: 3, step: 0.01, default: 1 },
  ],
  stainedGlass: [
    { key: 'cell', label: 'Cell', min: 6, max: 96, step: 1, default: 22, unit: 'px' },
    { key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.01, default: 0.8 },
    { key: 'edge', label: 'Edge', min: 0, max: 10, step: 0.5, default: 1.5, unit: 'px' },
    { key: 'edgeColor', label: 'Edge ink', kind: 'color', default: '#0b0d11' },
  ],
  dither: [
    { key: 'levels', label: 'Levels', min: 2, max: 8, step: 1, default: 2 },
    { key: 'mode', label: 'Mode', kind: 'enum', options: ['mono', 'color'], default: 'mono' },
    { key: 'serpentine', label: 'Serpentine', kind: 'boolean', default: true },
  ],
  glitch: [
    { key: 'slices', label: 'Slices', min: 2, max: 64, step: 1, default: 12 },
    { key: 'amount', label: 'Shift', min: 0, max: 120, step: 1, default: 24, unit: 'px' },
    { key: 'rgbSplit', label: 'RGB split', min: 0, max: 60, step: 1, default: 8, unit: 'px' },
    { key: 'seed', label: 'Seed', min: 0, max: 9999, step: 1, default: 1 },
  ],
  pencilSketch: [
    { key: 'strength', label: 'Strength', min: 0, max: 100, step: 1, default: 80 },
    { key: 'detail', label: 'Detail', min: 1, max: 8, step: 1, default: 3, unit: 'px' },
    { key: 'paper', label: 'Paper', min: 0, max: 100, step: 1, default: 20 },
    { key: 'invert', label: 'White on black', kind: 'boolean', default: false },
    { key: 'seed', label: 'Seed', min: 0, max: 9999, step: 1, default: 11 },
  ],
  posterEdges: [
    { key: 'levels', label: 'Levels', min: 2, max: 12, step: 1, default: 6 },
    { key: 'edge', label: 'Edge', min: 0, max: 5, step: 0.1, default: 1.5 },
    { key: 'edgeColor', label: 'Edge ink', kind: 'color', default: '#000000' },
    { key: 'saturation', label: 'Saturation', min: 0, max: 200, step: 1, default: 110, unit: '%' },
  ],
  watercolor: [
    { key: 'radius', label: 'Wash', min: 1, max: 6, step: 1, default: 3 },
    { key: 'levels', label: 'Pigment levels', min: 6, max: 32, step: 1, default: 14 },
    { key: 'edge', label: 'Pencil edge', min: 0, max: 3, step: 0.1, default: 0.8 },
    { key: 'paper', label: 'Paper', min: 0, max: 100, step: 1, default: 15 },
    { key: 'seed', label: 'Seed', min: 0, max: 9999, step: 1, default: 5 },
  ],
  paperGrain: [
    { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, default: 35 },
    { key: 'scale', label: 'Scale', min: 1, max: 20, step: 1, default: 4, unit: 'px' },
    { key: 'fiber', label: 'Fibre', min: 0, max: 100, step: 1, default: 50 },
    { key: 'seed', label: 'Seed', min: 0, max: 9999, step: 1, default: 7 },
  ],
};

function numberIn(value, min, max, label, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(label + ' must be a number.');
  if (parsed < min || parsed > max) {
    throw new Error(label + ' must be between ' + min + ' and ' + max + ' (got ' + parsed + ').');
  }
  return parsed;
}

function enumIn(value, allowed, label, fallback) {
  if (value === undefined || value === null) return fallback;
  if (allowed.indexOf(value) === -1) {
    throw new Error(label + ' must be one of: ' + allowed.join(', ') + '.');
  }
  return value;
}

function boolIn(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(label + ' must be true or false.');
  return value;
}

function hex(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) {
    throw new Error(label + ' must be a #rrggbb colour.');
  }
  return value.trim();
}

function assertKeys(params, allowed, type) {
  for (const key of Object.keys(params)) {
    if (key === 'effect' || key === 'type') continue;
    if (allowed.indexOf(key) === -1) {
      throw new Error(
        'Unknown parameter "' + key + '" for ' + type + '. It takes: ' + allowed.join(', ') + '.'
      );
    }
  }
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('photo_effect needs an object with an "effect" name.');
  }
  const type = String(input.effect || input.type || '');
  if (!type) {
    throw new Error('photo_effect needs "effect": one of ' + TYPES.join(', ') + '.');
  }
  if (TYPES.indexOf(type) === -1) {
    throw new Error('Unknown effect "' + type + '". Use one of: ' + TYPES.join(', ') + '.');
  }
  const params = Object.assign({}, input);

  switch (type) {
    case 'radialBlur':
      assertKeys(params, ['amount', 'centerX', 'centerY', 'samples'], type);
      return {
        effect: type,
        amount: numberIn(params.amount, 1, 200, 'amount', 30),
        centerX: numberIn(params.centerX, 0, 1, 'centerX', 0.5),
        centerY: numberIn(params.centerY, 0, 1, 'centerY', 0.5),
        samples: Math.round(numberIn(params.samples, 4, 64, 'samples', 16)),
      };
    case 'zoomBlur':
      assertKeys(params, ['amount', 'centerX', 'centerY', 'samples'], type);
      return {
        effect: type,
        amount: numberIn(params.amount, 0, 1, 'amount', 0.15),
        centerX: numberIn(params.centerX, 0, 1, 'centerX', 0.5),
        centerY: numberIn(params.centerY, 0, 1, 'centerY', 0.5),
        samples: Math.round(numberIn(params.samples, 4, 64, 'samples', 18)),
      };
    case 'lensDistortion':
      assertKeys(params, ['k1', 'k2', 'scale'], type);
      return {
        effect: type,
        k1: numberIn(params.k1, -1, 1, 'k1', -0.25),
        k2: numberIn(params.k2, -1, 1, 'k2', 0),
        scale: numberIn(params.scale, 0.5, 2, 'scale', 1),
      };
    case 'whirl':
      assertKeys(params, ['angle', 'radius', 'centerX', 'centerY'], type);
      return {
        effect: type,
        angle: numberIn(params.angle, -720, 720, 'angle', 120),
        radius: numberIn(params.radius, 0.05, 1.5, 'radius', 0.45),
        centerX: numberIn(params.centerX, 0, 1, 'centerX', 0.5),
        centerY: numberIn(params.centerY, 0, 1, 'centerY', 0.5),
      };
    case 'mosaic':
      assertKeys(params, ['cell'], type);
      return { effect: type, cell: Math.round(numberIn(params.cell, 2, 128, 'cell', 12)) };
    case 'oilify':
      assertKeys(params, ['radius', 'levels'], type);
      return {
        effect: type,
        radius: Math.round(numberIn(params.radius, 1, 5, 'radius', 2)),
        levels: Math.round(numberIn(params.levels, 8, 64, 'levels', 24)),
      };
    case 'halftone':
      assertKeys(params, ['cell', 'angle', 'ink'], type);
      return {
        effect: type,
        cell: Math.round(numberIn(params.cell, 2, 64, 'cell', 8)),
        angle: numberIn(params.angle, 0, 180, 'angle', 15),
        ink: hex(params.ink, 'ink', '#000000'),
      };
    case 'pixelSort':
      assertKeys(params, ['threshold', 'direction', 'reverse', 'minLength'], type);
      return {
        effect: type,
        threshold: numberIn(params.threshold, 0, 255, 'threshold', 128),
        direction: enumIn(params.direction, ['horizontal', 'vertical'], 'direction', 'horizontal'),
        reverse: boolIn(params.reverse, 'reverse', false),
        minLength: Math.round(numberIn(params.minLength, 2, 512, 'minLength', 4)),
      };
    case 'glow':
      assertKeys(params, ['threshold', 'radius', 'intensity'], type);
      return {
        effect: type,
        threshold: numberIn(params.threshold, 0, 255, 'threshold', 190),
        radius: Math.round(numberIn(params.radius, 1, 80, 'radius', 12)),
        intensity: numberIn(params.intensity, 0, 3, 'intensity', 0.8),
      };
    case 'wave':
      assertKeys(params, ['amplitude', 'wavelength', 'phase', 'axis'], type);
      return {
        effect: type,
        amplitude: numberIn(params.amplitude, 1, 100, 'amplitude', 12),
        wavelength: numberIn(params.wavelength, 4, 400, 'wavelength', 48),
        phase: numberIn(params.phase, 0, 360, 'phase', 0),
        axis: enumIn(params.axis, ['horizontal', 'vertical', 'both'], 'axis', 'both'),
      };
    case 'chromaticAberration':
      assertKeys(params, ['amount', 'angle'], type);
      return {
        effect: type,
        amount: numberIn(params.amount, 0, 40, 'amount', 6),
        angle: numberIn(params.angle, 0, 360, 'angle', 0),
      };
    case 'motionBlur':
      assertKeys(params, ['distance', 'angle', 'samples'], type);
      return {
        effect: type,
        distance: numberIn(params.distance, 1, 200, 'distance', 24),
        angle: numberIn(params.angle, 0, 360, 'angle', 0),
        samples: Math.round(numberIn(params.samples, 4, 64, 'samples', 18)),
      };
    case 'kaleidoscope':
      assertKeys(params, ['segments', 'angle', 'centerX', 'centerY', 'zoom'], type);
      return {
        effect: type,
        segments: Math.round(numberIn(params.segments, 3, 24, 'segments', 8)),
        angle: numberIn(params.angle, 0, 360, 'angle', 0),
        centerX: numberIn(params.centerX, 0, 1, 'centerX', 0.5),
        centerY: numberIn(params.centerY, 0, 1, 'centerY', 0.5),
        zoom: numberIn(params.zoom, 0.2, 3, 'zoom', 1),
      };
    case 'stainedGlass':
      assertKeys(params, ['cell', 'jitter', 'edge', 'edgeColor'], type);
      return {
        effect: type,
        cell: Math.round(numberIn(params.cell, 6, 96, 'cell', 22)),
        jitter: numberIn(params.jitter, 0, 1, 'jitter', 0.8),
        edge: numberIn(params.edge, 0, 10, 'edge', 1.5),
        edgeColor: hex(params.edgeColor, 'edgeColor', '#0b0d11'),
      };
    case 'dither':
      assertKeys(params, ['levels', 'mode', 'serpentine'], type);
      return {
        effect: type,
        levels: Math.round(numberIn(params.levels, 2, 8, 'levels', 2)),
        mode: enumIn(params.mode, ['mono', 'color'], 'mode', 'mono'),
        serpentine: boolIn(params.serpentine, 'serpentine', true),
      };
    case 'glitch':
      assertKeys(params, ['slices', 'amount', 'rgbSplit', 'seed'], type);
      return {
        effect: type,
        slices: Math.round(numberIn(params.slices, 2, 64, 'slices', 12)),
        amount: numberIn(params.amount, 0, 120, 'amount', 24),
        rgbSplit: numberIn(params.rgbSplit, 0, 60, 'rgbSplit', 8),
        seed: Math.round(numberIn(params.seed, 0, 9999, 'seed', 1)),
      };
    case 'pencilSketch':
      assertKeys(params, ['strength', 'detail', 'paper', 'invert', 'seed'], type);
      return {
        effect: type,
        strength: numberIn(params.strength, 0, 100, 'strength', 80),
        detail: Math.round(numberIn(params.detail, 1, 8, 'detail', 3)),
        paper: numberIn(params.paper, 0, 100, 'paper', 20),
        invert: boolIn(params.invert, 'invert', false),
        seed: Math.round(numberIn(params.seed, 0, 9999, 'seed', 11)),
      };
    case 'posterEdges':
      assertKeys(params, ['levels', 'edge', 'edgeColor', 'saturation'], type);
      return {
        effect: type,
        levels: Math.round(numberIn(params.levels, 2, 12, 'levels', 6)),
        edge: numberIn(params.edge, 0, 5, 'edge', 1.5),
        edgeColor: hex(params.edgeColor, 'edgeColor', '#000000'),
        saturation: numberIn(params.saturation, 0, 200, 'saturation', 110),
      };
    case 'watercolor':
      assertKeys(params, ['radius', 'levels', 'edge', 'paper', 'seed'], type);
      return {
        effect: type,
        radius: Math.round(numberIn(params.radius, 1, 6, 'radius', 3)),
        levels: Math.round(numberIn(params.levels, 6, 32, 'levels', 14)),
        edge: numberIn(params.edge, 0, 3, 'edge', 0.8),
        paper: numberIn(params.paper, 0, 100, 'paper', 15),
        seed: Math.round(numberIn(params.seed, 0, 9999, 'seed', 5)),
      };
    case 'paperGrain':
      assertKeys(params, ['amount', 'scale', 'fiber', 'seed'], type);
      return {
        effect: type,
        amount: numberIn(params.amount, 0, 100, 'amount', 35),
        scale: numberIn(params.scale, 1, 20, 'scale', 4),
        fiber: numberIn(params.fiber, 0, 100, 'fiber', 50),
        seed: Math.round(numberIn(params.seed, 0, 9999, 'seed', 7)),
      };
    default:
      throw new Error('Effect "' + type + '" is declared but not implemented.');
  }
}

function summary(effect) {
  switch (effect.effect) {
    case 'radialBlur':
      return 'radial blur ' + effect.amount;
    case 'zoomBlur':
      return 'zoom blur ' + Math.round(effect.amount * 100) + '%';
    case 'lensDistortion':
      return 'lens distortion k1 ' + effect.k1;
    case 'whirl':
      return 'whirl ' + effect.angle + '°';
    case 'mosaic':
      return 'mosaic ' + effect.cell + 'px';
    case 'oilify':
      return 'oil paint r' + effect.radius + ' ' + effect.levels + ' levels';
    case 'halftone':
      return 'halftone ' + effect.cell + 'px ' + effect.angle + '°';
    case 'pixelSort':
      return 'pixel sort ' + effect.direction + ' >' + effect.threshold;
    case 'glow':
      return 'glow >' + effect.threshold + ' r' + effect.radius;
    case 'wave':
      return 'wave ' + effect.amplitude + 'px / ' + effect.wavelength + 'px';
    case 'chromaticAberration':
      return 'chromatic aberration ' + effect.amount + 'px';
    case 'motionBlur':
      return 'motion blur ' + effect.distance + 'px ' + effect.angle + '°';
    case 'kaleidoscope':
      return 'kaleidoscope ' + effect.segments + ' mirrors';
    case 'stainedGlass':
      return 'stained glass ' + effect.cell + 'px cells';
    case 'dither':
      return 'dither ' + effect.levels + ' levels · ' + effect.mode;
    case 'glitch':
      return 'glitch ' + effect.slices + ' slices · ' + effect.amount + 'px';
    case 'pencilSketch':
      return 'pencil sketch ' + effect.strength + '% · detail ' + effect.detail;
    case 'posterEdges':
      return 'poster edges ' + effect.levels + ' levels · edge ' + effect.edge;
    case 'watercolor':
      return 'watercolour wash ' + effect.radius + ' · ' + effect.levels + ' pigment levels';
    case 'paperGrain':
      return 'paper grain ' + effect.amount + '% · ' + effect.scale + 'px fibre';
    default:
      return effect.effect;
  }
}

function jobFor(effect, options) {
  const settings = options || {};
  if (!settings.inputPath || !settings.outputPath) {
    throw new Error('The effect job needs an input and an output path.');
  }
  const width = Math.round(Number(settings.width));
  const height = Math.round(Number(settings.height));
  if (!(width > 0 && height > 0)) throw new Error('Effect dimensions must be positive.');
  const lines = [
    'effect ' + effect.effect,
    'in ' + settings.inputPath,
    'out ' + settings.outputPath,
    'width ' + width,
    'height ' + height,
  ];
  for (const [key, value] of Object.entries(effect)) {
    if (key === 'effect') continue;
    lines.push(key + ' ' + (typeof value === 'boolean' ? (value ? 1 : 0) : value));
  }
  lines.push('');
  return lines.join('\n');
}

function catalog() {
  return TYPES.slice();
}

/** One effect's parameter contract, or null when the name is not supported. */
function describe(type) {
  const name = String(type);
  if (TYPES.indexOf(name) === -1) return null;
  return {
    effect: name,
    summary: summary(normalize({ effect: name })),
    params: (PARAMS[name] || []).map((param) => Object.assign({}, param)),
  };
}

function describeAll() {
  return TYPES.map((type) => describe(type));
}

module.exports = {
  PARAMS: PARAMS,
  TYPES: TYPES,
  catalog: catalog,
  describe: describe,
  describeAll: describeAll,
  jobFor: jobFor,
  normalize: normalize,
  summary: summary,
};
