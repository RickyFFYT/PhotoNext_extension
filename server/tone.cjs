/*
 * Tone and colour arithmetic, with no pixels and no I/O.
 *
 * Everything the engine does that can be expressed as "input byte → output
 * byte" lives here as a 256-entry lookup table, because that is the only shape
 * a golden test can pin exactly. The matrices and conversions that need
 * neighbouring pixels live in `pixels.cjs`; the backend only ever carries the
 * buffer between them.
 *
 * Convention: LUTs are plain 256-entry arrays of integers 0–255. Curves and
 * gradient stops speak Photoshop's 0–255 control points; exposure and white
 * balance do their work in linear light and come back to sRGB.
 */
'use strict';

function clampByte(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return number < min ? min : number > max ? max : number;
}

function srgbToLinear(value) {
  const v = clamp01(value);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value) {
  const v = clamp01(value);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function identityLut() {
  const lut = new Array(256);
  for (let value = 0; value < 256; value += 1) lut[value] = value;
  return lut;
}

/** Build a LUT from a normalised (0–1) function. */
function mapLut(fn) {
  const lut = new Array(256);
  for (let value = 0; value < 256; value += 1) lut[value] = clampByte(fn(value / 255) * 255);
  return lut;
}

/** Photoshop's brightness (−100…100) and contrast (−100…100), in one pass. */
function brightnessContrastLut(brightness, contrast) {
  const add = clampNumber(brightness, -100, 100) * 2.55;
  const limit = clampNumber(contrast, -99, 99);
  const factor = (100 + limit) / (100 - limit);
  return mapLut((v) => (v - 0.5) * factor + 0.5 + add / 255);
}

/** Exposure in stops: a linear-light multiply, so +1 stop is exactly twice the light. */
function exposureLut(stops) {
  const gain = Math.pow(2, clampNumber(stops, -10, 10));
  return mapLut((v) => linearToSrgb(srgbToLinear(v) * gain));
}

function gammaLut(gamma) {
  const value = clampNumber(gamma, 0.01, 10);
  if (value === 1) return identityLut();
  return mapLut((v) => Math.pow(v, 1 / value));
}

/**
 * Levels: input black/white, gamma, output black/white. With the defaults this
 * is the identity, which is what makes it safe to compose.
 */
function levelsLut(levels) {
  const settings = levels || {};
  // The white points default to 255, not to the clamp minimum: an omitted level
  // must be neutral, and `clampNumber` would otherwise read undefined as 0.
  const inBlack = clampNumber(settings.inBlack === undefined ? 0 : settings.inBlack, 0, 255) / 255;
  const inWhite = clampNumber(settings.inWhite === undefined ? 255 : settings.inWhite, 0, 255) / 255;
  const outBlack = clampNumber(settings.outBlack === undefined ? 0 : settings.outBlack, 0, 255) / 255;
  const outWhite = clampNumber(settings.outWhite === undefined ? 255 : settings.outWhite, 0, 255) / 255;
  const gamma = clampNumber(settings.gamma === undefined ? 1 : settings.gamma, 0.01, 10);
  const span = Math.max(1 / 255, inWhite - inBlack);
  return mapLut((v) => {
    let t = clamp01((v - inBlack) / span);
    if (gamma !== 1) t = Math.pow(t, 1 / gamma);
    return outBlack + t * (outWhite - outBlack);
  });
}

function normalizeCurvePoints(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error(
      'A curve needs at least two control points, each [x, y] in 0–255 (for example [[0,0],[255,255]]).'
    );
  }
  const parsed = points.map((point, index) => {
    const pair = Array.isArray(point) ? point : [point && point.x, point && point.y];
    const x = Number(pair[0]);
    const y = Number(pair[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Curve point ' + (index + 1) + ' needs a numeric x and y.');
    }
    return { x: clampNumber(x, 0, 255), y: clampNumber(y, 0, 255) };
  });
  parsed.sort((a, b) => a.x - b.x);
  const unique = [];
  for (const point of parsed) {
    const last = unique[unique.length - 1];
    if (last && Math.abs(last.x - point.x) < 1e-6) unique[unique.length - 1] = point;
    else unique.push(point);
  }
  if (unique.length < 2) {
    throw new Error('A curve needs two control points with different x values.');
  }
  return unique;
}

/**
 * A monotone cubic (Fritsch–Carlson) curve through the control points.
 *
 * Monotone rather than plain Catmull-Rom on purpose: a photo curve that
 * overshoots between two points invents tone the user never asked for, and the
 * overshoot is visible as a halo. With two points this is the identity curve
 * exactly, which the tests rely on.
 */
function curvesLut(points) {
  const pts = normalizeCurvePoints(points);
  const n = pts.length;
  const slopes = [];
  for (let index = 0; index < n - 1; index += 1) {
    slopes.push((pts[index + 1].y - pts[index].y) / (pts[index + 1].x - pts[index].x));
  }
  const tangents = new Array(n);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];
  for (let index = 1; index < n - 1; index += 1) {
    const left = slopes[index - 1];
    const right = slopes[index];
    if (left * right <= 0) {
      tangents[index] = 0;
    } else {
      const limit = 3 * Math.min(Math.abs(left), Math.abs(right));
      tangents[index] = Math.max(-limit, Math.min(limit, (left + right) / 2));
    }
  }

  const lut = new Array(256);
  for (let value = 0; value < 256; value += 1) {
    if (value <= pts[0].x) {
      lut[value] = clampByte(pts[0].y);
      continue;
    }
    if (value >= pts[n - 1].x) {
      lut[value] = clampByte(pts[n - 1].y);
      continue;
    }
    let segment = 0;
    while (segment < n - 2 && value > pts[segment + 1].x) segment += 1;
    const width = pts[segment + 1].x - pts[segment].x;
    const t = (value - pts[segment].x) / width;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    lut[value] = clampByte(
      h00 * pts[segment].y +
        h10 * width * tangents[segment] +
        h01 * pts[segment + 1].y +
        h11 * width * tangents[segment + 1]
    );
  }
  return lut;
}

function posterizeLut(levels) {
  const steps = Math.max(2, Math.min(255, Math.round(Number(levels) || 4)));
  return mapLut((v) => Math.round(v * (steps - 1)) / (steps - 1));
}

function thresholdLut(level) {
  const cut = clampNumber(level, 0, 255);
  return mapLut((v) => (v * 255 >= cut ? 1 : 0));
}

function invertLut() {
  const lut = new Array(256);
  for (let value = 0; value < 256; value += 1) lut[value] = 255 - value;
  return lut;
}

/** Percentile of a 256-bin histogram, for auto-tone clipping. */
function percentileValue(histogram, fraction) {
  const counts = histogram || [];
  let total = 0;
  for (let index = 0; index < 256; index += 1) total += counts[index] || 0;
  if (!total) return null;
  const target = Math.min(1, Math.max(0, fraction)) * total;
  let running = 0;
  for (let index = 0; index < 256; index += 1) {
    running += counts[index] || 0;
    // `running > 0` matters for a 0% clip: the first *used* bin is the low end,
    // not an empty bin zero at index zero.
    if (running > 0 && running >= target) return index;
  }
  return 255;
}

/** Stretch the used part of a channel to the full range. */
function stretchLut(histogram, clipPercent) {
  const clip = clampNumber(clipPercent, 0, 10) / 100;
  const low = percentileValue(histogram, clip);
  const high = percentileValue(histogram, 1 - clip);
  if (low === null || high === null || high <= low) return identityLut();
  const scale = 255 / (high - low);
  return mapLut((v) => {
    const byte = v * 255;
    if (byte <= low) return 0;
    if (byte >= high) return 1;
    return (byte - low) * scale / 255;
  });
}

function autoContrastLut(histogram, clipPercent) {
  return stretchLut(histogram, clipPercent);
}

function equalizeLut(histogram) {
  const counts = histogram || [];
  let total = 0;
  for (let index = 0; index < 256; index += 1) total += counts[index] || 0;
  if (!total) return identityLut();
  const lut = new Array(256);
  let running = 0;
  for (let index = 0; index < 256; index += 1) {
    running += counts[index] || 0;
    lut[index] = clampByte((running / total) * 255);
  }
  return lut;
}

/**
 * Kelvin → sRGB, the standard approximation, then normalised against 6500 K so
 * that the neutral setting is exactly 1.0 and not "almost white".
 */
function kelvinToRgb(kelvin) {
  const temperature = clampNumber(kelvin, 1000, 40000) / 100;
  let red;
  let green;
  let blue;
  if (temperature <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temperature) - 161.1195681661;
    blue =
      temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * Math.pow(temperature - 60, -0.1332047592);
    green = 288.1221695283 * Math.pow(temperature - 60, -0.0755148492);
    blue = 255;
  }
  return { r: clampByte(red) / 255, g: clampByte(green) / 255, b: clampByte(blue) / 255 };
}

/**
 * Temperature and tint as channel gains. 6500 K / 0 tint is the identity, by
 * construction: the gains are ratios against the 6500 K reference.
 */
function whiteBalanceGains(temperature, tint) {
  const target = kelvinToRgb(temperature === undefined ? 6500 : temperature);
  const reference = kelvinToRgb(6500);
  const gains = {
    r: target.r / reference.r,
    g: target.g / reference.g,
    b: target.b / reference.b,
  };
  const magenta = clampNumber(tint, -100, 100) / 100;
  gains.g *= 1 - magenta * 0.2;
  gains.r *= 1 + magenta * 0.1;
  gains.b *= 1 + magenta * 0.1;
  const green = gains.g || 1;
  return { r: gains.r / green, g: 1, b: gains.b / green };
}

/** A 3×3 channel mixer in percent, as fractional rows. */
function channelMixerMatrix(mixer) {
  const settings = mixer || {};
  const row = (values, fallback) => {
    const source = Array.isArray(values) ? values : fallback;
    return [
      clampNumber(source[0], -200, 200) / 100,
      clampNumber(source[1], -200, 200) / 100,
      clampNumber(source[2], -200, 200) / 100,
    ];
  };
  return [
    row(settings.red, [100, 0, 0]),
    row(settings.green, [0, 100, 0]),
    row(settings.blue, [0, 0, 100]),
  ];
}

function blackAndWhiteWeights(mixer) {
  const settings = mixer || {};
  return {
    red: clampNumber(settings.red === undefined ? 30 : settings.red, 0, 400) / 100,
    green: clampNumber(settings.green === undefined ? 59 : settings.green, 0, 400) / 100,
    blue: clampNumber(settings.blue === undefined ? 11 : settings.blue, 0, 400) / 100,
  };
}

function parseColor(value, fallback) {
  if (value && typeof value === 'object') {
    return {
      r: clampByte(Number(value.r)),
      g: clampByte(Number(value.g)),
      b: clampByte(Number(value.b)),
    };
  }
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || ''));
  if (!match) {
    if (fallback) return fallback;
    throw new Error('Colour "' + value + '" is not a hex value like #ff8800.');
  }
  const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/**
 * A gradient map as 256 RGB entries: luminance selects a stop, which is how
 * duotone and split-tone looks are built from one table.
 */
function gradientMapLut(stops) {
  if (!Array.isArray(stops) || stops.length < 2) {
    throw new Error('A gradient map needs at least two stops: { position: 0–1, color: "#rrggbb" }.');
  }
  const parsed = stops
    .map((stop, index) => {
      const position = Number(stop && stop.position);
      if (!Number.isFinite(position)) {
        throw new Error('Gradient stop ' + (index + 1) + ' needs a numeric position between 0 and 1.');
      }
      return { position: clamp01(position), color: parseColor(stop.color) };
    })
    .sort((a, b) => a.position - b.position);
  const lut = new Array(256);
  for (let value = 0; value < 256; value += 1) {
    const position = value / 255;
    if (position <= parsed[0].position) {
      lut[value] = [parsed[0].color.r, parsed[0].color.g, parsed[0].color.b];
      continue;
    }
    const last = parsed[parsed.length - 1];
    if (position >= last.position) {
      lut[value] = [last.color.r, last.color.g, last.color.b];
      continue;
    }
    let segment = 0;
    while (segment < parsed.length - 2 && position > parsed[segment + 1].position) segment += 1;
    const left = parsed[segment];
    const right = parsed[segment + 1];
    const t = (position - left.position) / Math.max(1e-6, right.position - left.position);
    lut[value] = [
      clampByte(left.color.r + (right.color.r - left.color.r) * t),
      clampByte(left.color.g + (right.color.g - left.color.g) * t),
      clampByte(left.color.b + (right.color.b - left.color.b) * t),
    ];
  }
  return lut;
}

/** Rec. 709 luminance of 0–255 channels. */
function luma(red, green, blue) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** RGB (0–255) → HSL, with h in degrees and s/l in 0–1. */
function rgbToHsl(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  if (max !== min) {
    const delta = max - min;
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
    else if (max === g) hue = ((b - r) / delta + 2) * 60;
    else hue = ((r - g) / delta + 4) * 60;
  }
  return { h: hue, s: saturation, l: lightness };
}

/** HSL → RGB, with h in degrees and s/l in 0–1, returned as 0–255 floats. */
function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp01(saturation);
  const l = clamp01(lightness);
  if (s === 0) {
    const value = l * 255;
    return { r: value, g: value, b: value };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return {
    r: channel(h / 360 + 1 / 3) * 255,
    g: channel(h / 360) * 255,
    b: channel(h / 360 - 1 / 3) * 255,
  };
}

/** The eight Photoshop hue bands, as triangular windows around their centre. */
const HUE_BANDS = {
  reds: { center: 0, width: 30 },
  oranges: { center: 30, width: 30 },
  yellows: { center: 60, width: 30 },
  greens: { center: 120, width: 60 },
  aquas: { center: 180, width: 60 },
  blues: { center: 240, width: 60 },
  purples: { center: 285, width: 45 },
  magentas: { center: 330, width: 30 },
};

function bandWeight(name, hue) {
  const band = HUE_BANDS[name];
  if (!band) return 0;
  const distance = Math.abs((((hue - band.center + 540) % 360) - 180));
  return clamp01(1 - distance / band.width);
}

/** Apply white balance gains to one pixel's channels. */
function applyGains(red, green, blue, gains) {
  return {
    r: clampByte(red * gains.r),
    g: clampByte(green * gains.g),
    b: clampByte(blue * gains.b),
  };
}

module.exports = {
  HUE_BANDS: HUE_BANDS,
  applyGains: applyGains,
  autoContrastLut: autoContrastLut,
  bandWeight: bandWeight,
  blackAndWhiteWeights: blackAndWhiteWeights,
  brightnessContrastLut: brightnessContrastLut,
  channelMixerMatrix: channelMixerMatrix,
  clamp01: clamp01,
  clampByte: clampByte,
  clampNumber: clampNumber,
  curvesLut: curvesLut,
  equalizeLut: equalizeLut,
  exposureLut: exposureLut,
  gammaLut: gammaLut,
  gradientMapLut: gradientMapLut,
  hslToRgb: hslToRgb,
  identityLut: identityLut,
  invertLut: invertLut,
  kelvinToRgb: kelvinToRgb,
  levelsLut: levelsLut,
  linearToSrgb: linearToSrgb,
  luma: luma,
  mapLut: mapLut,
  parseColor: parseColor,
  percentileValue: percentileValue,
  posterizeLut: posterizeLut,
  rgbToHsl: rgbToHsl,
  srgbToLinear: srgbToLinear,
  stretchLut: stretchLut,
  thresholdLut: thresholdLut,
  whiteBalanceGains: whiteBalanceGains,
};
