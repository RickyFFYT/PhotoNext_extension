/*
 * The edit plan, separate from the process that executes it.
 *
 * The agent names an edit in image terms — rotate by an angle, keep this
 * rectangle, land at this size, skew this much, pull these four corners — and
 * this file turns that into the ordered operations the engine executes. Keeping
 * the arithmetic here is what makes the question that matters testable without a
 * process: does a 1000×500 image cropped to 400×300 come out 400×300?
 *
 * Coordinates are in the *current* image's space, after any rotation in the same
 * call. That is the space the agent is describing when it composes an edit, so no
 * hidden transform sits between the rectangle it names and the pixels kept.
 *
 * The order is fixed rather than following the argument order: rotate, flip,
 * skew, perspective, crop, resize, canvas, trim. Rotate first so crop
 * coordinates mean what the caller sees; trim last because it is a cleanup.
 */
'use strict';

var transform = require('./transform.cjs');

var MIN_EDGE = 1;
var MAX_EDGE = 12000;
var IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'gif', 'heic', 'webp'];
var SAMPLERS = ['bilinear', 'nearest'];
var RESIZE_FITS = ['stretch', 'fit', 'fill', 'pad'];
var ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

function toInt(value) {
  var number = Math.round(Number(value));
  return Number.isFinite(number) ? number : 0;
}

function clampEdge(value, fallback) {
  var edge = toInt(value);
  if (!edge) edge = fallback;
  return Math.max(MIN_EDGE, Math.min(MAX_EDGE, edge));
}

/** Width/height after a clockwise rotation, including an arbitrary angle. */
function rotatedSize(image, rotate) {
  var angle = Number(rotate) || 0;
  var quarter = ((Math.round(angle / 90) % 4) + 4) % 4;
  if (Math.abs(angle - Math.round(angle / 90) * 90) < 0.01) {
    return quarter % 2 === 0
      ? { width: toInt(image.width), height: toInt(image.height) }
      : { width: toInt(image.height), height: toInt(image.width) };
  }
  return transform.rotatedBounds(toInt(image.width), toInt(image.height), angle);
}

/** A crop in the rotated image's pixels, clamped so it is never outside it. */
function clampCropIn(bounds, crop) {
  if (!crop) return null;
  var x = Math.max(0, Math.min(bounds.width - MIN_EDGE, toInt(crop.x)));
  var y = Math.max(0, Math.min(bounds.height - MIN_EDGE, toInt(crop.y)));
  var width = Math.max(MIN_EDGE, Math.min(bounds.width - x, toInt(crop.width)));
  var height = Math.max(MIN_EDGE, Math.min(bounds.height - y, toInt(crop.height)));
  return { x: x, y: y, width: width, height: height };
}

function clampCrop(image, rotate, crop) {
  return clampCropIn(rotatedSize(image, rotate), crop);
}

function normalizedRotate(value) {
  var number = Number(value);
  if (!Number.isFinite(number) || number === 0) return 0;
  var snapped = Math.round(number / 90) * 90;
  if (Math.abs(number - snapped) < 0.01) {
    var quarter = ((Math.round(snapped / 90) % 4) + 4) % 4;
    return quarter * 90;
  }
  return ((number % 360) + 360) % 360;
}

function normalizedFlip(value) {
  if (value === 'horizontal' || value === 'vertical') return value;
  return null;
}

function parseBackground(value) {
  if (value === undefined || value === null || value === 'transparent') return [0, 0, 0, 0];
  var match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value));
  if (!match) {
    throw new Error('"canvas.background" must be "transparent" or a hex colour like #ffffff.');
  }
  var hex = match[1].length === 3 ? match[1].replace(/./g, function (c) { return c + c; }) : match[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    255,
  ];
}

function normalizeSampler(value) {
  if (value === undefined || value === null) return 'bilinear';
  if (SAMPLERS.indexOf(value) === -1) {
    throw new Error('"sampler" must be one of: ' + SAMPLERS.join(', ') + '.');
  }
  return value;
}

function normalizePerspective(request, available) {
  var corners;
  if (Array.isArray(request)) {
    corners = request.map(function (point) {
      return Array.isArray(point) ? { x: Number(point[0]), y: Number(point[1]) } : point;
    });
  } else if (request && typeof request === 'object' && Array.isArray(request.corners)) {
    corners = request.corners.map(function (point) {
      return Array.isArray(point) ? { x: Number(point[0]), y: Number(point[1]) } : point;
    });
  } else if (request && typeof request === 'object') {
    corners = [request.topLeft, request.topRight, request.bottomRight, request.bottomLeft].map(
      function (point) {
        return Array.isArray(point) ? { x: Number(point[0]), y: Number(point[1]) } : point;
      }
    );
  }
  if (!corners || corners.length !== 4 || corners.some(function (point) { return !point; })) {
    throw new Error(
      'Perspective needs four corners: "corners": [topLeft, topRight, bottomRight, bottomLeft] as [x, y] pairs.'
    );
  }
  for (var index = 0; index < 4; index += 1) {
    if (!Number.isFinite(corners[index].x) || !Number.isFinite(corners[index].y)) {
      throw new Error('Perspective corner ' + (index + 1) + ' needs numeric x and y.');
    }
  }
  return {
    corners: corners,
    width: request.width ? clampEdge(request.width, available.width) : available.width,
    height: request.height ? clampEdge(request.height, available.height) : available.height,
    sampler: normalizeSampler(request.sampler),
  };
}

/** Resize with the documented fit modes; returns the operations it implies. */
function planResize(request, available) {
  if (!request || typeof request !== 'object') return null;
  var fit = request.fit === undefined ? 'stretch' : request.fit;
  if (RESIZE_FITS.indexOf(fit) === -1) {
    throw new Error('"resize.fit" must be one of: ' + RESIZE_FITS.join(', ') + '.');
  }
  var width = clampEdge(request.width, available.width);
  var height = clampEdge(request.height, available.height);
  if (fit === 'stretch') {
    return { operations: [{ kind: 'resize', size: { width: width, height: height } }], size: { width: width, height: height }, label: 'resized to ' + width + '×' + height };
  }
  var contained = Math.min(width / available.width, height / available.height);
  var fitWidth = Math.max(1, Math.round(available.width * contained));
  var fitHeight = Math.max(1, Math.round(available.height * contained));
  if (fit === 'fit') {
    return {
      operations: [{ kind: 'resize', size: { width: fitWidth, height: fitHeight } }],
      size: { width: fitWidth, height: fitHeight },
      label: 'fit inside ' + width + '×' + height + ' (' + fitWidth + '×' + fitHeight + ')',
    };
  }
  if (fit === 'fill') {
    var covered = Math.max(width / available.width, height / available.height);
    var coverWidth = Math.max(1, Math.round(available.width * covered));
    var coverHeight = Math.max(1, Math.round(available.height * covered));
    return {
      operations: [
        { kind: 'resize', size: { width: coverWidth, height: coverHeight } },
        {
          kind: 'crop',
          rect: {
            x: Math.max(0, Math.floor((coverWidth - width) / 2)),
            y: Math.max(0, Math.floor((coverHeight - height) / 2)),
            width: Math.min(width, coverWidth),
            height: Math.min(height, coverHeight),
          },
        },
      ],
      size: { width: width, height: height },
      label: 'filled ' + width + '×' + height,
    };
  }
  // pad: fit inside, then extend the canvas to the exact size.
  return {
    operations: [
      { kind: 'resize', size: { width: fitWidth, height: fitHeight } },
      {
        kind: 'canvas',
        width: width,
        height: height,
        anchor: request.anchor || 'center',
        background: parseBackground(request.background),
      },
    ],
    size: { width: width, height: height },
    label: 'padded to ' + width + '×' + height,
  };
}

function planEdit(args, image) {
  var rotate = normalizedRotate(args.rotate);
  var flip = normalizedFlip(args.flip);
  var sampler = normalizeSampler(args.sampler);
  var rotated = rotatedSize(image, rotate);

  var skew = null;
  if (args.skew && typeof args.skew === 'object') {
    var skewX = Number(args.skew.x) || 0;
    var skewY = Number(args.skew.y) || 0;
    if (Math.abs(skewX) > 60 || Math.abs(skewY) > 60) {
      throw new Error('Skew is limited to ±60 degrees per axis.');
    }
    if (skewX || skewY) skew = { kind: 'skew', x: skewX, y: skewY, sampler: sampler };
  }

  // Skew grows the canvas to hold the sheared corners, exactly as the engine
  // does it, so a crop or resize in the same call measures the real image.
  var sheared = rotated;
  if (skew) {
    var shear = transform.skew(skew.x, skew.y, rotated.width / 2, rotated.height / 2);
    var shearedPoints = transform
      .corners(rotated.width, rotated.height)
      .map(function (corner) {
        return transform.apply(shear, corner.x, corner.y);
      });
    var shearMinX = Math.min.apply(null, shearedPoints.map(function (point) { return point.x; }));
    var shearMinY = Math.min.apply(null, shearedPoints.map(function (point) { return point.y; }));
    var shearMaxX = Math.max.apply(null, shearedPoints.map(function (point) { return point.x; }));
    var shearMaxY = Math.max.apply(null, shearedPoints.map(function (point) { return point.y; }));
    sheared = {
      width: Math.max(1, Math.ceil(shearMaxX - shearMinX - 1e-9)),
      height: Math.max(1, Math.ceil(shearMaxY - shearMinY - 1e-9)),
    };
  }

  var perspective = args.perspective ? normalizePerspective(args.perspective, sheared) : null;
  var available = perspective
    ? { width: perspective.width, height: perspective.height }
    : { width: sheared.width, height: sheared.height };
  var crop = clampCropIn(available, args.crop || null);

  var availableAfterCrop = crop
    ? { width: crop.width, height: crop.height }
    : { width: available.width, height: available.height };
  var resize = planResize(args.resize, availableAfterCrop);

  var canvas = null;
  if (args.canvas && typeof args.canvas === 'object') {
    var anchor = args.canvas.anchor === undefined ? 'center' : args.canvas.anchor;
    if (ANCHORS.indexOf(anchor) === -1) {
      throw new Error('"canvas.anchor" must be one of: ' + ANCHORS.join(', ') + '.');
    }
    canvas = {
      kind: 'canvas',
      width: clampEdge(args.canvas.width, availableAfterCrop.width),
      height: clampEdge(args.canvas.height, availableAfterCrop.height),
      anchor: anchor,
      background: parseBackground(args.canvas.background),
    };
  }

  var trim = null;
  if (args.trim) {
    trim = {
      kind: 'trim',
      tolerance: Math.max(0, Math.min(255, toInt(args.trim.tolerance))),
      trimTransparent: args.trim.trimTransparent !== false,
    };
  }

  var operations = [];
  if (rotate) operations.push({ kind: 'rotate', degrees: rotate, fit: args.rotateFit || 'expand' });
  if (flip) operations.push({ kind: 'flip', axis: flip });
  if (skew) operations.push(skew);
  if (perspective) {
    operations.push({
      kind: 'perspective',
      corners: perspective.corners,
      width: perspective.width,
      height: perspective.height,
      sampler: perspective.sampler,
    });
  }
  if (crop) operations.push({ kind: 'crop', rect: crop });
  if (resize) operations.push.apply(operations, resize.operations);
  if (canvas) operations.push(canvas);
  if (trim) operations.push(trim);

  var format = typeof args.format === 'string' ? args.format.toLowerCase() : null;
  if (format === 'jpg') format = 'jpeg';
  if (format !== null && format !== 'png' && format !== 'jpeg') format = null;

  return {
    operations: operations,
    format: format,
    summary: summarize(operations, format, resize),
  };
}

/** The sips arguments for one operation, kept for the pre-M1 contract test. */
function sipsArgsFor(operation, input, output) {
  var args;
  switch (operation.kind) {
    case 'rotate':
      args = ['-r', String(operation.degrees)];
      break;
    case 'flip':
      args = ['-f', operation.axis];
      break;
    case 'crop':
      args = [
        '-c',
        String(operation.rect.height),
        String(operation.rect.width),
        '--cropOffset',
        String(operation.rect.y),
        String(operation.rect.x),
      ];
      break;
    case 'resize':
      args = ['-z', String(operation.size.height), String(operation.size.width)];
      break;
    default:
      throw new Error('Unknown edit operation: ' + operation.kind);
  }
  args.push(input, '--out', output);
  return args;
}

function summarize(operations, format, resize) {
  if (!operations.length && !format) return 'No changes';
  var parts = operations.map(function (operation) {
    if (operation.kind === 'rotate') return 'rotated ' + operation.degrees + '°';
    if (operation.kind === 'flip') return 'flipped ' + operation.axis;
    if (operation.kind === 'skew') return 'skewed ' + operation.x + '°/' + operation.y + '°';
    if (operation.kind === 'perspective') return 'perspective corrected';
    if (operation.kind === 'crop')
      return (
        'cropped to ' +
        operation.rect.width +
        '×' +
        operation.rect.height +
        ' at ' +
        operation.rect.x +
        ',' +
        operation.rect.y
      );
    if (operation.kind === 'resize')
      return resize && resize.label ? resize.label : 'resized to ' + operation.size.width + '×' + operation.size.height;
    if (operation.kind === 'canvas')
      return 'canvas ' + operation.width + '×' + operation.height;
    if (operation.kind === 'trim') return 'trimmed borders';
    return operation.kind;
  });
  if (format) parts.push('saved as ' + format);
  return parts.join(' · ');
}

/** The extension of a path, normalized and checked against what the backend reads. */
function imageExtension(filePath) {
  var match = /\.([A-Za-z0-9]+)$/.exec(String(filePath || ''));
  if (!match) return null;
  var extension = match[1].toLowerCase();
  if (extension === 'jpeg') extension = 'jpg';
  if (extension === 'tif') extension = 'tiff';
  return IMAGE_EXTENSIONS.indexOf(extension) === -1 ? null : extension;
}

function formatForExtension(extension) {
  if (extension === 'jpg') return 'jpeg';
  if (extension === 'tiff') return 'tiff';
  return extension;
}

/** A file name an agent can use without carrying a directory through it. */
function suggestedName(name, extension) {
  var base = String(name || 'image').split(/[\\/]/).pop() || 'image';
  var stem = base.replace(/\.[^.]+$/, '');
  var safe =
    stem
      .replace(/[^A-Za-z0-9 _-]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim() || 'image';
  return safe + '.' + (extension || 'png');
}

module.exports = {
  ANCHORS: ANCHORS,
  RESIZE_FITS: RESIZE_FITS,
  clampCrop: clampCrop,
  formatForExtension: formatForExtension,
  imageExtension: imageExtension,
  planEdit: planEdit,
  rotatedSize: rotatedSize,
  sipsArgsFor: sipsArgsFor,
  suggestedName: suggestedName,
};
