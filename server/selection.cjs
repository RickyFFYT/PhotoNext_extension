/*
 * Selections and masks as byte coverage, not geometry.
 *
 * A selection is a mask: one byte per pixel, 255 selected, 0 outside, values in
 * between from feathering and anti-aliasing. Storing it that way means every
 * consumer — adjustment scope, layer mask, brush on a mask — reads the same
 * thing, and a magic wand and a rectangle are indistinguishable downstream.
 *
 * No I/O: these functions take and return `Uint8Array`s, which is what makes the
 * geometry testable without a process or a backend.
 */
'use strict';

function blankMask(width, height, value) {
  const mask = new Uint8Array(width * height);
  if (value) mask.fill(value);
  return mask;
}

function fullMask(width, height) {
  return blankMask(width, height, 255);
}

function overlap(start, end, low, high) {
  return Math.max(0, Math.min(end, high) - Math.max(start, low));
}

/** Rectangle with analytic edge coverage, so a fractional rectangle is not jagged. */
function rectMask(width, height, rect) {
  const mask = new Uint8Array(width * height);
  const x0 = Number(rect.x) || 0;
  const y0 = Number(rect.y) || 0;
  const x1 = x0 + (Number(rect.width) || 0);
  const y1 = y0 + (Number(rect.height) || 0);
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(width, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(height, Math.ceil(y1));
  for (let y = top; y < bottom; y += 1) {
    const cy = overlap(y, y + 1, y0, y1);
    if (!cy) continue;
    for (let x = left; x < right; x += 1) {
      const cx = overlap(x, x + 1, x0, x1);
      if (!cx) continue;
      mask[y * width + x] = Math.round(cx * cy * 255);
    }
  }
  return mask;
}

/** Ellipse with 2×2 supersampling. */
function ellipseMask(width, height, spec) {
  const mask = new Uint8Array(width * height);
  const cx = Number(spec.cx) || 0;
  const cy = Number(spec.cy) || 0;
  const rx = Math.max(0.0001, Number(spec.rx) || 0);
  const ry = Math.max(0.0001, Number(spec.ry) || 0);
  const left = Math.max(0, Math.floor(cx - rx));
  const right = Math.min(width, Math.ceil(cx + rx));
  const top = Math.max(0, Math.floor(cy - ry));
  const bottom = Math.min(height, Math.ceil(cy + ry));
  const offsets = [0.25, 0.75];
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      let inside = 0;
      for (const dy of offsets) {
        for (const dx of offsets) {
          const nx = (x + dx - cx) / rx;
          const ny = (y + dy - cy) / ry;
          if (nx * nx + ny * ny <= 1) inside += 1;
        }
      }
      if (inside) mask[y * width + x] = Math.round((inside / 4) * 255);
    }
  }
  return mask;
}

/**
 * Polygon fill by scanline with four sub-rows, so edges are anti-aliased without
 * a supersample per pixel (which would cost four point-in-polygon tests each).
 */
function polygonMask(width, height, points) {
  const mask = new Uint8Array(width * height);
  const pts = (points || []).map((point) => ({
    x: Number(Array.isArray(point) ? point[0] : point.x),
    y: Number(Array.isArray(point) ? point[1] : point.y),
  }));
  if (pts.length < 3) return mask;
  const sub = 4;
  const row = new Float32Array(width);
  const crossings = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of pts) {
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const top = Math.max(0, Math.floor(minY));
  const bottom = Math.min(height, Math.ceil(maxY));
  for (let y = top; y < bottom; y += 1) {
    row.fill(0);
    for (let sample = 0; sample < sub; sample += 1) {
      const sy = y + (sample + 0.5) / sub;
      crossings.length = 0;
      for (let index = 0; index < pts.length; index += 1) {
        const a = pts[index];
        const b = pts[(index + 1) % pts.length];
        if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) {
          crossings.push(a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
      }
      crossings.sort((left, right) => left - right);
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        const from = Math.max(0, crossings[index]);
        const to = Math.min(width, crossings[index + 1]);
        if (to <= from) continue;
        const first = Math.floor(from);
        const last = Math.ceil(to) - 1;
        for (let x = first; x <= last; x += 1) {
          const coverage = Math.min(x + 1, to) - Math.max(x, from);
          if (coverage > 0) row[x] += coverage / sub;
        }
      }
    }
    for (let x = 0; x < width; x += 1) {
      mask[y * width + x] = Math.round(Math.min(1, row[x]) * 255);
    }
  }
  return mask;
}

function parseColor(value) {
  if (value && typeof value === 'object') {
    return [Number(value.r) || 0, Number(value.g) || 0, Number(value.b) || 0];
  }
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || ''));
  if (!match) throw new Error('Colour "' + value + '" is not a hex value like #ff8800.');
  const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function colorDistance(rgba, index, target) {
  const dr = Math.abs(rgba[index] - target[0]);
  const dg = Math.abs(rgba[index + 1] - target[1]);
  const db = Math.abs(rgba[index + 2] - target[2]);
  return Math.max(dr, dg, db);
}

/**
 * Magic wand. Contiguous uses a flood fill from the seed; otherwise every pixel
 * within the tolerance is selected, which is the "similar" behaviour.
 */
function wandMask(rgba, width, height, spec) {
  const mask = new Uint8Array(width * height);
  const x = Math.round(Number(spec.x));
  const y = Math.round(Number(spec.y));
  if (!(x >= 0 && y >= 0 && x < width && y < height)) {
    throw new Error(
      'The magic wand seed (' + spec.x + ',' + spec.y + ') is outside the ' + width + '×' + height + ' canvas.'
    );
  }
  const tolerance = Math.max(0, Math.min(255, Number(spec.tolerance) || 0));
  const channels = rgba.length / (width * height);
  const seedIndex = (y * width + x) * channels;
  const target = [rgba[seedIndex], rgba[seedIndex + 1], rgba[seedIndex + 2]];
  const contiguous = spec.contiguous !== false;
  if (!contiguous) {
    for (let index = 0; index < width * height; index += 1) {
      if (colorDistance(rgba, index * channels, target) <= tolerance) mask[index] = 255;
    }
    return mask;
  }
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  stack[top++] = y * width + x;
  visited[y * width + x] = 1;
  while (top > 0) {
    const index = stack[--top];
    const px = index % width;
    const py = (index - px) / width;
    if (colorDistance(rgba, index * channels, target) > tolerance) continue;
    mask[index] = 255;
    const neighbours = [
      px > 0 ? index - 1 : -1,
      px + 1 < width ? index + 1 : -1,
      py > 0 ? index - width : -1,
      py + 1 < height ? index + width : -1,
    ];
    for (const neighbour of neighbours) {
      if (neighbour < 0 || visited[neighbour]) continue;
      visited[neighbour] = 1;
      stack[top++] = neighbour;
    }
  }
  return mask;
}

function colorRangeMask(rgba, width, height, spec) {
  const mask = new Uint8Array(width * height);
  const tolerance = Math.max(0, Math.min(255, Number(spec.tolerance) || 0));
  const channels = rgba.length / (width * height);
  let target;
  if (spec.sample && typeof spec.sample === 'object') {
    const x = Math.round(Number(spec.sample.x));
    const y = Math.round(Number(spec.sample.y));
    const index = (y * width + x) * channels;
    target = [rgba[index], rgba[index + 1], rgba[index + 2]];
  } else {
    target = parseColor(spec.color);
  }
  for (let index = 0; index < width * height; index += 1) {
    if (colorDistance(rgba, index * channels, target) <= tolerance) mask[index] = 255;
  }
  return mask;
}

function invertMask(mask) {
  const result = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) result[index] = 255 - mask[index];
  return result;
}

function multiplyMasks(left, right) {
  const result = new Uint8Array(Math.min(left.length, right.length));
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Math.round((left[index] * right[index]) / 255);
  }
  return result;
}

/** Separable box blur over byte coverage; used for feather and smooth. */
function featherMask(mask, width, height, radius) {
  const r = Math.max(0, Math.min(250, Math.round(Number(radius) || 0)));
  if (!r) return mask.slice();
  const count = 2 * r + 1;
  const horizontal = new Float32Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let offset = -r; offset <= r; offset += 1) {
      sum += mask[row + Math.min(width - 1, Math.max(0, offset))];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / count;
      const leaving = Math.min(width - 1, Math.max(0, x - r));
      const entering = Math.min(width - 1, Math.max(0, x + r + 1));
      sum += mask[row + entering] - mask[row + leaving];
    }
  }
  const result = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let offset = -r; offset <= r; offset += 1) {
      sum += horizontal[Math.min(height - 1, Math.max(0, offset)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = Math.round(sum / count);
      const leaving = Math.min(height - 1, Math.max(0, y - r));
      const entering = Math.min(height - 1, Math.max(0, y + r + 1));
      sum += horizontal[entering * width + x] - horizontal[leaving * width + x];
    }
  }
  return result;
}

/** Separable maximum filter with a monotonic deque, for grow. */
function maxFilter(mask, width, height, radius) {
  const r = Math.max(0, Math.min(250, Math.round(Number(radius) || 0)));
  if (!r) return mask.slice();
  const horizontal = new Uint8Array(mask.length);
  const deque = new Int32Array(Math.max(width, height));
  for (let y = 0; y < height; y += 1) {
    let head = 0;
    let tail = 0;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const entering = x + r;
      if (entering < width) {
        while (tail > head && mask[row + deque[tail - 1]] <= mask[row + entering]) tail -= 1;
        deque[tail++] = entering;
      }
      const leaving = x - r - 1;
      if (leaving >= 0 && deque[head] === leaving) head += 1;
      horizontal[row + x] = mask[row + deque[head]];
    }
  }
  const result = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let head = 0;
    let tail = 0;
    for (let y = 0; y < height; y += 1) {
      const entering = y + r;
      if (entering < height) {
        while (tail > head && horizontal[deque[tail - 1] * width + x] <= horizontal[entering * width + x]) {
          tail -= 1;
        }
        deque[tail++] = entering;
      }
      const leaving = y - r - 1;
      if (leaving >= 0 && deque[head] === leaving) head += 1;
      result[y * width + x] = horizontal[deque[head] * width + x];
    }
  }
  return result;
}

function growMask(mask, width, height, radius) {
  return maxFilter(mask, width, height, radius);
}

function contractMask(mask, width, height, radius) {
  return invertMask(maxFilter(invertMask(mask), width, height, radius));
}

/** The band between a grown and a shrunk selection: a stroke along the edge. */
function borderMask(mask, width, height, thickness) {
  const radius = Math.max(1, Math.round(Number(thickness) || 1));
  const grown = growMask(mask, width, height, radius);
  const shrunk = contractMask(mask, width, height, radius);
  const result = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    result[index] = Math.max(0, grown[index] - shrunk[index]);
  }
  return result;
}

function maskBounds(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function maskArea(mask) {
  let total = 0;
  for (let index = 0; index < mask.length; index += 1) total += mask[index];
  return total / 255;
}

function brushGroups(spec) {
  const raw = Array.isArray(spec.paths) ? spec.paths : [spec.points || spec.path || []];
  return raw
    .map((group) =>
      (Array.isArray(group) ? group : [])
        .map((point) => {
          if (Array.isArray(point)) return [Number(point[0]), Number(point[1])];
          if (point && typeof point === 'object') return [Number(point.x), Number(point.y)];
          return null;
        })
        .filter((point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    )
    .filter((group) => group.length > 0);
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  const x = ax + dx * t;
  const y = ay + dy * t;
  return Math.hypot(px - x, py - y);
}

/**
 * A round brush stroke as coverage. Each segment only scans its own padded
 * bounding box, so a long mask stroke does not turn into one full-canvas pass
 * per sample. Four subpixels give the edge the same anti-aliasing as a brush.
 */
function brushMask(width, height, spec) {
  const groups = brushGroups(spec);
  if (!groups.length) throw new Error('Mask brush needs at least one [x, y] point. Nothing was changed.');
  const radius = Math.max(0.5, Number(spec.width || spec.strokeWidth || 32) / 2);
  const shape = new Uint8Array(width * height);
  const offsets = [0.25, 0.75];
  for (const points of groups) {
    const samples = points.length === 1 ? [points[0], points[0]] : points;
    for (let index = 0; index + 1 < samples.length; index += 1) {
      const [ax, ay] = samples[index];
      const [bx, by] = samples[index + 1];
      const left = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1));
      const top = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1));
      const right = Math.min(width, Math.ceil(Math.max(ax, bx) + radius + 1));
      const bottom = Math.min(height, Math.ceil(Math.max(ay, by) + radius + 1));
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          let inside = 0;
          for (const dy of offsets) {
            for (const dx of offsets) {
              if (segmentDistance(x + dx, y + dy, ax, ay, bx, by) <= radius) inside += 1;
            }
          }
          if (!inside) continue;
          const coverage = Math.round((inside / 4) * 255);
          const offset = y * width + x;
          if (coverage > shape[offset]) shape[offset] = coverage;
        }
      }
    }
  }
  return shape;
}

function paintMask(mask, width, height, spec) {
  const value = Math.max(0, Math.min(255, Math.round(Number(spec.value === undefined ? 255 : spec.value))));
  const opacity = Math.max(0, Math.min(1, Number(spec.opacity === undefined ? 1 : spec.opacity)));
  let shape;
  if (spec.shape === 'ellipse') shape = ellipseMask(width, height, spec);
  else if (spec.shape === 'rect') shape = rectMask(width, height, spec);
  else if (spec.shape === 'brush' || Array.isArray(spec.points) || Array.isArray(spec.paths)) {
    shape = brushMask(width, height, spec);
  } else throw new Error('Mask paint needs shape "rect", "ellipse" or "brush". Nothing was changed.');
  const result = mask.slice();
  for (let index = 0; index < result.length; index += 1) {
    const coverage = (shape[index] / 255) * opacity;
    if (!coverage) continue;
    result[index] = Math.round(result[index] * (1 - coverage) + value * coverage);
  }
  return result;
}

/** Mask from a raster's alpha channel, for "select the opaque part". */
function maskFromAlpha(rgba, width, height, threshold) {
  const cut = Number(threshold === undefined ? 1 : threshold);
  const channels = rgba.length / (width * height);
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const alpha = channels === 4 ? rgba[index * channels + 3] : 255;
    mask[index] = alpha >= cut ? 255 : 0;
  }
  return mask;
}

module.exports = {
  blankMask: blankMask,
  brushMask: brushMask,
  borderMask: borderMask,
  colorRangeMask: colorRangeMask,
  contractMask: contractMask,
  ellipseMask: ellipseMask,
  featherMask: featherMask,
  fullMask: fullMask,
  growMask: growMask,
  invertMask: invertMask,
  maskArea: maskArea,
  maskBounds: maskBounds,
  maskFromAlpha: maskFromAlpha,
  multiplyMasks: multiplyMasks,
  paintMask: paintMask,
  polygonMask: polygonMask,
  rectMask: rectMask,
  wandMask: wandMask,
};
