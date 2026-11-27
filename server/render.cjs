/*
 * The render backend: libvips through the vendored `sharp` (Decision D1).
 *
 * This replaces `/usr/bin/sips`. The important difference is not the format
 * list, it is that the extension can now express operations a bitmap editor
 * needs — decode/encode without a subprocess, real resampling kernels, and a
 * pixel pipeline the raw passes in M2 can hand buffers to.
 *
 * The module loads the backend once and reports absence instead of throwing at
 * import time: `photo_status` is polled, and a missing backend must show up as a
 * capability answer, not as a dead panel.
 */
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sharp = null;
let backendError = null;
try {
  // By path, never by name: the installed builtin has no PATH and no npm.
  sharp = require(path.join(__dirname, 'vendor', 'node_modules', 'sharp'));
} catch (error) {
  backendError = error instanceof Error ? error.message : String(error);
}

function available() {
  return sharp !== null;
}

function requireBackend() {
  if (!sharp) {
    throw new Error(
      'PhotoNext needs its bundled libvips backend, which failed to load: ' +
        backendError +
        '. Nothing was changed.'
    );
  }
  return sharp;
}

function capabilities() {
  if (!sharp) {
    return {
      available: false,
      backend: 'none',
      platform: process.platform,
      error: backendError,
    };
  }
  return {
    available: true,
    backend: 'libvips',
    vips: sharp.versions.vips,
    sharp: sharp.versions.sharp,
    platform: process.platform,
    inputFormats: Object.keys(sharp.format).filter((name) => sharp.format[name].input.buffer),
    outputFormats: Object.keys(sharp.format).filter((name) => sharp.format[name].output.buffer),
  };
}

function outputExtension(format) {
  return format === 'jpeg' ? 'jpg' : format;
}

function encodeBuffer(image, format, quality) {
  switch (format) {
    case 'jpeg':
      return image.jpeg({ quality: Math.min(100, Math.max(1, Math.round(Number(quality) || 90))) });
    case 'webp':
      return image.webp({ quality: Math.min(100, Math.max(1, Math.round(Number(quality) || 90))) });
    case 'tiff':
      return image.tiff();
    case 'gif':
      return image.gif();
    default:
      return image.png({ compressionLevel: 6 });
  }
}

/** Dimensions, format and colour facts, read by the backend rather than guessed. */
async function readImage(buffer) {
  const metadata = await requireBackend()(buffer, { failOn: 'none' }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('The backend could not read this image. Nothing was changed.');
  }
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format || 'png',
    hasAlpha: Boolean(metadata.hasAlpha),
    orientation: metadata.orientation || 1,
    space: metadata.space || null,
    channels: metadata.channels || null,
    pages: metadata.pages || 1,
    hasProfile: Boolean(metadata.icc || metadata.hasProfile),
  };
}

/**
 * Bake EXIF orientation into the pixels.
 *
 * A phone photo is commonly stored sideways with an orientation tag. Copying it
 * as-is means every crop and layer offset is computed in the wrong space; the
 * most visible agent failure is a image that arrives rotated. Returns null when
 * the image is already upright, so an unrotated import keeps its original bytes.
 */
async function autorotate(buffer) {
  const backend = requireBackend();
  const metadata = await backend(buffer, { failOn: 'none' }).metadata();
  if (!metadata.orientation || metadata.orientation === 1 || metadata.orientation === undefined) {
    return null;
  }
  const format = ['jpeg', 'webp', 'tiff', 'gif'].indexOf(metadata.format) === -1 ? 'png' : metadata.format;
  const output = await encodeBuffer(backend(buffer, { failOn: 'none' }).rotate(), format).toBuffer();
  const size = await readImage(output);
  return {
    buffer: output,
    width: size.width,
    height: size.height,
    format: format,
    orientation: metadata.orientation,
  };
}

/** A PNG render at a bounded edge, kept for revision diffs. */
async function thumbnail(buffer, maxEdge) {
  const edge = Math.max(64, Math.round(Number(maxEdge) || 1400));
  return requireBackend()(buffer, { failOn: 'none' })
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 3 })
    .toBuffer();
}

/**
 * Run a plan from `ops.planEdit`. The argument order is the plan's fixed order —
 * rotate, flip, crop, resize — and libvips applies those in the same order.
 */
async function applyPlan(buffer, plan, options) {
  const backend = requireBackend();
  let image = backend(buffer, { failOn: 'none' });
  for (const operation of plan.operations) {
    if (operation.kind === 'rotate') {
      image = image.rotate(operation.degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    } else if (operation.kind === 'flip') {
      image = operation.axis === 'horizontal' ? image.flop() : image.flip();
    } else if (operation.kind === 'crop') {
      image = image.extract({
        left: operation.rect.x,
        top: operation.rect.y,
        width: operation.rect.width,
        height: operation.rect.height,
      });
    } else if (operation.kind === 'resize') {
      image = image.resize(operation.size.width, operation.size.height, {
        fit: 'fill',
        kernel: 'lanczos3',
      });
    } else {
      throw new Error('Unknown edit operation: ' + operation.kind);
    }
  }
  // A plan without `format` keeps the layer's own format, which is what the
  // pre-M1 tool did; the caller passes it as the fallback.
  const format = plan.format || (options && options.format) || 'png';
  const output = await encodeBuffer(image, format).toBuffer();
  const size = await readImage(output);
  return {
    buffer: output,
    width: size.width,
    height: size.height,
    format: format,
  };
}

/** Encode a raw RGBA buffer (already decoded) with optional resize. */
async function encodeRaw(raw, options) {
  const settings = options || {};
  const backend = requireBackend();
  let image = backend(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: raw.channels || 4 },
  });
  if (settings.resize) {
    image = image.resize(settings.resize.width, settings.resize.height, {
      fit: 'fill',
      kernel: 'lanczos3',
    });
  }
  const format = settings.format || 'png';
  const output = await encodeBuffer(image, format, settings.quality).toBuffer();
  const size = await readImage(output);
  return { buffer: output, width: size.width, height: size.height, format: format };
}

/**
 * Flatten visible layers onto the canvas.
 *
 * M1 only ever has one raster layer, so the composite is the layer itself. The
 * loop exists because the document already supports more, and M3 fills in blend
 * modes and masks here rather than growing a second compositor somewhere else.
 */
async function flatten(canvas, parts) {
  if (!parts.length) throw new Error('The document has no visible layer to render.');
  const backend = requireBackend();
  if (parts.length === 1) return parts[0].buffer;
  const base = backend({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  return base
    .composite(
      parts.map((part) => ({
        input: part.buffer,
        left: part.offset ? part.offset.x : 0,
        top: part.offset ? part.offset.y : 0,
        blend: 'over',
      }))
    )
    .png()
    .toBuffer();
}

/**
 * Gaussian blur on a raw buffer, in native code. This is the fast path for the
 * blur family: the JS passes are exact and testable, but a 80 MP three-box blur
 * is seconds, while libvips does it in tens of milliseconds.
 */
async function blurRaw(raw, sigma) {
  const backend = requireBackend();
  const { data, info } = await backend(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: raw.channels || 4 },
  })
    .blur(Math.max(0.3, Math.min(1000, Number(sigma) || 0.3)))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: data, width: info.width, height: info.height, channels: info.channels };
}

/** Native median blur; libvips' window is what makes a large median usable. */
async function medianRaw(raw, size) {
  const backend = requireBackend();
  const window = Math.max(3, Math.min(11, Math.round(Number(size) || 3)));
  const { data, info } = await backend(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: raw.channels || 4 },
  })
    .median(window)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: data, width: info.width, height: info.height, channels: info.channels };
}

/** Arbitrary rotation in native code, with expand-to-fit or centre-crop-to-fit. */
async function rotateRaw(raw, degrees, options) {
  const settings = options || {};
  const backend = requireBackend();
  let image = backend(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: raw.channels || 4 },
  }).rotate(Number(degrees) || 0, {
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  if (settings.fit === 'crop') {
    const metadata = await image.metadata();
    const width = Math.min(raw.width, metadata.width);
    const height = Math.min(raw.height, metadata.height);
    const left = Math.max(0, Math.floor((metadata.width - width) / 2));
    const top = Math.max(0, Math.floor((metadata.height - height) / 2));
    image = image.extract({ left: left, top: top, width: width, height: height });
  }
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { data: data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Rasterise an SVG document to raw RGBA at exactly these pixel dimensions.
 *
 * Drawing primitives go through librsvg rather than a second scanline renderer:
 * curves, dashes, joins and text masks then match the rest of the pipeline's
 * anti-aliasing. Density 72 keeps SVG user units equal to pixels, and `resize`
 * guards against a sub-pixel rounding difference between the requested size and
 * what librsvg reports.
 */
/**
 * A font downloaded during this process is invisible to the already-initialised
 * fontconfig. A short-lived child gets a fresh fontconfig view and rasterises
 * the same SVG, so custom text lands in the same pipeline as every other mark.
 */
async function rasterizeSvgWithFonts(svg, width, height, fontDir) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'photonext-font-'));
  const svgPath = path.join(directory, 'mark.svg');
  const rawPath = path.join(directory, 'mark.raw');
  try {
    fs.writeFileSync(svgPath, svg);
    await new Promise((resolve, reject) => {
      childProcess.execFile(
        process.execPath,
        [path.join(__dirname, 'font-render.cjs'), svgPath, rawPath, String(width), String(height)],
        {
          env: Object.assign({}, process.env, {
            FONTCONFIG_FILE: path.join(fontDir, 'fontconfig.conf'),
            PANGOCAIRO_BACKEND: 'fontconfig',
          }),
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
        (error, _stdout, stderr) => {
          if (error) {
            error.message = 'Font rasteriser failed: ' + (stderr || error.message).trim();
            reject(error);
            return;
          }
          resolve();
        }
      );
    });
    const data = fs.readFileSync(rawPath);
    if (data.length !== width * height * 4) {
      throw new Error('Font rasteriser returned ' + data.length + ' bytes, expected ' + width * height * 4 + '.');
    }
    return { data: data, width: width, height: height, channels: 4 };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function rasterizeSvg(svg, width, height, options) {
  if (options && options.fontDir) {
    return rasterizeSvgWithFonts(svg, width, height, options.fontDir);
  }
  const backend = requireBackend();
  const { data, info } = await backend(Buffer.from(svg), { density: 72, failOn: 'none' })
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: data, width: info.width, height: info.height, channels: info.channels };
}

/** A JPEG preview data URL, built only when the revision changed. */
async function preview(buffer, maxEdge) {
  const edge = Math.max(64, Math.round(Number(maxEdge) || 1400));
  const output = await requireBackend()(buffer, { failOn: 'none' })
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer();
  return 'data:image/jpeg;base64,' + output.toString('base64');
}

/** Encode an export, optionally resizing only the exported copy. */
async function encode(buffer, options) {
  const settings = options || {};
  const backend = requireBackend();
  let image = backend(buffer, { failOn: 'none' });
  if (settings.resize) {
    image = image.resize(settings.resize.width, settings.resize.height, {
      fit: 'fill',
      kernel: 'lanczos3',
    });
  }
  const output = await encodeBuffer(image, settings.format || 'png', settings.quality).toBuffer();
  const size = await readImage(output);
  return { buffer: output, width: size.width, height: size.height, format: size.format };
}

module.exports = {
  applyPlan: applyPlan,
  autorotate: autorotate,
  available: available,
  blurRaw: blurRaw,
  capabilities: capabilities,
  encode: encode,
  encodeBuffer: encodeBuffer,
  encodeRaw: encodeRaw,
  flatten: flatten,
  medianRaw: medianRaw,
  outputExtension: outputExtension,
  preview: preview,
  rasterizeSvg: rasterizeSvg,
  readImage: readImage,
  requireBackend: requireBackend,
  rotateRaw: rotateRaw,
  thumbnail: thumbnail,
};
