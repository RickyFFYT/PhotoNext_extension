/*
 * Pixel passes: the half of the engine that needs neighbours.
 *
 * These run on a raw RGBA buffer (`{ data, width, height, channels }`) that the
 * backend decoded, banded 512 rows at a time so a 80 MP document never needs a
 * second full-size copy just to apply a LUT. Everything here mutates or returns
 * raw buffers; encoding is the engine's business.
 *
 * Alpha is carried through untouched by colour passes. A blur blurs RGB only —
 * blurring alpha would feather an opaque layer into its neighbours, which is a
 * mask operation, not a blur.
 */
'use strict';

const blendModule = require('./blend.cjs');
const stylesModule = require('./styles.cjs');
const tone = require('./tone.cjs');
const transformModule = require('./transform.cjs');

const BAND_ROWS = 512;
const CHANNELS = 4;

function clampByte(value) {
  return tone.clampByte(value);
}

function lumaAt(data, index) {
  return tone.luma(data[index], data[index + 1], data[index + 2]);
}

/**
 * An optional numeric parameter with its documented default.
 *
 * `tone.clampNumber` maps a missing value to the *minimum* (which is right for
 * "0 to 255" but wrong for "−100 to 100"), so every optional pixel parameter
 * goes through here instead.
 */
function number(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  return tone.clampNumber(value, min, max);
}

/** Walk the buffer in 512-row bands (the documented raw-pass budget). */
function forEachBand(raw, visit) {
  const { data, width, height, channels } = raw;
  const rowBytes = width * channels;
  for (let startRow = 0; startRow < height; startRow += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, height - startRow);
    visit(data, startRow * rowBytes, (startRow + rows) * rowBytes);
  }
}

function applyLuts(raw, luts) {
  // One LUT for all channels, or three: a LUT is itself an array, so the first
  // entry is what distinguishes "[256 numbers]" from "[redLut, greenLut, blueLut]".
  const perChannel = Array.isArray(luts) && Array.isArray(luts[0]);
  const red = perChannel ? luts[0] : Array.isArray(luts) ? luts : luts.red;
  const green = perChannel ? luts[1] || luts[0] : Array.isArray(luts) ? luts : luts.green;
  const blue = perChannel ? luts[2] || luts[0] : Array.isArray(luts) ? luts : luts.blue;
  const channels = raw.channels || CHANNELS;
  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      data[index] = red[data[index]];
      data[index + 1] = green[data[index + 1]];
      data[index + 2] = blue[data[index + 2]];
    }
  });
  return raw;
}

function applyOperationToChannel(raw, channelIndex, lut) {
  const luts = [tone.identityLut(), tone.identityLut(), tone.identityLut()];
  luts[channelIndex] = lut;
  return applyLuts(raw, luts);
}

function applyMatrix(raw, matrix) {
  const channels = raw.channels || CHANNELS;
  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      data[index] = clampByte(r * matrix[0][0] + g * matrix[0][1] + b * matrix[0][2]);
      data[index + 1] = clampByte(r * matrix[1][0] + g * matrix[1][1] + b * matrix[1][2]);
      data[index + 2] = clampByte(r * matrix[2][0] + g * matrix[2][1] + b * matrix[2][2]);
    }
  });
  return raw;
}

function applyGains(raw, gains) {
  const channels = raw.channels || CHANNELS;
  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      const balanced = tone.applyGains(data[index], data[index + 1], data[index + 2], gains);
      data[index] = balanced.r;
      data[index + 1] = balanced.g;
      data[index + 2] = balanced.b;
    }
  });
  return raw;
}

function applyOpacity(raw, opacity) {
  const factor = tone.clamp01(opacity);
  if (factor >= 1) return raw;
  const channels = raw.channels || CHANNELS;
  for (let index = 3; index < raw.data.length; index += channels) {
    raw.data[index] = clampByte(raw.data[index] * factor);
  }
  return raw;
}

/**
 * Hue/saturation/lightness, master or one hue band.
 *
 * Saturation scales rather than offsets, so an achromatic pixel stays
 * achromatic: "saturation +50" must not tint a grey wall. Vibrance additionally
 * weights by how unsaturated a pixel already is, which is the whole point of it.
 */
function applyHsl(raw, spec) {
  const channels = raw.channels || CHANNELS;
  const hueShift = number(spec.hue, 0, -180, 180);
  const saturationShift = number(spec.saturation, 0, -100, 100) / 100;
  const lightnessShift = number(spec.lightness, 0, -100, 100) / 100;
  const vibrance = number(spec.vibrance, 0, -100, 100) / 100;
  const band = spec.band && spec.band !== 'master' ? spec.band : null;

  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      const hsl = tone.rgbToHsl(data[index], data[index + 1], data[index + 2]);
      const weight = band ? tone.bandWeight(band, hsl.h) : 1;
      if (!weight && !vibrance) continue;
      let h = hsl.h;
      let s = hsl.s;
      let l = hsl.l;
      if (hueShift) h = (h + hueShift * weight + 360) % 360;
      if (saturationShift) s = tone.clamp01(s * (1 + saturationShift * weight));
      if (lightnessShift) {
        const amount = lightnessShift * weight;
        l = tone.clamp01(l + amount * (amount > 0 ? 1 - l : l));
      }
      if (vibrance) s = tone.clamp01(s * (1 + vibrance * (1 - s)));
      if (h === hsl.h && s === hsl.s && l === hsl.l) continue;
      const rgb = tone.hslToRgb(h, s, l);
      data[index] = clampByte(rgb.r);
      data[index + 1] = clampByte(rgb.g);
      data[index + 2] = clampByte(rgb.b);
    }
  });
  return raw;
}

/**
 * Colour balance: cyan–red, magenta–green, yellow–blue, weighted by tonal range
 * so a midtone slider leaves the highlights alone.
 */
function applyColorBalance(raw, spec) {
  const channels = raw.channels || CHANNELS;
  const rows = spec || {};
  const read = (row) => [
    number(row && row.cyanRed, 0, -100, 100),
    number(row && row.magentaGreen, 0, -100, 100),
    number(row && row.yellowBlue, 0, -100, 100),
  ];
  const shadows = read(rows.shadows);
  const midtones = read(rows.midtones);
  const highlights = read(rows.highlights);
  if (!shadows.some(Boolean) && !midtones.some(Boolean) && !highlights.some(Boolean)) return raw;

  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      const l = lumaAt(data, index) / 255;
      const shadowWeight = (1 - l) * (1 - l);
      const highlightWeight = l * l;
      const midWeight = Math.max(0, 1 - shadowWeight - highlightWeight);
      const cr = (shadows[0] * shadowWeight + midtones[0] * midWeight + highlights[0] * highlightWeight) / 100;
      const mg = (shadows[1] * shadowWeight + midtones[1] * midWeight + highlights[1] * highlightWeight) / 100;
      const yb = (shadows[2] * shadowWeight + midtones[2] * midWeight + highlights[2] * highlightWeight) / 100;
      data[index] = clampByte(data[index] + cr * 127.5);
      data[index + 1] = clampByte(data[index + 1] + mg * 127.5);
      data[index + 2] = clampByte(data[index + 2] + yb * 127.5);
    }
  });
  return raw;
}

/** Shadows lift and highlights recovery, weighted by the same tonal ramps. */
function applyShadowsHighlights(raw, spec) {
  const channels = raw.channels || CHANNELS;
  const shadows = number(spec.shadows, 0, -100, 100) / 100;
  const highlights = number(spec.highlights, 0, -100, 100) / 100;
  if (!shadows && !highlights) return raw;
  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      const l = lumaAt(data, index) / 255;
      const shadowWeight = (1 - l) * (1 - l) * Math.abs(shadows);
      const highlightWeight = l * l * Math.abs(highlights);
      for (let channel = 0; channel < 3; channel += 1) {
        const value = data[index + channel];
        let next = value;
        if (shadows) {
          next += shadows > 0 ? shadowWeight * (255 - value) : shadowWeight * value;
        }
        if (highlights) {
          next += highlights > 0 ? highlightWeight * (255 - value) : highlightWeight * value;
        }
        data[index + channel] = clampByte(next);
      }
    }
  });
  return raw;
}

/** Tint shadows and highlights independently, in HSL. */
function applySplitTone(raw, spec) {
  const channels = raw.channels || CHANNELS;
  const shadowHue = number(spec.shadowHue, 220, 0, 360);
  const shadowSaturation = number(spec.shadowSaturation, 0, 0, 100) / 100;
  const highlightHue = number(spec.highlightHue, 40, 0, 360);
  const highlightSaturation = number(spec.highlightSaturation, 0, 0, 100) / 100;
  const balance = number(spec.balance, 50, 0, 100) / 100;
  if (!shadowSaturation && !highlightSaturation) return raw;

  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      const l = lumaAt(data, index) / 255;
      const shadowWeight = Math.max(0, 1 - l / Math.max(0.001, balance)) * shadowSaturation;
      const highlightWeight = Math.max(0, (l - balance) / Math.max(0.001, 1 - balance)) * highlightSaturation;
      if (!shadowWeight && !highlightWeight) continue;
      const hsl = tone.rgbToHsl(data[index], data[index + 1], data[index + 2]);
      let h = hsl.h;
      let s = hsl.s;
      if (shadowWeight) {
        h = shadowHue;
        s = tone.clamp01(s + (1 - s) * shadowWeight * 0.5);
      }
      if (highlightWeight) {
        h = highlightHue;
        s = tone.clamp01(s + (1 - s) * highlightWeight * 0.5);
      }
      const rgb = tone.hslToRgb(h, s, hsl.l);
      data[index] = clampByte(rgb.r);
      data[index + 1] = clampByte(rgb.g);
      data[index + 2] = clampByte(rgb.b);
    }
  });
  return raw;
}

/** A photo filter: a coloured gel over the lens, at a given density. */
function applyPhotoFilter(raw, spec) {
  const channels = raw.channels || CHANNELS;
  const color = spec.color;
  const density = number(spec.density, 0, 0, 100) / 100;
  if (!density) return raw;
  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      data[index] = clampByte(data[index] + (color.r - data[index]) * density);
      data[index + 1] = clampByte(data[index + 1] + (color.g - data[index + 1]) * density);
      data[index + 2] = clampByte(data[index + 2] + (color.b - data[index + 2]) * density);
    }
  });
  return raw;
}

function applyBlackAndWhite(raw, weights) {
  const channels = raw.channels || CHANNELS;
  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      const value = clampByte(
        data[index] * weights.red + data[index + 1] * weights.green + data[index + 2] * weights.blue
      );
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
  });
  return raw;
}

function applyGrayscale(raw) {
  return applyBlackAndWhite(raw, { red: 0.2126, green: 0.7152, blue: 0.0722 });
}

function applyThreshold(raw, level) {
  const channels = raw.channels || CHANNELS;
  const cut = number(level, 128, 0, 255);
  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      const value = lumaAt(data, index) >= cut ? 255 : 0;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
  });
  return raw;
}

function applyGradientMap(raw, lut) {
  const channels = raw.channels || CHANNELS;
  forEachBand(raw, (data, start, end) => {
    for (let index = start; index < end; index += channels) {
      const entry = lut[clampByte(lumaAt(data, index))];
      data[index] = entry[0];
      data[index + 1] = entry[1];
      data[index + 2] = entry[2];
    }
  });
  return raw;
}

/**
 * A separable box blur with a sliding window: O(pixels) regardless of radius.
 * The engine builds Gaussian blur out of three passes, which is the standard
 * approximation and is why gaussianBlur's radius is documented as approximate.
 */
function boxBlur(raw, radius) {
  const r = Math.max(0, Math.min(250, Math.round(radius)));
  if (!r) return raw;
  const data = raw.data;
  const width = raw.width;
  const height = raw.height;
  const channels = raw.channels || CHANNELS;
  const count = 2 * r + 1;
  const horizontal = Buffer.alloc(data.length);

  for (let y = 0; y < height; y += 1) {
    const row = y * width * channels;
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0;
      for (let offset = -r; offset <= r; offset += 1) {
        const x = Math.min(width - 1, Math.max(0, offset));
        sum += data[row + x * channels + channel];
      }
      for (let x = 0; x < width; x += 1) {
        horizontal[row + x * channels + channel] = clampByte(sum / count);
        const leaving = Math.min(width - 1, Math.max(0, x - r));
        const entering = Math.min(width - 1, Math.max(0, x + r + 1));
        sum += data[row + entering * channels + channel] - data[row + leaving * channels + channel];
      }
    }
  }

  const output = Buffer.alloc(data.length);
  for (let x = 0; x < width; x += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0;
      for (let offset = -r; offset <= r; offset += 1) {
        const y = Math.min(height - 1, Math.max(0, offset));
        sum += horizontal[y * width * channels + x * channels + channel];
      }
      for (let y = 0; y < height; y += 1) {
        output[y * width * channels + x * channels + channel] = clampByte(sum / count);
        const leaving = Math.min(height - 1, Math.max(0, y - r));
        const entering = Math.min(height - 1, Math.max(0, y + r + 1));
        sum +=
          horizontal[entering * width * channels + x * channels + channel] -
          horizontal[leaving * width * channels + x * channels + channel];
      }
    }
  }

  for (let index = 3; index < output.length; index += channels) output[index] = data[index];
  raw.data = output;
  return raw;
}

/** Three box passes ≈ a Gaussian; the approximation is documented, not hidden. */
function gaussianBlur(raw, radius) {
  const r = Math.max(0, Math.min(250, Number(radius) || 0));
  if (!r) return raw;
  const pass = Math.max(1, Math.round(r * 0.6));
  boxBlur(raw, pass);
  boxBlur(raw, pass);
  return boxBlur(raw, pass);
}

function medianBlur(raw, radius) {
  const r = Math.max(0, Math.min(5, Math.round(Number(radius) || 0)));
  if (!r) return raw;
  const { data, width, height } = raw;
  const channels = raw.channels || CHANNELS;
  const source = Buffer.from(data);
  const window = (2 * r + 1) * (2 * r + 1);
  const values = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        values.length = 0;
        for (let dy = -r; dy <= r; dy += 1) {
          const sy = Math.min(height - 1, Math.max(0, y + dy));
          for (let dx = -r; dx <= r; dx += 1) {
            const sx = Math.min(width - 1, Math.max(0, x + dx));
            values.push(source[(sy * width + sx) * channels + channel]);
          }
        }
        values.sort((a, b) => a - b);
        data[(y * width + x) * channels + channel] = values[window >> 1];
      }
    }
  }
  return raw;
}

/** Directional smear: average N taps along one line. */
function motionBlur(raw, spec) {
  const { data, width, height } = raw;
  const channels = raw.channels || CHANNELS;
  const angle = (number(spec.angle, 0, 0, 360) * Math.PI) / 180;
  const distance = number(spec.distance, 10, 1, 200);
  const taps = Math.max(2, Math.min(64, Math.round(Number(spec.taps) || 16)));
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const source = Buffer.from(data);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sums = [0, 0, 0];
      for (let tap = 0; tap < taps; tap += 1) {
        const offset = (tap / (taps - 1) - 0.5) * distance;
        const sx = Math.min(width - 1, Math.max(0, Math.round(x + dx * offset)));
        const sy = Math.min(height - 1, Math.max(0, Math.round(y + dy * offset)));
        const index = (sy * width + sx) * channels;
        sums[0] += source[index];
        sums[1] += source[index + 1];
        sums[2] += source[index + 2];
      }
      const index = (y * width + x) * channels;
      data[index] = clampByte(sums[0] / taps);
      data[index + 1] = clampByte(sums[1] / taps);
      data[index + 2] = clampByte(sums[2] / taps);
    }
  }
  return raw;
}

/**
 * Unsharp mask: the classic amount × (original − blurred), with a threshold so
 * flat areas are not sharpened into noise.
 */
function unsharpMask(raw, spec, blurredRaw) {
  const amount = number(spec.amount, 100, 0, 500) / 100;
  const radius = number(spec.radius, 1, 0.1, 100);
  const threshold = number(spec.threshold, 0, 0, 255);
  if (!amount) return raw;
  const blurred = blurredRaw || gaussianBlur({ ...raw, data: Buffer.from(raw.data) }, radius);
  const channels = raw.channels || CHANNELS;
  for (let index = 0; index < raw.data.length; index += channels) {
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = raw.data[index + channel] - blurred.data[index + channel];
      if (Math.abs(difference) <= threshold) continue;
      raw.data[index + channel] = clampByte(raw.data[index + channel] + difference * amount);
    }
  }
  return raw;
}

/** Local contrast: unsharp masking with a wide radius around mid-grey. */
function clarity(raw, spec, blurredRaw) {
  const amount = number(spec.amount, 0, -100, 100);
  if (!amount) return raw;
  const radius = number(spec.radius, 30, 1, 100);
  const blurred = blurredRaw || gaussianBlur({ ...raw, data: Buffer.from(raw.data) }, radius);
  const channels = raw.channels || CHANNELS;
  const strength = amount / 100;
  for (let index = 0; index < raw.data.length; index += channels) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = raw.data[index + channel];
      const detail = value - blurred.data[index + channel];
      const weight = 1 - Math.abs(value / 255 - 0.5) * 2;
      raw.data[index + channel] = clampByte(value + detail * strength * weight * 2);
    }
  }
  return raw;
}

/**
 * Dehaze, honestly approximated: lift the black point by the darkest percentile
 * and add contrast. It is a stretch, not a physical model, and the skill says so.
 */
function dehaze(raw, spec) {
  const amount = number(spec.amount, 0, 0, 100) / 100;
  if (!amount) return raw;
  const stats = histogram(raw);
  let total = 0;
  for (let index = 0; index < 256; index += 1) total += stats.luma[index];
  let running = 0;
  let floor = 0;
  for (let index = 0; index < 256; index += 1) {
    running += stats.luma[index];
    if (running >= total * 0.01) {
      floor = index;
      break;
    }
  }
  const black = floor * amount;
  const lut = tone.mapLut((v) => {
    const byte = v * 255;
    const lifted = clampByte((byte - black) / Math.max(1, 255 - black) * 255);
    return (lifted / 255 - 0.5) * (1 + 0.25 * amount) + 0.5;
  });
  return applyLuts(raw, [lut, lut, lut]);
}

/** Vignette: a smooth radial falloff, computed from geometry, not a blurred copy. */
function vignette(raw, spec) {
  const amount = number(spec.amount, 0, -100, 100) / 100;
  if (!amount) return raw;
  const { data, width, height } = raw;
  const channels = raw.channels || CHANNELS;
  const midpoint = number(spec.midpoint, 50, 0, 100) / 100;
  const feather = Math.max(0.001, number(spec.feather, 50, 1, 100) / 100);
  const roundness = number(spec.roundness, 0, -100, 100) / 100;
  const exponent = 2 + roundness * 1.5;
  const normaliser = Math.pow(2, 1 / exponent);
  for (let y = 0; y < height; y += 1) {
    const ny = ((y + 0.5) / height) * 2 - 1;
    for (let x = 0; x < width; x += 1) {
      const nx = ((x + 0.5) / width) * 2 - 1;
      const distance =
        Math.pow(Math.pow(Math.abs(nx), exponent) + Math.pow(Math.abs(ny), exponent), 1 / exponent) /
        normaliser;
      const start = midpoint * 0.6;
      const t = Math.max(0, Math.min(1, (distance - start) / feather));
      const smooth = t * t * (3 - 2 * t);
      const factor = 1 - amount * smooth;
      const index = (y * width + x) * channels;
      data[index] = clampByte(data[index] * factor);
      data[index + 1] = clampByte(data[index + 1] * factor);
      data[index + 2] = clampByte(data[index + 2] * factor);
    }
  }
  return raw;
}

/** Deterministic grain: same seed, same picture, which is what makes it testable. */
function grain(raw, spec) {
  const amount = number(spec.amount, 0, 0, 100);
  if (!amount) return raw;
  const size = Math.max(1, Math.min(10, Math.round(Number(spec.size) || 1)));
  const monochrome = spec.monochrome !== false;
  const channels = raw.channels || CHANNELS;
  const { data, width, height } = raw;
  let state = (Math.round(Number(spec.seed) || 1) >>> 0) || 1;
  const random = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
  const scale = amount * 1.28;
  // `size` is the grain size in pixels: one noise value per block, so the noise
  // is coherent at 1 and clumpy at 10 instead of being point noise with an
  // unused parameter. Built up front so the pixel loop stays deterministic.
  const blocksX = Math.ceil(width / size);
  const blocksY = Math.ceil(height / size);
  const blockNoise = new Float64Array(blocksX * blocksY);
  for (let block = 0; block < blockNoise.length; block += 1) {
    blockNoise[block] = (random() - 0.5) * 2 * scale;
  }
  for (let y = 0; y < height; y += 1) {
    const blockRow = Math.floor(y / size) * blocksX;
    for (let x = 0; x < width; x += 1) {
      const noise = blockNoise[blockRow + Math.floor(x / size)];
      const index = (y * width + x) * channels;
      data[index] = clampByte(data[index] + noise);
      if (monochrome) {
        data[index + 1] = clampByte(data[index + 1] + noise);
        data[index + 2] = clampByte(data[index + 2] + noise);
      } else {
        data[index + 1] = clampByte(data[index + 1] + (random() - 0.5) * 2 * scale);
        data[index + 2] = clampByte(data[index + 2] + (random() - 0.5) * 2 * scale);
      }
    }
  }
  return raw;
}

/**
 * The histogram an agent checks its work against: 256 bins per channel plus
 * luminance, with means and clipping counts. Computed from the flattened
 * document, so it reflects what export will write.
 */
/**
 * Edge-preserving denoise.
 *
 * A bilateral pass: the spatial kernel is a small disc, and a second weight on
 * luminance difference stops the average from crossing an edge. That is what
 * makes it useful on high-ISO photos — flat sky and skin smooth, text and
 * silhouettes stay sharp — without the plasticky look of a plain blur. `amount`
 * mixes the filtered result back in, so 30 is a cleanup and 100 is a repaint.
 *
 * Alpha is untouched: smoothing coverage would feather every soft edge, which is
 * a mask operation, not a denoise.
 */
function denoise(raw, spec) {
  const settings = spec || {};
  const amount = number(settings.amount, 50, 0, 100) / 100;
  if (!amount) return raw;
  const radius = Math.round(number(settings.radius, 2, 1, 4));
  const preserve = number(settings.preserveEdges, 60, 0, 100) / 100;
  const channels = raw.channels || CHANNELS;
  const width = raw.width;
  const height = raw.height;
  if (width < 3 || height < 3) return raw;
  const source = Buffer.from(raw.data);
  const sigmaSpace = Math.max(1, radius) * 0.9;
  const sigmaRange = 6 + (1 - preserve) * 70;
  const rangeFactor = 1 / (2 * sigmaRange * sigmaRange);

  const offsets = [];
  const spatial = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const distance = dx * dx + dy * dy;
      if (distance > radius * radius + radius) continue;
      offsets.push([dx, dy]);
      spatial.push(Math.exp(-distance / (2 * sigmaSpace * sigmaSpace)));
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = (y * width + x) * channels;
      const centreLuma =
        0.2126 * source[base] + 0.7152 * source[base + 1] + 0.0722 * source[base + 2];
      let red = 0;
      let green = 0;
      let blue = 0;
      let weightTotal = 0;
      for (let step = 0; step < offsets.length; step += 1) {
        const nx = x + offsets[step][0];
        const ny = y + offsets[step][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbour = (ny * width + nx) * channels;
        const luma =
          0.2126 * source[neighbour] +
          0.7152 * source[neighbour + 1] +
          0.0722 * source[neighbour + 2];
        const difference = luma - centreLuma;
        const weight = spatial[step] * Math.exp(-(difference * difference) * rangeFactor);
        weightTotal += weight;
        red += source[neighbour] * weight;
        green += source[neighbour + 1] * weight;
        blue += source[neighbour + 2] * weight;
      }
      if (!weightTotal) continue;
      const mix = amount;
      raw.data[base] = clampByte(source[base] + (red / weightTotal - source[base]) * mix);
      raw.data[base + 1] = clampByte(
        source[base + 1] + (green / weightTotal - source[base + 1]) * mix
      );
      raw.data[base + 2] = clampByte(
        source[base + 2] + (blue / weightTotal - source[base + 2]) * mix
      );
    }
  }
  return raw;
}

function histogram(raw) {
  const channels = raw.channels || CHANNELS;
  const { data, width, height } = raw;
  const red = new Array(256).fill(0);
  const green = new Array(256).fill(0);
  const blue = new Array(256).fill(0);
  const luma = new Array(256).fill(0);
  let sumRed = 0;
  let sumGreen = 0;
  let sumBlue = 0;
  let sumLuma = 0;
  let shadowClipping = 0;
  let highlightClipping = 0;
  const pixels = width * height;

  for (let index = 0; index < data.length; index += channels) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    red[r] += 1;
    green[g] += 1;
    blue[b] += 1;
    const value = tone.luma(r, g, b);
    luma[tone.clampByte(value)] += 1;
    sumRed += r;
    sumGreen += g;
    sumBlue += b;
    sumLuma += value;
    if (r === 0 || g === 0 || b === 0) shadowClipping += 1;
    if (r === 255 || g === 255 || b === 255) highlightClipping += 1;
  }

  return {
    bins: 256,
    pixels: pixels,
    red: red,
    green: green,
    blue: blue,
    luma: luma,
    mean: {
      red: pixels ? sumRed / pixels : 0,
      green: pixels ? sumGreen / pixels : 0,
      blue: pixels ? sumBlue / pixels : 0,
      luma: pixels ? sumLuma / pixels : 0,
    },
    clipping: {
      shadows: pixels ? shadowClipping / pixels : 0,
      highlights: pixels ? highlightClipping / pixels : 0,
    },
  };
}

/**
 * Multiply a layer's alpha by a coverage mask, which is what a layer mask is:
 * the pixels stay, the places the mask hides stop contributing. The mask is
 * canvas-sized and already includes feathering.
 */
function applyAlphaMask(raw, mask) {
  if (!mask) return raw;
  const channels = raw.channels || CHANNELS;
  const width = raw.width;
  const height = raw.height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const coverage = mask[y * width + x];
      if (coverage === 255) continue;
      const index = (y * width + x) * channels;
      raw.data[index + 3] = clampByte((raw.data[index + 3] * coverage) / 255);
    }
  }
  return raw;
}

/**
 * GIMP-style bucket fill: flood from a seed over pixels within `tolerance` of
 * the seed colour, or over every similar pixel when `contiguous` is false.
 *
 * The fill is composited source-over at `opacity`, clipped by the optional
 * coverage mask. That is deliberately different from replacing the seed region
 * outright: a semi-transparent fill must behave like paint over a photo, and a
 * selection edge must still feather through the mask.
 */
function floodFill(raw, options) {
  const settings = options || {};
  const width = raw.width;
  const height = raw.height;
  const channels = raw.channels || CHANNELS;
  const x = Math.round(Number(settings.x));
  const y = Math.round(Number(settings.y));
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error('A fill seed must be inside the layer. Nothing was filled.');
  }
  const fill = Array.isArray(settings.color) ? settings.color : [0, 0, 0, 255];
  const fillColor = [
    clampByte(fill[0]),
    clampByte(fill[1]),
    clampByte(fill[2]),
    clampByte(fill[3] === undefined ? 255 : fill[3]),
  ];
  const tolerance = number(settings.tolerance, 32, 0, 255);
  const opacity = number(settings.opacity, 1, 0, 1);
  const mask = settings.mask || null;
  const contiguous = settings.contiguous !== false;
  const seedPixel = y * width + x;
  const seed = [
    raw.data[seedPixel * channels],
    raw.data[seedPixel * channels + 1],
    raw.data[seedPixel * channels + 2],
    raw.data[seedPixel * channels + 3],
  ];
  const matches = (pixel) => {
    const index = pixel * channels;
    return (
      Math.abs(raw.data[index] - seed[0]) <= tolerance &&
      Math.abs(raw.data[index + 1] - seed[1]) <= tolerance &&
      Math.abs(raw.data[index + 2] - seed[2]) <= tolerance &&
      Math.abs(raw.data[index + 3] - seed[3]) <= tolerance
    );
  };
  const paint = (pixel) => {
    let coverage = opacity;
    if (mask) coverage *= mask[pixel] / 255;
    if (coverage <= 0 || fillColor[3] <= 0) return;
    const index = pixel * channels;
    const sourceAlpha = (fillColor[3] / 255) * coverage;
    const baseAlpha = raw.data[index + 3] / 255;
    const outAlpha = sourceAlpha + baseAlpha * (1 - sourceAlpha);
    if (outAlpha <= 0) return;
    for (let channel = 0; channel < 3; channel += 1) {
      const mixed =
        fillColor[channel] / 255 * sourceAlpha +
        raw.data[index + channel] / 255 * baseAlpha * (1 - sourceAlpha);
      raw.data[index + channel] = clampByte((mixed / outAlpha) * 255);
    }
    raw.data[index + 3] = clampByte(outAlpha * 255);
  };

  if (!contiguous) {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      if (matches(pixel)) paint(pixel);
    }
    return raw;
  }

  const visited = new Uint8Array(width * height);
  const stack = [seedPixel];
  while (stack.length) {
    const pixel = stack.pop();
    if (visited[pixel] || !matches(pixel)) continue;
    const row = Math.floor(pixel / width) * width;
    let left = pixel;
    let right = pixel;
    while (left > row && !visited[left - 1] && matches(left - 1)) left -= 1;
    while (right < row + width - 1 && !visited[right + 1] && matches(right + 1)) right += 1;
    for (let current = left; current <= right; current += 1) {
      if (visited[current]) continue;
      visited[current] = 1;
      paint(current);
      const above = current - width;
      if (above >= 0 && !visited[above] && matches(above)) stack.push(above);
      const below = current + width;
      if (below < width * height && !visited[below] && matches(below)) stack.push(below);
    }
  }
  return raw;
}

/**
 * Composite `over` onto `base` with a blend mode, straight alpha and an optional
 * offset and coverage mask. `base` and `over` are canvas-sized; the offset moves
 * the over layer, and anything outside it is simply not composited.
 *
 * The formula is the W3C compositing one:
 *   Co = as(1−ab)Cs + as·ab·B(Cb,Cs) + (1−as)ab·Cb,  ao = as + ab(1−as)
 * which is what makes a multiply over transparency behave like Photoshop's.
 */
/**
 * Clone stamp: copy pixels from a source offset along a brush stroke.
 *
 * The source is read from a snapshot taken before the stroke, so a stamp never
 * samples the paint it just laid down. Coverage is a soft round falloff along
 * the stroke polyline, and alpha is blended with the colour: cloning a
 * transparent area into a photograph should reveal transparency, not tint it.
 */
function cloneStamp(raw, options) {
  const settings = options || {};
  const points = (Array.isArray(settings.points) ? settings.points : [])
    .map((point) => (Array.isArray(point) ? { x: Number(point[0]), y: Number(point[1]) } : point))
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length) throw new Error('A clone command needs at least one point. Nothing was drawn.');
  const offset = {
    x: Math.round(Number(settings.offset && settings.offset.x) || 0),
    y: Math.round(Number(settings.offset && settings.offset.y) || 0),
  };
  if (!offset.x && !offset.y) {
    throw new Error('A clone command needs a source `from` away from the first point. Nothing was drawn.');
  }
  const radius = Math.max(0.5, (Number(settings.width) || 48) / 2);
  const softness = Math.max(0, Math.min(1, settings.softness === undefined ? 0.65 : Number(settings.softness)));
  const opacity = Math.max(0, Math.min(1, settings.opacity === undefined ? 1 : Number(settings.opacity)));
  const channels = raw.channels || CHANNELS;
  const mask = settings.mask || null;
  const source = Buffer.from(raw.data);
  const inner = radius * (1 - softness);

  const distanceToSegment = (px, py, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return Math.hypot(px - a.x, py - a.y);
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  };

  const left = Math.max(0, Math.floor(Math.min.apply(null, points.map((point) => point.x)) - radius - 1));
  const top = Math.max(0, Math.floor(Math.min.apply(null, points.map((point) => point.y)) - radius - 1));
  const right = Math.min(raw.width, Math.ceil(Math.max.apply(null, points.map((point) => point.x)) + radius + 1));
  const bottom = Math.min(raw.height, Math.ceil(Math.max.apply(null, points.map((point) => point.y)) + radius + 1));

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      let distance = Infinity;
      if (points.length === 1) distance = Math.hypot(x - points[0].x, y - points[0].y);
      else {
        for (let index = 0; index + 1 < points.length; index += 1) {
          distance = Math.min(distance, distanceToSegment(x, y, points[index], points[index + 1]));
        }
      }
      if (distance > radius) continue;
      const falloff =
        distance <= inner ? 1 : 1 - smoothstep(inner, radius, distance);
      if (falloff <= 0) continue;
      const index = y * raw.width + x;
      let coverage = falloff * opacity;
      if (mask) coverage *= (mask[index] || 0) / 255;
      if (coverage <= 0) continue;
      const sourceX = x + offset.x;
      const sourceY = y + offset.y;
      if (sourceX < 0 || sourceY < 0 || sourceX >= raw.width || sourceY >= raw.height) continue;
      const from = (sourceY * raw.width + sourceX) * channels;
      const to = index * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        raw.data[to + channel] = Math.round(
          raw.data[to + channel] * (1 - coverage) + source[from + channel] * coverage
        );
      }
    }
  }
  return raw;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

function blend(base, over, options) {
  const settings = options || {};
  const mode = settings.mode || 'normal';
  const opacity = settings.opacity === undefined ? 1 : tone.clamp01(settings.opacity);
  const offsetX = Math.round(settings.offset ? settings.offset.x || 0 : 0);
  const offsetY = Math.round(settings.offset ? settings.offset.y || 0 : 0);
  const mask = settings.mask || null;
  const width = base.width;
  const height = base.height;
  const channels = base.channels || CHANNELS;
  const overChannels = over.channels || CHANNELS;
  // Callers give us either a canvas-sized mask (document compositing) or a
  // mask projected into the over-layer's own pixels (drawToBuffer). Pick the
  // coordinate space from the mask length instead of assuming one, otherwise a
  // text layer or an offset raster reads the wrong mask row.
  const maskInBaseSpace = Boolean(mask && mask.length === width * height);
  const maskInOverSpace = Boolean(mask && mask.length === over.width * over.height);
  const output = Buffer.from(base.data);
  const baseColor = [0, 0, 0];
  const overColor = [0, 0, 0];

  for (let y = 0; y < height; y += 1) {
    const sourceY = y - offsetY;
    if (sourceY < 0 || sourceY >= over.height) continue;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - offsetX;
      if (sourceX < 0 || sourceX >= over.width) continue;
      const overIndex = (sourceY * over.width + sourceX) * overChannels;
      let sourceAlpha = (over.data[overIndex + 3] / 255) * opacity;
      if (mask) {
        const maskIndex = maskInBaseSpace
          ? y * width + x
          : maskInOverSpace
            ? sourceY * over.width + sourceX
            : -1;
        if (maskIndex < 0) continue;
        sourceAlpha *= mask[maskIndex] / 255;
      }
      if (sourceAlpha <= 0) continue;

      const baseIndex = (y * width + x) * channels;
      const baseAlpha = output[baseIndex + 3] / 255;
      baseColor[0] = output[baseIndex] / 255;
      baseColor[1] = output[baseIndex + 1] / 255;
      baseColor[2] = output[baseIndex + 2] / 255;
      overColor[0] = over.data[overIndex] / 255;
      overColor[1] = over.data[overIndex + 1] / 255;
      overColor[2] = over.data[overIndex + 2] / 255;
      const blended = blendModule.blendColor(mode, baseColor, overColor);
      const outAlpha = sourceAlpha + baseAlpha * (1 - sourceAlpha);

      for (let channel = 0; channel < 3; channel += 1) {
        const premultiplied =
          sourceAlpha * (1 - baseAlpha) * overColor[channel] +
          sourceAlpha * baseAlpha * blended[channel] +
          (1 - sourceAlpha) * baseAlpha * baseColor[channel];
        output[baseIndex + channel] = clampByte(outAlpha ? (premultiplied / outAlpha) * 255 : 0);
      }
      output[baseIndex + 3] = clampByte(outAlpha * 255);
    }
  }

  return { data: output, width: width, height: height, channels: channels };
}

function sampleNearest(raw, x, y, channels) {
  const px = Math.min(raw.width - 1, Math.max(0, Math.round(x)));
  const py = Math.min(raw.height - 1, Math.max(0, Math.round(y)));
  const index = (py * raw.width + px) * channels;
  return [raw.data[index], raw.data[index + 1], raw.data[index + 2], raw.data[index + 3]];
}

/** Bilinear sample with straight alpha; outside the source is transparent. */
function sampleBilinear(raw, x, y, channels) {
  if (x < -1 || y < -1 || x > raw.width || y > raw.height) return [0, 0, 0, 0];
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const result = [0, 0, 0, 0];
  for (let dy = 0; dy <= 1; dy += 1) {
    for (let dx = 0; dx <= 1; dx += 1) {
      const px = x0 + dx;
      const py = y0 + dy;
      if (px < 0 || py < 0 || px >= raw.width || py >= raw.height) continue;
      const weight = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
      const index = (py * raw.width + px) * channels;
      result[0] += raw.data[index] * weight;
      result[1] += raw.data[index + 1] * weight;
      result[2] += raw.data[index + 2] * weight;
      result[3] += raw.data[index + 3] * weight;
    }
  }
  return result;
}

/**
 * Inverse-map every output pixel through a 3×3 transform. This is how perspective
 * and skew are applied: solve the matrix forward, sample backwards.
 */
function warp(raw, options) {
  const settings = options || {};
  if (!Array.isArray(settings.matrix) || settings.matrix.length !== 9) {
    throw new Error('warp needs a 3×3 matrix.');
  }
  const inverse = transformModule.invert(settings.matrix);
  const width = Math.max(1, Math.round(Number(settings.width) || raw.width));
  const height = Math.max(1, Math.round(Number(settings.height) || raw.height));
  const channels = CHANNELS;
  const output = Buffer.alloc(width * height * channels);
  const sampler = settings.sampler === 'nearest' ? sampleNearest : sampleBilinear;
  const background = settings.background || [0, 0, 0, 0];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = transformModule.apply(inverse, x + 0.5, y + 0.5);
      const index = (y * width + x) * channels;
      const sampled = sampler(raw, source.x, source.y, raw.channels || channels);
      const alpha = sampled[3] / 255;
      if (alpha <= 0) {
        output[index] = background[0];
        output[index + 1] = background[1];
        output[index + 2] = background[2];
        output[index + 3] = background[3] === undefined ? 255 : background[3];
        continue;
      }
      // Straight-alpha composite of the sample over the background.
      const bg = background;
      const bgAlpha = bg[3] === undefined ? 0 : bg[3] / 255;
      const outAlpha = alpha + bgAlpha * (1 - alpha);
      for (let channel = 0; channel < 3; channel += 1) {
        const value =
          sampled[channel] * alpha + (bg[channel] === undefined ? 0 : bg[channel]) * bgAlpha * (1 - alpha);
        output[index + channel] = clampByte(outAlpha ? value / outAlpha : 0);
      }
      output[index + 3] = clampByte(outAlpha * 255);
    }
  }
  return { data: output, width: width, height: height, channels: channels };
}

/** Crop a raw buffer to a rectangle, clamped to it. */
function crop(raw, rect) {
  const channels = raw.channels || CHANNELS;
  const x = Math.max(0, Math.min(raw.width - 1, Math.round(rect.x || 0)));
  const y = Math.max(0, Math.min(raw.height - 1, Math.round(rect.y || 0)));
  const width = Math.max(1, Math.min(raw.width - x, Math.round(rect.width || raw.width)));
  const height = Math.max(1, Math.min(raw.height - y, Math.round(rect.height || raw.height)));
  const data = Buffer.alloc(width * height * channels);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * raw.width + x) * channels;
    data.set(raw.data.subarray(from, from + width * channels), row * width * channels);
  }
  return { data: data, width: width, height: height, channels: channels };
}

/** Place a raw buffer on a larger canvas at an offset, transparent elsewhere. */
function extend(raw, options) {
  const channels = raw.channels || CHANNELS;
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));
  const offsetX = Math.round(options.offsetX || 0);
  const offsetY = Math.round(options.offsetY || 0);
  const background = options.background || [0, 0, 0, 0];
  const data = Buffer.alloc(width * height * channels);
  for (let index = 0; index < width * height; index += 1) {
    data[index * channels] = background[0] || 0;
    data[index * channels + 1] = background[1] || 0;
    data[index * channels + 2] = background[2] || 0;
    data[index * channels + 3] = background[3] === undefined ? 0 : background[3];
  }
  // A negative offset means the source starts above or left of the new canvas,
  // so copy per pixel: a row-slice copy would index out of bounds there.
  for (let y = 0; y < height; y += 1) {
    const sourceY = y - offsetY;
    if (sourceY < 0 || sourceY >= raw.height) continue;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - offsetX;
      if (sourceX < 0 || sourceX >= raw.width) continue;
      const from = (sourceY * raw.width + sourceX) * channels;
      const to = (y * width + x) * channels;
      data[to] = raw.data[from];
      data[to + 1] = raw.data[from + 1];
      data[to + 2] = raw.data[from + 2];
      data[to + 3] = channels === 4 ? raw.data[from + 3] : 255;
    }
  }
  return { data: data, width: width, height: height, channels: channels };
}

/**
 * Trim a uniform or transparent border. Returns the box to keep, always at least
 * one pixel, so callers can crop blindly rather than special-case a blank image.
 */
function trimBox(raw, options) {
  const settings = options || {};
  const tolerance = settings.tolerance === undefined ? 0 : Math.max(0, Number(settings.tolerance) || 0);
  const trimTransparent = settings.trimTransparent !== false;
  const { data, width, height } = raw;
  const channels = raw.channels || CHANNELS;

  const matches = (x, y, reference) => {
    const index = (y * width + x) * channels;
    if (trimTransparent && data[index + 3] === 0) return true;
    return (
      Math.abs(data[index] - reference[0]) <= tolerance &&
      Math.abs(data[index + 1] - reference[1]) <= tolerance &&
      Math.abs(data[index + 2] - reference[2]) <= tolerance &&
      Math.abs(data[index + 3] - reference[3]) <= tolerance
    );
  };
  const reference = [data[0], data[1], data[2], data[3]];
  const rowMatches = (y) => {
    for (let x = 0; x < width; x += 1) if (!matches(x, y, reference)) return false;
    return true;
  };
  const columnMatches = (x, fromY, toY) => {
    for (let y = fromY; y <= toY; y += 1) if (!matches(x, y, reference)) return false;
    return true;
  };

  let top = 0;
  while (top < height && rowMatches(top)) top += 1;
  if (top === height) return { x: 0, y: 0, width: 1, height: 1 };
  let bottom = height - 1;
  while (bottom > top && rowMatches(bottom)) bottom -= 1;
  let left = 0;
  while (left < width && columnMatches(left, top, bottom)) left += 1;
  let right = width - 1;
  while (right > left && columnMatches(right, top, bottom)) right -= 1;
  return { x: left, y: top, width: Math.max(1, right - left + 1), height: Math.max(1, bottom - top + 1) };
}

// ---------------------------------------------------------------------------
// Layer styles
// ---------------------------------------------------------------------------

function alphaMap(raw) {
  const width = raw.width;
  const height = raw.height;
  const channels = raw.channels || CHANNELS;
  const out = new Uint8Array(width * height);
  if (channels < 4) {
    out.fill(255);
    return out;
  }
  for (let index = 0; index < width * height; index += 1) out[index] = raw.data[index * channels + 3];
  return out;
}

/** Exact squared Euclidean distance transform of a 0/1 feature mask. */
function distanceTransform(seed, width, height) {
  const INF = 1e20;
  const grid = new Float64Array(width * height);
  for (let index = 0; index < grid.length; index += 1) grid[index] = seed[index] ? 0 : INF;
  const line = new Float64Array(Math.max(width, height));
  const output = new Float64Array(Math.max(width, height));

  const edt1d = (input, result, length) => {
    const v = new Int32Array(length);
    const z = new Float64Array(length + 1);
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < length; q += 1) {
      let s =
        (input[q] + q * q - (input[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k -= 1;
        s = (input[q] + q * q - (input[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < length; q += 1) {
      while (z[k + 1] < q) k += 1;
      const delta = q - v[k];
      result[q] = delta * delta + input[v[k]];
    }
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) line[x] = grid[y * width + x];
    edt1d(line, output, width);
    for (let x = 0; x < width; x += 1) grid[y * width + x] = output[x];
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) line[y] = grid[y * width + x];
    edt1d(line, output, height);
    for (let y = 0; y < height; y += 1) grid[y * width + x] = output[y];
  }
  const distance = new Float32Array(width * height);
  for (let index = 0; index < grid.length; index += 1) distance[index] = Math.sqrt(grid[index]);
  return distance;
}

/** Distance from every pixel to the nearest pixel where `seed` is 1. */
function distanceToSeed(mask, width, height) {
  const seeds = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) seeds[index] = mask[index] ? 1 : 0;
  return distanceTransform(seeds, width, height);
}

function boxBlurAlpha(mask, width, height, radius) {
  if (radius < 1) return mask;
  const horizontal = new Float32Array(width * height);
  const vertical = new Float32Array(width * height);
  const diameter = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) sum += mask[row + Math.max(0, Math.min(width - 1, x))];
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / diameter;
      const drop = x - radius;
      const add = x + radius + 1;
      sum -= mask[row + Math.max(0, Math.min(width - 1, drop))];
      sum += mask[row + Math.max(0, Math.min(width - 1, add))];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[Math.max(0, Math.min(height - 1, y)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      vertical[y * width + x] = sum / diameter;
      const drop = y - radius;
      const add = y + radius + 1;
      sum -= horizontal[Math.max(0, Math.min(height - 1, drop)) * width + x];
      sum += horizontal[Math.max(0, Math.min(height - 1, add)) * width + x];
    }
  }
  return vertical;
}

/** Normalised alpha blurred with three box passes, roughly a Gaussian. */
function blurredAlpha(alpha, width, height, radius) {
  let mask = new Float32Array(alpha.length);
  for (let index = 0; index < alpha.length; index += 1) mask[index] = alpha[index] / 255;
  const r = Math.max(1, Math.round(Number(radius) / 2));
  for (let pass = 0; pass < 3; pass += 1) mask = boxBlurAlpha(mask, width, height, r);
  return mask;
}

/** Grow the silhouette by `radius` pixels while keeping the original alpha. */
function spreadAlpha(alpha, width, height, radius) {
  const out = new Float32Array(alpha.length);
  const amount = Math.max(0, Number(radius) || 0);
  if (!amount) {
    for (let index = 0; index < alpha.length; index += 1) out[index] = alpha[index] / 255;
    return out;
  }
  const opaque = new Uint8Array(alpha.length);
  for (let index = 0; index < alpha.length; index += 1) opaque[index] = alpha[index] > 0 ? 1 : 0;
  const distance = distanceToSeed(opaque, width, height);
  for (let index = 0; index < alpha.length; index += 1) {
    const grown = Math.max(0, Math.min(1, amount - distance[index] + 0.5));
    out[index] = Math.max(alpha[index] / 255, grown);
  }
  return out;
}

function shiftedMask(mask, width, height, dx, dy) {
  const out = new Float32Array(mask.length);
  const shiftX = Math.round(dx);
  const shiftY = Math.round(dy);
  for (let y = 0; y < height; y += 1) {
    const sourceY = y - shiftY;
    if (sourceY < 0 || sourceY >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - shiftX;
      if (sourceX < 0 || sourceX >= width) continue;
      out[y * width + x] = mask[sourceY * width + sourceX];
    }
  }
  return out;
}

function coverageLayer(coverage, color, width, height) {
  const data = Buffer.alloc(width * height * CHANNELS);
  const rgba = stylesModule.parseColor(color) || [0, 0, 0, 255];
  for (let index = 0; index < coverage.length; index += 1) {
    const alpha = Math.max(0, Math.min(255, coverage[index] * rgba[3]));
    if (alpha <= 0) continue;
    const offset = index * CHANNELS;
    data[offset] = rgba[0];
    data[offset + 1] = rgba[1];
    data[offset + 2] = rgba[2];
    data[offset + 3] = Math.round(alpha);
  }
  return { data: data, width: width, height: height, channels: CHANNELS };
}

function styleCoverage(style, alpha, width, height) {
  const params = style.params;
  if (style.type === 'dropShadow') {
    const spread = spreadAlpha(alpha, width, height, (Number(params.size) * Number(params.spread)) / 150);
    const blurred = blurredAlpha(spread.map((value) => value * 255), width, height, params.size);
    const angle = (Number(params.angle) * Math.PI) / 180;
    const shifted = shiftedMask(
      blurred,
      width,
      height,
      Math.cos(angle) * Number(params.distance),
      Math.sin(angle) * Number(params.distance)
    );
    return shifted.map((value) => value * Number(params.opacity));
  }
  if (style.type === 'outerGlow') {
    const spread = spreadAlpha(alpha, width, height, (Number(params.size) * Number(params.spread)) / 150);
    let blurred = blurredAlpha(spread.map((value) => value * 255), width, height, params.size);
    const hardness = Math.max(0, Math.min(1, Number(params.hardness) / 100));
    if (hardness > 0) {
      const gamma = 1 / (1 + hardness * 1.5);
      blurred = blurred.map((value) => Math.pow(value, gamma));
    }
    return blurred.map((value) => value * Number(params.opacity));
  }
  if (style.type === 'stroke' || style.type === 'innerStroke') {
    const seeds = new Uint8Array(alpha.length);
    for (let index = 0; index < alpha.length; index += 1) {
      seeds[index] = style.type === 'stroke' ? (alpha[index] > 0 ? 1 : 0) : (alpha[index] === 0 ? 1 : 0);
    }
    if (style.type === 'innerStroke') {
      for (let x = 0; x < width; x += 1) {
        if (alpha[x] > 0) seeds[x] = 1;
        if (alpha[(height - 1) * width + x] > 0) seeds[(height - 1) * width + x] = 1;
      }
      for (let y = 0; y < height; y += 1) {
        if (alpha[y * width] > 0) seeds[y * width] = 1;
        if (alpha[y * width + width - 1] > 0) seeds[y * width + width - 1] = 1;
      }
    }
    const distance = distanceTransform(seeds, width, height);
    const widthPx = Number(params.size);
    const coverage = new Float32Array(alpha.length);
    for (let index = 0; index < alpha.length; index += 1) {
      const ring = Math.max(0, Math.min(1, widthPx - distance[index] + 0.5));
      const inside = style.type === 'innerStroke' ? alpha[index] / 255 : 1 - alpha[index] / 255;
      coverage[index] = ring * inside * Number(params.opacity);
    }
    return coverage;
  }
  return new Float32Array(alpha.length);
}

function bevelOverlay(raw, style) {
  const width = raw.width;
  const height = raw.height;
  const alpha = alphaMap(raw);
  const transparent = new Uint8Array(alpha.length);
  for (let index = 0; index < alpha.length; index += 1) transparent[index] = alpha[index] === 0 ? 1 : 0;
  const distance = distanceTransform(transparent, width, height);
  const size = Math.max(1, Number(style.params.size));
  const softness = Math.max(0, Math.min(1, Number(style.params.soften) / 100));
  const angle = (Number(style.params.angle) * Math.PI) / 180;
  const lightX = Math.cos(angle);
  const lightY = Math.sin(angle);
  const highlight = stylesModule.parseColor(style.params.highlight) || [255, 255, 255, 255];
  const shadow = stylesModule.parseColor(style.params.shadow) || [0, 0, 0, 255];
  const data = Buffer.alloc(width * height * CHANNELS);
  const heightAt = (x, y) => Math.max(0, Math.min(1, distance[y * width + x] / size));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (alpha[index] === 0) continue;
      const h = heightAt(x, y);
      const left = heightAt(Math.max(0, x - 1), y);
      const right = heightAt(Math.min(width - 1, x + 1), y);
      const up = heightAt(x, Math.max(0, y - 1));
      const down = heightAt(x, Math.min(height - 1, y + 1));
      const gx = right - left;
      const gy = down - up;
      const length = Math.hypot(gx, gy);
      if (length < 0.0001) continue;
      const shade = -((gx / length) * lightX + (gy / length) * lightY);
      if (Math.abs(shade) < 0.02) continue;
      const falloff = Math.pow(1 - h, 0.5 + softness);
      const amount = Math.abs(shade) * falloff * Number(style.params.opacity) * (alpha[index] / 255);
      if (amount <= 0) continue;
      const color = shade >= 0 ? highlight : shadow;
      const offset = index * CHANNELS;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = Math.round(Math.min(1, amount) * color[3]);
    }
  }
  return { data: data, width: width, height: height, channels: CHANNELS };
}

/** How far a set of styles can paint beyond the layer's own pixels. */
function styleMargin(styles) {
  let margin = 0;
  for (const style of styles || []) {
    if (style.enabled === false) continue;
    margin = Math.max(margin, stylesModule.outerMargin(style));
  }
  return Math.ceil(margin) + 2;
}

/** Transparent padding around a raw buffer, used to fit a layer's shadow. */
function padRaw(raw, margin) {
  const pad = Math.max(0, Math.round(margin));
  if (!pad) return raw;
  const channels = raw.channels || CHANNELS;
  const width = raw.width + pad * 2;
  const height = raw.height + pad * 2;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < raw.height; y += 1) {
    const from = y * raw.width * channels;
    const to = ((y + pad) * width + pad) * channels;
    raw.data.copy(data, to, from, from + raw.width * channels);
  }
  return { data: data, width: width, height: height, channels: channels, pad: pad };
}

/**
 * Render a layer's styles into pixels.
 *
 * Shadow, glow and stroke are painted behind the layer's own alpha; bevel is
 * painted on top of it. Styles are ephemeral: the returned buffer is flattened
 * into the document and never written back into the document model.
 */
function applyLayerStyles(raw, styles) {
  const enabled = (styles || []).filter((style) => style && style.enabled !== false);
  if (!enabled.length) return raw;
  const width = raw.width;
  const height = raw.height;
  const alpha = alphaMap(raw);
  let base = raw;
  let behind = {
    data: Buffer.alloc(width * height * CHANNELS),
    width: width,
    height: height,
    channels: CHANNELS,
  };
  for (const style of enabled) {
    if (style.type === 'bevel') {
      base = blend(base, bevelOverlay(base, style), { mode: 'normal' });
      continue;
    }
    const coverage = styleCoverage(style, alpha, width, height);
    if (!coverage.some((value) => value > 0)) continue;
    const color = style.params.color;
    behind = blend(behind, coverageLayer(coverage, color, width, height), {
      mode: style.params.blend || 'normal',
    });
  }
  return blend(behind, base, { mode: 'normal' });
}

module.exports = {
  BAND_ROWS: BAND_ROWS,
  applyLayerStyles: applyLayerStyles,
  padRaw: padRaw,
  styleMargin: styleMargin,
  applyBlackAndWhite: applyBlackAndWhite,
  applyColorBalance: applyColorBalance,
  applyGains: applyGains,
  applyGradientMap: applyGradientMap,
  applyGrayscale: applyGrayscale,
  applyHsl: applyHsl,
  applyAlphaMask: applyAlphaMask,
  applyLuts: applyLuts,
  applyMatrix: applyMatrix,
  applyOpacity: applyOpacity,
  applyOperationToChannel: applyOperationToChannel,
  applyPhotoFilter: applyPhotoFilter,
  applyShadowsHighlights: applyShadowsHighlights,
  applySplitTone: applySplitTone,
  applyThreshold: applyThreshold,
  blend: blend,
  floodFill: floodFill,
  crop: crop,
  denoise: denoise,
  extend: extend,
  boxBlur: boxBlur,
  clarity: clarity,
  cloneStamp: cloneStamp,
  dehaze: dehaze,
  forEachBand: forEachBand,
  gaussianBlur: gaussianBlur,
  grain: grain,
  histogram: histogram,
  medianBlur: medianBlur,
  motionBlur: motionBlur,
  trimBox: trimBox,
  unsharpMask: unsharpMask,
  vignette: vignette,
  warp: warp,
};
