/*
 * M0 backend spike: can libvips replace `sips` inside an extension process?
 *
 * Decision D1 exists because `sips` can rotate, flip, crop, resample and
 * convert, and cannot express a tone curve, a blend mode, a layer or a mask.
 * This script is the timeboxed proof, not the product: it runs the five
 * operations the spec names, decodes a PNG built by hand rather than by the
 * library under test, measures the work on a 12 MP and an 80 MP image, and
 * writes a report the test asserts and the decision record quotes.
 *
 * It runs the way the installed builtin runs: launched by absolute path with
 * PATH=/nonexistent (the extension profile hands its child bundled
 * interpreters, never /usr/bin) and MINOTAURIS_EXTENSION_DATA as the only
 * directory it writes to. Everything it needs comes from `vendor/`.
 *
 * stdout: one JSON line. stderr: progress, so a failure leaves a trail.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const dataDir = process.env.MINOTAURIS_EXTENSION_DATA;
if (!dataDir) {
  process.stderr.write('backend-spike needs MINOTAURIS_EXTENSION_DATA; it writes nowhere else.\n');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });

// By path, not by module lookup: the extension ships its runtime and the host
// deliberately gives it no PATH, so there is no resolver to lean on.
const sharp = require(path.join(__dirname, 'vendor', 'node_modules', 'sharp'));

// A five-point curve with a lifted midtone. Shared with the test, which builds
// the expected table independently.
const CURVE = [
  [0, 0],
  [64, 50],
  [128, 140],
  [192, 210],
  [255, 255],
];
// The raw pass runs in bands so an 80 MP layer never needs two full buffers.
const BAND_ROWS = 512;

const SIZES = {
  '12mp': { width: 4000, height: 3000 },
  '80mp': { width: 10000, height: 8000 },
};

function note(message) {
  process.stderr.write('[spike] ' + message + '\n');
}

function round(value, places) {
  const factor = 10 ** (places || 0);
  return Math.round(value * factor) / factor;
}

async function timed(bucket, key, run) {
  const started = process.hrtime.bigint();
  const value = await run();
  bucket[key] = round(Number(process.hrtime.bigint() - started) / 1e6, 1);
  return value;
}

/** Piecewise-linear interpolation of the control points into a 256-entry LUT. */
function lutFor(points) {
  const table = new Uint8Array(256);
  let segment = 0;
  for (let value = 0; value < 256; value += 1) {
    while (segment < points.length - 2 && value > points[segment + 1][0]) segment += 1;
    const start = points[segment];
    const end = points[segment + 1];
    const span = end[0] - start[0];
    const t = span === 0 ? 0 : (value - start[0]) / span;
    table[value] = Math.round(start[1] + (end[1] - start[1]) * t);
  }
  return table;
}

/** Applies a LUT to RGB in horizontal bands; returns pixels touched. */
function applyLutBanded(buffer, table, channels, width, height) {
  const stride = width * channels;
  let touched = 0;
  for (let rowStart = 0; rowStart < height; rowStart += BAND_ROWS) {
    const lastRow = Math.min(height, rowStart + BAND_ROWS);
    for (let index = rowStart * stride; index < lastRow * stride; index += channels) {
      for (let channel = 0; channel < 3 && channel < channels; channel += 1) {
        buffer[index + channel] = table[buffer[index + channel]];
      }
      touched += 1;
    }
  }
  return touched;
}

/** W3C soft-light, then composited over the base at the layer's alpha. */
function softLightChannel(base, blend, alpha) {
  const backdrop = base / 255;
  const source = blend / 255;
  const mixed =
    source <= 0.5
      ? 2 * backdrop * source + backdrop * backdrop * (1 - 2 * source)
      : Math.sqrt(backdrop) * (2 * source - 1) + 2 * backdrop * (1 - source);
  const clamped = Math.min(1, Math.max(0, mixed));
  return Math.round((backdrop * (1 - alpha) + clamped * alpha) * 255);
}

/**
 * Soft-light composited at `alpha` in a banded raw pass.
 *
 * The spike has to report two numbers because they disagree: libvips 8.17's
 * built-in `soft-light` is not the W3C/Photoshop curve (see the native check),
 * so the engine will own blend math and the backend will only carry pixels.
 * This proves that path produces the documented result at the requested
 * opacity, which is the part M3 depends on.
 */
async function referenceSoftLight(basePng, layerPng, alpha) {
  const baseRaw = await sharp(basePng).raw().toBuffer({ resolveWithObject: true });
  const layerRaw = await sharp(layerPng).raw().toBuffer({ resolveWithObject: true });
  const width = baseRaw.info.width;
  const height = baseRaw.info.height;
  const layerChannels = layerRaw.info.channels;
  const out = Buffer.alloc(width * height * 3);
  const stride = width * 3;
  for (let rowStart = 0; rowStart < height; rowStart += BAND_ROWS) {
    const lastRow = Math.min(height, rowStart + BAND_ROWS);
    for (let row = rowStart; row < lastRow; row += 1) {
      for (let x = 0; x < width; x += 1) {
        const baseIndex = row * stride + x * 3;
        const layerIndex = row * width * layerChannels + x * layerChannels;
        for (let channel = 0; channel < 3; channel += 1) {
          out[baseIndex + channel] = softLightChannel(
            baseRaw.data[baseIndex + channel],
            layerRaw.data[layerIndex + channel],
            alpha
          );
        }
      }
    }
  }
  const png = await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const back = await sharp(png).raw().toBuffer();
  return { png, measured: { r: back[0], g: back[1], b: back[2] } };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * A 64×64 RGBA PNG written with zlib only.
 *
 * Built here rather than with sharp so the decode step proves libvips reads a
 * file it did not produce: (0,0) is [0,0,96,255], the far corner [255,255,96,255].
 */
function handBuiltGradientPng(width, height) {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      rows[offset] = (x * 255) / Math.max(1, width - 1);
      rows[offset + 1] = (y * 255) / Math.max(1, height - 1);
      rows[offset + 2] = 96;
      rows[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function benchmark(size) {
  const { width, height } = size;
  const timings = {};
  let peakRssMb = 0;
  const sampleMemory = () => {
    peakRssMb = Math.max(peakRssMb, Math.round(process.memoryUsage().rss / 1024 / 1024));
  };

  note('benchmark ' + width + '×' + height);
  const png = await timed(timings, 'png.encode', () =>
    sharp({ create: { width, height, channels: 3, background: { r: 118, g: 92, b: 64 } } })
      .png({ compressionLevel: 1 })
      .toBuffer()
  );
  sampleMemory();

  const decoded = await timed(timings, 'png.decode', () =>
    sharp(png).raw().toBuffer({ resolveWithObject: true })
  );
  sampleMemory();
  if (decoded.info.width !== width || decoded.info.height !== height) {
    throw new Error('decode returned ' + decoded.info.width + '×' + decoded.info.height);
  }

  const table = lutFor(CURVE);
  const raw = decoded.data;
  const touched = await timed(timings, 'raw.lut.banded', () =>
    applyLutBanded(raw, table, 3, width, height)
  );
  sampleMemory();
  if (touched !== width * height) {
    throw new Error('raw pass touched ' + touched + ' pixels of ' + width * height);
  }

  const fromRaw = () => sharp(raw, { raw: { width, height, channels: 3 } });
  await timed(timings, 'resize.lanczos', () =>
    fromRaw().resize(2048, 2048, { fit: 'inside' }).png({ compressionLevel: 1 }).toBuffer()
  );
  sampleMemory();
  await timed(timings, 'blur.gaussian3', () => fromRaw().blur(3).raw().toBuffer());
  await timed(timings, 'jpeg.encode', () => fromRaw().jpeg({ quality: 82 }).toBuffer());
  await timed(timings, 'webp.encode', () => fromRaw().webp({ quality: 80 }).toBuffer());
  sampleMemory();

  return {
    megapixels: round((width * height) / 1e6, 1),
    timings,
    peakRssMb,
  };
}

async function main() {
  const files = [];
  const write = (name, bytes) => {
    const file = path.join(dataDir, name);
    fs.writeFileSync(file, bytes);
    files.push(file);
    return file;
  };

  note('decode');
  const gradient = handBuiltGradientPng(64, 64);
  write('spike-hand-built-source.png', gradient);
  const decoded = await sharp(gradient).raw().toBuffer({ resolveWithObject: true });
  const pixelAt = (x, y) => {
    const index = (y * decoded.info.width + x) * decoded.info.channels;
    return [decoded.data[index], decoded.data[index + 1], decoded.data[index + 2]];
  };
  const decodeCheck = {
    width: decoded.info.width,
    height: decoded.info.height,
    channels: decoded.info.channels,
    topLeft: pixelAt(0, 0),
    bottomRight: pixelAt(decoded.info.width - 1, decoded.info.height - 1),
  };

  note('tone curve through a raw LUT pass');
  const table = lutFor(CURVE);
  const ramp = Buffer.alloc(256 * 3);
  for (let value = 0; value < 256; value += 1) {
    ramp[value * 3] = value;
    ramp[value * 3 + 1] = value;
    ramp[value * 3 + 2] = value;
  }
  const rampPng = await sharp(ramp, { raw: { width: 256, height: 1, channels: 3 } })
    .png()
    .toBuffer();
  const rampRaw = await sharp(rampPng).raw().toBuffer({ resolveWithObject: true });
  applyLutBanded(rampRaw.data, table, 3, 256, 1);
  const curvedPng = await sharp(rampRaw.data, { raw: { width: 256, height: 1, channels: 3 } })
    .png()
    .toBuffer();
  write('spike-tone-curve.png', curvedPng);
  const curved = await sharp(curvedPng).raw().toBuffer();
  const sampleInputs = [0, 32, 64, 96, 128, 192, 255];
  const lutCheck = {
    curve: CURVE,
    samples: sampleInputs.map((input) => ({ input, output: curved[input * 3] })),
    matches: Array.from({ length: 256 }, (_, index) => index).filter(
      (index) => curved[index * 3] === table[index]
    ).length,
  };

  note('soft-light composite at 60%');
  const base = { r: 200, g: 80, b: 40 };
  const layer = { r: 60, g: 160, b: 220 };
  const alpha = 0.6;
  const basePng = await sharp({
    create: { width: 8, height: 8, channels: 3, background: base },
  })
    .png()
    .toBuffer();
  const layerPng = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { ...layer, alpha } },
  })
    .png()
    .toBuffer();
  const composited = await sharp(basePng)
    .composite([{ input: layerPng, blend: 'soft-light' }])
    .png()
    .toBuffer();
  write('spike-soft-light.png', composited);
  const { data: compositedRaw } = await sharp(composited).raw().toBuffer({
    resolveWithObject: true,
  });
  const measured = { r: compositedRaw[0], g: compositedRaw[1], b: compositedRaw[2] };
  const expected = {
    r: softLightChannel(base.r, layer.r, alpha),
    g: softLightChannel(base.g, layer.g, alpha),
    b: softLightChannel(base.b, layer.b, alpha),
  };
  const reference = await referenceSoftLight(basePng, layerPng, alpha);
  write('spike-soft-light-reference.png', reference.png);
  const softLightCheck = {
    base,
    layer,
    alpha,
    native: {
      blend: 'soft-light',
      measured,
      expected,
      delta: Math.max(
        Math.abs(measured.r - expected.r),
        Math.abs(measured.g - expected.g),
        Math.abs(measured.b - expected.b)
      ),
    },
    reference: {
      measured: reference.measured,
      delta: Math.max(
        Math.abs(reference.measured.r - expected.r),
        Math.abs(reference.measured.g - expected.g),
        Math.abs(reference.measured.b - expected.b)
      ),
    },
  };

  note('text through SVG rasterisation');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="96">' +
    '<rect width="320" height="96" fill="#ffffff"/>' +
    '<text x="16" y="64" font-family="Helvetica, Arial, sans-serif" font-size="42" fill="#111111">PhotoNext</text>' +
    '</svg>';
  const textPng = await sharp(Buffer.from(svg)).png().toBuffer();
  write('spike-text.png', textPng);
  const textRaw = await sharp(textPng).raw().toBuffer({ resolveWithObject: true });
  let inkPixels = 0;
  for (let index = 0; index < textRaw.data.length; index += textRaw.info.channels) {
    if (
      textRaw.data[index] < 200 ||
      textRaw.data[index + 1] < 200 ||
      textRaw.data[index + 2] < 200
    ) {
      inkPixels += 1;
    }
  }
  const textCheck = {
    width: textRaw.info.width,
    height: textRaw.info.height,
    inkPixels,
  };

  note('WebP encode');
  const webp = await sharp(composited).webp({ quality: 80 }).toBuffer();
  write('spike.webp', webp);
  const webpMeta = await sharp(webp).metadata();
  const webpCheck = {
    bytes: webp.length,
    riff: webp.subarray(0, 4).toString('ascii') === 'RIFF',
    webp: webp.subarray(8, 12).toString('ascii') === 'WEBP',
    width: webpMeta.width,
    height: webpMeta.height,
    format: webpMeta.format,
  };

  const benchmarks = {};
  for (const [name, size] of Object.entries(SIZES)) {
    benchmarks[name] = await benchmark(size);
  }

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pathEnv: process.env.PATH || '',
    dataDir,
    backend: {
      name: 'sharp',
      versions: sharp.versions,
      inputFormats: Object.keys(sharp.format).filter(
        (format) => sharp.format[format].input.buffer
      ),
      outputFormats: Object.keys(sharp.format).filter(
        (format) => sharp.format[format].output.buffer
      ),
    },
    checks: {
      decode: decodeCheck,
      lut: lutCheck,
      softLight: softLightCheck,
      text: textCheck,
      webp: webpCheck,
    },
    benchmarks,
    files,
  };

  fs.writeFileSync(path.join(dataDir, 'spike-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
}

main().catch((error) => {
  const message = error instanceof Error && error.stack ? error.stack : String(error);
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exitCode = 1;
});
