/*
 * Transform matrices, solved rather than eyeballed.
 *
 * Arbitrary rotation, skew and the free-transform matrix are 3×3 affine
 * transforms; perspective is a full homography from four source points to four
 * destination points. Building them here — and testing that a known quad maps to
 * known corners — is what keeps the sampling code in `pixels.cjs` simple: it only
 * ever inverts a matrix and reads a buffer.
 */
'use strict';

function identity() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

function multiply(a, b) {
  const result = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let sum = 0;
      for (let index = 0; index < 3; index += 1) {
        sum += a[row * 3 + index] * b[index * 3 + column];
      }
      result[row * 3 + column] = sum;
    }
  }
  return result;
}

function apply(matrix, x, y) {
  const w = matrix[6] * x + matrix[7] * y + matrix[8];
  const safe = Math.abs(w) < 1e-12 ? 1e-12 : w;
  return {
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / safe,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / safe,
  };
}

function invert(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) {
    throw new Error('This transform collapses the image to a line; nothing was changed.');
  }
  const scale = 1 / det;
  return [
    (e * i - f * h) * scale,
    (c * h - b * i) * scale,
    (b * f - c * e) * scale,
    (f * g - d * i) * scale,
    (a * i - c * g) * scale,
    (c * d - a * f) * scale,
    (d * h - e * g) * scale,
    (b * g - a * h) * scale,
    (a * e - b * d) * scale,
  ];
}

/** Clockwise rotation in degrees around a centre (y down, like the canvas). */
function rotation(degrees, cx, cy) {
  const radians = (Number(degrees) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotate = [cos, -sin, 0, sin, cos, 0, 0, 0, 1];
  const toOrigin = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];
  const back = [1, 0, cx, 0, 1, cy, 0, 0, 1];
  return multiply(back, multiply(rotate, toOrigin));
}

function skew(xDegrees, yDegrees, cx, cy) {
  const tx = Math.tan(((Number(xDegrees) || 0) * Math.PI) / 180);
  const ty = Math.tan(((Number(yDegrees) || 0) * Math.PI) / 180);
  const shear = [1, tx, 0, ty, 1, 0, 0, 0, 1];
  return multiply(
    [1, 0, cx, 0, 1, cy, 0, 0, 1],
    multiply(shear, [1, 0, -cx, 0, 1, -cy, 0, 0, 1])
  );
}

/** The bounding box of a rotated rectangle, used for expand-to-fit. */
function rotatedBounds(width, height, degrees) {
  const radians = (Number(degrees) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  // The epsilon keeps an exact quarter turn at its exact size: cos(90°) is
  // 6e-17, and without it ceil() adds a phantom pixel of width.
  return {
    width: Math.max(1, Math.ceil(width * cos + height * sin - 1e-9)),
    height: Math.max(1, Math.ceil(width * sin + height * cos - 1e-9)),
  };
}

/**
 * The 3×3 homography mapping four source points to four destination points.
 * Solves the standard 8×8 system with partial pivoting; a degenerate quad throws
 * instead of producing a matrix that silently smears the image.
 */
function homography(source, destination) {
  if (!Array.isArray(source) || !Array.isArray(destination) || source.length !== 4 || destination.length !== 4) {
    throw new Error('Perspective needs four source and four destination points.');
  }
  const rows = [];
  for (let index = 0; index < 4; index += 1) {
    const sx = Number(source[index].x !== undefined ? source[index].x : source[index][0]);
    const sy = Number(source[index].y !== undefined ? source[index].y : source[index][1]);
    const dx = Number(destination[index].x !== undefined ? destination[index].x : destination[index][0]);
    const dy = Number(destination[index].y !== undefined ? destination[index].y : destination[index][1]);
    if (![sx, sy, dx, dy].every(Number.isFinite)) {
      throw new Error('Perspective points must be numeric [x, y] pairs.');
    }
    rows.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy, dx]);
    rows.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy, dy]);
  }

  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix.
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-10) {
      throw new Error('Those four points do not describe a perspective transform. Nothing was changed.');
    }
    const swap = rows[column];
    rows[column] = rows[pivot];
    rows[pivot] = swap;
    const divisor = rows[column][column];
    for (let index = column; index <= 8; index += 1) rows[column][index] /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      if (!factor) continue;
      for (let index = column; index <= 8; index += 1) {
        rows[row][index] -= factor * rows[column][index];
      }
    }
  }

  const solution = rows.map((row) => row[8]);
  return [solution[0], solution[1], solution[2], solution[3], solution[4], solution[5], solution[6], solution[7], 1];
}

/** The four corners of a rectangle, clockwise from the top-left. */
function corners(width, height, inset) {
  const pad = Number(inset) || 0;
  return [
    { x: pad, y: pad },
    { x: width - pad, y: pad },
    { x: width - pad, y: height - pad },
    { x: pad, y: height - pad },
  ];
}

/** The nine canvas anchors, as fractions of the padding a resize adds. */
const ANCHORS = {
  'top-left': [0, 0],
  top: [0.5, 0],
  'top-right': [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  'bottom-left': [0, 1],
  bottom: [0.5, 1],
  'bottom-right': [1, 1],
};

function anchorOffset(width, height, newWidth, newHeight, anchor) {
  const fractions = ANCHORS[anchor || 'center'] || ANCHORS.center;
  return {
    x: Math.round((newWidth - width) * fractions[0]),
    y: Math.round((newHeight - height) * fractions[1]),
  };
}

module.exports = {
  ANCHORS: ANCHORS,
  anchorOffset: anchorOffset,
  apply: apply,
  corners: corners,
  homography: homography,
  identity: identity,
  invert: invert,
  multiply: multiply,
  rotatedBounds: rotatedBounds,
  rotation: rotation,
  skew: skew,
};
