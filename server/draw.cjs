/*
 * Vector drawing, rasterised by the bundled libvips.
 *
 * The agent sends primitives in canvas coordinates; this module turns them into
 * one SVG document sized to their bounding box, and `render.rasterizeSvg`
 * turns that into pixels. Doing it this way means curves, dashes, line caps,
 * joins, anti-aliasing and text come from the same rasteriser the rest of the
 * engine already depends on, instead of a second hand-written scanline renderer
 * that would disagree with it at the edges.
 *
 * Everything here is pure: no document, no store, no I/O. The engine composites
 * the result onto a layer, clipped by the selection or the layer mask.
 */
'use strict';

const MAX_POINTS = 4000;
const MAX_COMMANDS = 64;
const DEFAULT_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const NAMED_COLORS = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff3b30',
  orange: '#ff9500',
  yellow: '#ffcc00',
  green: '#34c759',
  teal: '#30b0c7',
  blue: '#007aff',
  indigo: '#5856d6',
  purple: '#af52de',
  pink: '#ff2d55',
  grey: '#8e8e93',
  gray: '#8e8e93',
  transparent: 'none',
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min === undefined ? -1e9 : min, max === undefined ? 1e9 : max);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeColor(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  const named = NAMED_COLORS[raw.toLowerCase()];
  if (named) return named;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return raw;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(raw);
  if (rgb) {
    const alpha = rgb[4] === undefined ? '' : `/${clamp(Number(rgb[4]), 0, 1)}`;
    return `rgba(${Math.round(Number(rgb[1]))},${Math.round(Number(rgb[2]))},${Math.round(
      Number(rgb[3])
    )}${alpha})`;
  }
  throw new Error(
    'Unsupported colour "' + raw + '". Use #rrggbb, #rgb, rgb(r,g,b), or a basic colour name.'
  );
}

/**
 * Parse a colour into straight RGBA bytes for pixel passes.
 *
 * Vector commands can keep colours as strings and let the SVG rasteriser parse
 * them; a bucket fill has to compare and write bytes itself. This is the one
 * parser for both, so a named colour works in either place.
 */
function colorChannels(value, fallback) {
  const normalized = normalizeColor(value, fallback);
  if (!normalized || normalized === 'none') return [0, 0, 0, 0];
  if (normalized[0] === '#') {
    const hex = normalized.slice(1);
    const short = hex.length === 3;
    return [
      parseInt(short ? hex[0] + hex[0] : hex.slice(0, 2), 16),
      parseInt(short ? hex[1] + hex[1] : hex.slice(2, 4), 16),
      parseInt(short ? hex[2] + hex[2] : hex.slice(4, 6), 16),
      hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(
    normalized
  );
  if (rgb) {
    return [
      Math.round(clamp(Number(rgb[1]), 0, 255)),
      Math.round(clamp(Number(rgb[2]), 0, 255)),
      Math.round(clamp(Number(rgb[3]), 0, 255)),
      Math.round(clamp(rgb[4] === undefined ? 1 : Number(rgb[4]), 0, 1) * 255),
    ];
  }
  return [255, 255, 255, 255];
}

function pointPair(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function normalizePoints(raw, label) {
  const source = Array.isArray(raw) ? raw : [];
  const points = [];
  for (const entry of source) {
    const point = pointPair(entry);
    if (point) points.push(point);
    if (points.length >= MAX_POINTS) break;
  }
  if (points.length < 2) {
    throw new Error(label + ' needs at least two [x, y] points. Nothing was drawn.');
  }
  return points;
}

/**
 * A path command may carry several subpaths. `points` is one path; `paths` is
 * an array of paths, which is how one command draws a silhouette and its holes
 * (a car body, windows) without making the agent emit every piece separately.
 */
function pointGroups(spec, label) {
  const paths = Array.isArray(spec.paths) ? spec.paths : null;
  if (paths) {
    if (!paths.length) {
      throw new Error(label + ' needs at least one path. Nothing was drawn.');
    }
    return paths.map((entry, index) =>
      normalizePoints(entry, label + ' path ' + (index + 1))
    );
  }
  return [normalizePoints(spec.points || spec.path, label)];
}

/** Clone accepts a stroke, several strokes, or a single x/y stamp. */
function clonePointGroups(command) {
  if (Array.isArray(command.paths) && command.paths.length) {
    return pointGroups(command, 'A clone stamp');
  }
  if (Array.isArray(command.points) && command.points.length) {
    return [normalizePoints(command.points, 'A clone stamp')];
  }
  if (Number.isFinite(Number(command.x)) && Number.isFinite(Number(command.y))) {
    return [[[Number(command.x), Number(command.y)]]];
  }
  throw new Error('A clone stamp needs `points`, `paths`, or `x` and `y`. Nothing was drawn.');
}

function fillRuleAttribute(groups, spec) {
  const requested = String(spec.fillRule || '').toLowerCase();
  if (requested && requested !== 'evenodd' && requested !== 'nonzero') {
    throw new Error('fillRule must be "evenodd" or "nonzero". Nothing was drawn.');
  }
  if (requested === 'evenodd' || (!requested && groups.length > 1)) {
    return ' fill-rule="evenodd"';
  }
  return '';
}

/**
 * Catmull-Rom through the points, emitted as cubic segments. A two-point path
 * is a straight line; three or more bends smoothly through every supplied
 * point, which is what makes a handful of brush samples read as a stroke.
 */
function smoothPath(points, closed) {
  if (points.length === 2) {
    return `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`;
  }
  const count = points.length;
  const at = (index) =>
    closed ? points[((index % count) + count) % count] : points[clamp(index, 0, count - 1)];
  let path = `M ${points[0][0]} ${points[0][1]}`;
  const last = closed ? count : count - 1;
  for (let index = 0; index < last; index += 1) {
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    path += ` C ${round(c1[0])} ${round(c1[1])}, ${round(c2[0])} ${round(c2[1])}, ${round(
      p2[0]
    )} ${round(p2[1])}`;
  }
  return closed ? path + ' Z' : path;
}

function linePath(points) {
  return `M ${points
    .map((point) => `${round(point[0])} ${round(point[1])}`)
    .join(' L ')}`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function dashArray(style, width) {
  if (style === 'dotted') return `${round(width)} ${round(width * 2.2)}`;
  if (style === 'dashed') return `${round(width * 3)} ${round(width * 2)}`;
  return null;
}

/**
 * Sketch strokes: many freehand samples in one command, with optional taper.
 *
 * A sketch is the fast path for rough work — a face, a scene block-in, a
 * signature — where sending one `stroke` command per line costs the model a
 * turn of reasoning for each and floods the undo stack. One sketch command is
 * one undoable entry however many strokes it carries.
 *
 * Taper is the difference between a wire and a drawn line: `pressure` may be
 * `true` (a natural ease-in/ease-out profile) or an array of 0–1 values sampled
 * along the stroke. Tapered strokes are emitted as short round-capped segments
 * whose widths follow that profile, which is why they read as ink rather than a
 * constant-width polyline.
 */
function sketchStrokes(spec) {
  const raw = Array.isArray(spec.strokes) ? spec.strokes : [];
  if (!raw.length) {
    throw new Error('A sketch command needs a non-empty `strokes` array. Nothing was drawn.');
  }
  if (raw.length > 32) {
    throw new Error('A sketch command takes at most 32 strokes. Nothing was drawn.');
  }
  const defaultWidth = number(spec.width, 5, 0.25, 4000);
  const defaultColor = spec.color || '#ffffff';
  const defaultOpacity = number(spec.opacity, 1, 0, 1);
  const strokes = raw.map((stroke, index) => {
    if (!stroke || typeof stroke !== 'object' || Array.isArray(stroke)) {
      throw new Error('Sketch stroke ' + (index + 1) + ' must be an object. Nothing was drawn.');
    }
    const points = normalizePoints(stroke.points || stroke.path, 'Sketch stroke ' + (index + 1));
    const width = number(stroke.width === undefined ? defaultWidth : stroke.width, defaultWidth, 0.25, 4000);
    const pressure = stroke.pressure === undefined ? spec.pressure : stroke.pressure;
    let weights = null;
    if (Array.isArray(pressure)) {
      weights = pressure
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => clamp(value, 0, 1));
      if (weights.length < 2) weights = null;
    } else if (pressure === true) {
      weights = 'profile';
    }
    return {
      points: points,
      width: width,
      color: stroke.color || defaultColor,
      opacity: number(stroke.opacity, defaultOpacity, 0, 1),
      smooth: stroke.smooth !== false,
      closed: stroke.closed === true,
      weights: weights,
    };
  });
  return expandSymmetry(strokes, spec.symmetry);
}

function pressureAt(weights, t, count) {
  if (weights === 'profile') {
    // A pen landing and lifting: fast taper in, long body, gentle taper out.
    return 0.22 + 0.78 * Math.sin(Math.PI * Math.pow(t, 0.82));
  }
  if (!Array.isArray(weights)) return 1;
  if (weights.length === 1) return weights[0];
  const scaled = t * (weights.length - 1);
  const index = Math.min(weights.length - 2, Math.floor(scaled));
  const remainder = scaled - index;
  return weights[index] + (weights[index + 1] - weights[index]) * remainder;
}

/**
 * GIMP-style symmetry, applied after the stroke list is normalized.
 *
 * The copies are generated here rather than in the SVG so bounds, pointer
 * feedback and the rasteriser all see the same strokes. A mirror is a point
 * transform, not a second command: one sketch call remains one undo entry.
 */
function symmetrySpec(value) {
  if (value === undefined || value === null || value === '' || value === false) return null;
  const raw = typeof value === 'string' ? { mode: value } : value;
  if (!raw || typeof raw !== 'object') {
    throw new Error('sketch.symmetry must be "horizontal", "vertical", "quad" or "radial".');
  }
  const mode = String(raw.mode || raw.type || '').toLowerCase();
  if (mode === 'none' || mode === 'off') return null;
  if (!['horizontal', 'vertical', 'quad', 'radial'].includes(mode)) {
    throw new Error('sketch.symmetry must be "horizontal", "vertical", "quad" or "radial".');
  }
  return {
    mode: mode,
    axisX: raw.axisX === undefined ? NaN : Number(raw.axisX),
    axisY: raw.axisY === undefined ? NaN : Number(raw.axisY),
    segments:
      mode === 'radial' ? Math.round(number(raw.segments, 6, 2, 16)) : 1,
  };
}

function transformedStroke(stroke, transform) {
  return {
    points: stroke.points.map(transform),
    width: stroke.width,
    color: stroke.color,
    opacity: stroke.opacity,
    smooth: stroke.smooth,
    closed: stroke.closed,
    weights: stroke.weights,
  };
}

function expandSymmetry(strokes, value) {
  const spec = symmetrySpec(value);
  if (!spec) return strokes;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      minX = Math.min(minX, point[0]);
      minY = Math.min(minY, point[1]);
      maxX = Math.max(maxX, point[0]);
      maxY = Math.max(maxY, point[1]);
    }
  }
  const axisX = Number.isFinite(spec.axisX) ? spec.axisX : (minX + maxX) / 2;
  const axisY = Number.isFinite(spec.axisY) ? spec.axisY : (minY + maxY) / 2;
  const mirrorX = (point) => [axisX * 2 - point[0], point[1]];
  const mirrorY = (point) => [point[0], axisY * 2 - point[1]];
  const both = (point) => [axisX * 2 - point[0], axisY * 2 - point[1]];
  const copies = [];
  const add = (transform) => {
    for (const stroke of strokes) copies.push(transformedStroke(stroke, transform));
  };
  add((point) => point);
  if (spec.mode === 'horizontal' || spec.mode === 'quad') add(mirrorX);
  if (spec.mode === 'vertical' || spec.mode === 'quad') add(mirrorY);
  if (spec.mode === 'quad') add(both);
  if (spec.mode === 'radial') {
    for (let index = 1; index < spec.segments; index += 1) {
      const angle = (Math.PI * 2 * index) / spec.segments;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      add((point) => {
        const dx = point[0] - axisX;
        const dy = point[1] - axisY;
        return [axisX + dx * cos - dy * sin, axisY + dx * sin + dy * cos];
      });
    }
  }
  if (copies.length > 256) {
    throw new Error('sketch.symmetry would create more than 256 strokes. Use fewer input strokes or segments.');
  }
  return copies;
}

function sketchElement(stroke, index) {
  const opacity = number(stroke.opacity, 1, 0, 1);
  if (!stroke.weights) {
    return `<path d="${smoothPath(stroke.points, stroke.closed)}" fill="none" stroke="${normalizeColor(
      stroke.color,
      '#ffffff'
    )}" stroke-width="${round(stroke.width)}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round" />`;
  }
  const points = stroke.points;
  const total = Math.max(1, points.length - 1);
  const pieces = [];
  // Each segment is a round-capped stub. More samples than this stop adding
  // visible smoothness and start adding file size to every preview.
  const stride = Math.max(1, Math.ceil(total / 160));
  for (let i = 0; i < total; i += stride) {
    const from = points[i];
    const to = points[Math.min(points.length - 1, i + stride)];
    const t = (i + stride / 2) / total;
    const width = Math.max(0.25, stroke.width * pressureAt(stroke.weights, t, total));
    pieces.push(
      `<path d="M ${round(from[0])} ${round(from[1])} L ${round(to[0])} ${round(to[1])}" ` +
        `fill="none" stroke="${normalizeColor(stroke.color, '#ffffff')}" stroke-width="${round(
          width
        )}" stroke-opacity="${opacity}" stroke-linecap="round" />`
    );
  }
  return `<g data-sketch-stroke="${index}">${pieces.join('')}</g>`;
}

function strokeAttributes(spec) {
  // A rectangle's `width` is its body, not its outline; only a brush stroke
  // reads its width as the stroke's. `strokeWidth` always wins when present.
  const width = number(
    spec.strokeWidth !== undefined ? spec.strokeWidth : spec.width,
    4,
    0.25,
    4000
  );
  const color = normalizeColor(spec.color || spec.stroke, '#ffffff');
  const opacity = number(spec.opacity, 1, 0, 1);
  const style = String(spec.style || spec.lineStyle || 'solid').toLowerCase();
  const cap = String(spec.cap || 'round');
  const join = String(spec.join || 'round');
  const dash = dashArray(style, width);
  return [
    `stroke="${color}"`,
    `stroke-width="${round(width)}"`,
    `stroke-opacity="${opacity}"`,
    `stroke-linecap="${cap === 'butt' || cap === 'square' ? cap : 'round'}"`,
    `stroke-linejoin="${join === 'miter' || join === 'bevel' ? join : 'round'}"`,
    ...(dash ? [`stroke-dasharray="${dash}"`] : []),
  ].join(' ');
}

function fillAttributes(spec) {
  const fill = spec.fill === undefined || spec.fill === null ? null : normalizeColor(spec.fill, 'none');
  if (!fill || fill === 'none') return 'fill="none"';
  const opacity = number(spec.fillOpacity, 1, 0, 1);
  return `fill="${fill}" fill-opacity="${opacity}"`;
}

/** The rectangle a gradient paints, explicit or implied by its endpoints. */
function gradientRect(spec) {
  const rect = spec.rect && typeof spec.rect === 'object' ? spec.rect : {};
  const explicit = {
    x: number(rect.x !== undefined ? rect.x : spec.x, NaN),
    y: number(rect.y !== undefined ? rect.y : spec.y, NaN),
    width: number(rect.width !== undefined ? rect.width : spec.width, NaN, 1, 1e6),
    height: number(rect.height !== undefined ? rect.height : spec.height, NaN, 1, 1e6),
  };
  if (
    Number.isFinite(explicit.x) &&
    Number.isFinite(explicit.y) &&
    Number.isFinite(explicit.width) &&
    Number.isFinite(explicit.height)
  ) {
    return explicit;
  }
  const from = pointPair(spec.from || spec.start);
  const to = pointPair(spec.to || spec.end);
  if (!from || !to) {
    throw new Error(
      'A gradient needs a rect (or x/y/width/height), or `from` and `to` points. Nothing was drawn.'
    );
  }
  const x = Math.min(from[0], to[0]);
  const y = Math.min(from[1], to[1]);
  return {
    x: x,
    y: y,
    width: Math.max(1, Math.abs(to[0] - from[0])),
    height: Math.max(1, Math.abs(to[1] - from[1])),
  };
}

function gradientPalette(spec) {
  const raw = Array.isArray(spec.stops) ? spec.stops : null;
  if (raw && raw.length) {
    if (raw.length > 16) {
      throw new Error('A gradient takes at most 16 stops. Nothing was drawn.');
    }
    const stops = raw.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error('Gradient stop ' + (index + 1) + ' must be an object.');
      }
      return {
        offset: number(entry.offset, index / Math.max(1, raw.length - 1), 0, 1),
        color: normalizeColor(entry.color, '#000000'),
        opacity: number(entry.opacity, 1, 0, 1),
      };
    });
    stops.sort((a, b) => a.offset - b.offset);
    if (stops[0].offset > 0) stops.unshift({ offset: 0, color: stops[0].color, opacity: stops[0].opacity });
    if (stops[stops.length - 1].offset < 1) {
      const last = stops[stops.length - 1];
      stops.push({ offset: 1, color: last.color, opacity: last.opacity });
    }
    return stops;
  }
  const colors = Array.isArray(spec.colors) ? spec.colors : null;
  const start = normalizeColor(colors && colors[0] !== undefined ? colors[0] : spec.fromColor || spec.color, '#000000');
  const end = normalizeColor(colors && colors[1] !== undefined ? colors[1] : spec.toColor, '#ffffff');
  return [
    { offset: 0, color: start, opacity: 1 },
    { offset: 1, color: end, opacity: 1 },
  ];
}

function gradientShape(spec, index) {
  const type = String(spec.shape || spec.gradient || 'linear').toLowerCase();
  if (type !== 'linear' && type !== 'radial') {
    throw new Error('gradient.shape must be "linear" or "radial". Nothing was drawn.');
  }
  const rect = gradientRect(spec);
  const palette = gradientPalette(spec);
  const opacity = number(spec.opacity, 1, 0, 1);
  const id = 'pn-gradient-' + index;
  let geometry;
  if (type === 'radial') {
    const center = pointPair(spec.from || spec.start) || [
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    ];
    const edge = pointPair(spec.to || spec.end);
    const radius = edge
      ? Math.max(1, Math.hypot(edge[0] - center[0], edge[1] - center[1]))
      : Math.max(1, Math.min(rect.width, rect.height) / 2);
    geometry =
      `cx="${round(center[0])}" cy="${round(center[1])}" r="${round(radius)}"`;
  } else {
    const from = pointPair(spec.from || spec.start) || [
      rect.x,
      rect.y + rect.height / 2,
    ];
    let to = pointPair(spec.to || spec.end) || [
      rect.x + rect.width,
      rect.y + rect.height / 2,
    ];
    if (from[0] === to[0] && from[1] === to[1]) {
      to = [from[0] + 1, from[1]];
    }
    geometry =
      `x1="${round(from[0])}" y1="${round(from[1])}" x2="${round(to[0])}" y2="${round(
        to[1]
      )}"`;
  }
  const stops = palette
    .map((stop) => {
      const color = stop.color === 'none' ? 'rgba(0,0,0,0)' : stop.color;
      const stopOpacity = round(stop.opacity);
      return `<stop offset="${round(stop.offset)}" stop-color="${color}" stop-opacity="${stopOpacity}" />`;
    })
    .join('');
  const gradient =
    type === 'radial'
      ? `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" ${geometry}>${stops}</radialGradient>`
      : `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" ${geometry}>${stops}</linearGradient>`;
  return (
    `<defs>${gradient}</defs>` +
    `<rect x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.width)}" height="${round(
      rect.height
    )}" fill="url(#${id})" opacity="${opacity}" />`
  );
}

function shapeOf(command, index) {
  const spec = command || {};
  const type = String(spec.type || '').toLowerCase();
  const opacity = number(spec.opacity, 1, 0, 1);
  const group = [`opacity="${opacity}"`];

  if (type === 'sketch') {
    return `<g ${group.join(' ')}>${sketchStrokes(spec)
      .map((stroke, index) => sketchElement(stroke, index))
      .join('')}</g>`;
  }

  if (type === 'gradient') {
    return gradientShape(spec, index === undefined ? 0 : index);
  }

  if (type === 'stroke' || type === 'brush' || type === 'freehand' || type === 'polyline') {
    const groups = pointGroups(spec, 'A stroke');
    const closed = spec.closed === true;
    const smooth = spec.smooth !== false;
    const d = groups
      .map((points) =>
        smooth ? smoothPath(points, closed) : linePath(points) + (closed ? ' Z' : '')
      )
      .join(' ');
    const fill = closed && spec.fill ? spec : null;
    return `<path d="${d}"${fill ? fillRuleAttribute(groups, spec) : ''} ${
      fill ? fillAttributes(fill) : 'fill="none"'
    } ${strokeAttributes(spec)} ${group.join(' ')} />`;
  }

  if (type === 'line') {
    const from = pointPair(spec.from || spec.start) || [
      number(spec.x1, 0),
      number(spec.y1, 0),
    ];
    const to = pointPair(spec.to || spec.end) || [number(spec.x2, 0), number(spec.y2, 0)];
    return `<path d="M ${round(from[0])} ${round(from[1])} L ${round(to[0])} ${round(
      to[1]
    )}" ${strokeAttributes(spec)} ${group.join(' ')} />`;
  }

  if (type === 'arrow') {
    const from = pointPair(spec.from || spec.start) || [0, 0];
    const to = pointPair(spec.to || spec.end) || [0, 0];
    const head = number(spec.headSize, number(spec.width, 4, 0.25, 4000) * 4, 1, 4000);
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const wing = Math.PI / 7;
    const left = [to[0] - head * Math.cos(angle - wing), to[1] - head * Math.sin(angle - wing)];
    const right = [to[0] - head * Math.cos(angle + wing), to[1] - head * Math.sin(angle + wing)];
    const headPath = `M ${round(left[0])} ${round(left[1])} L ${round(to[0])} ${round(
      to[1]
    )} L ${round(right[0])} ${round(right[1])}`;
    return `<g ${group.join(' ')}><path d="M ${round(from[0])} ${round(from[1])} L ${round(
      to[0]
    )} ${round(to[1])}" ${strokeAttributes(spec)} /><path d="${headPath}" ${strokeAttributes(
      spec
    )} fill="none" /></g>`;
  }

  if (type === 'rect' || type === 'rectangle') {
    const rect = spec.rect && typeof spec.rect === 'object' ? spec.rect : {};
    const x = number(rect.x !== undefined ? rect.x : spec.x, 0);
    const y = number(rect.y !== undefined ? rect.y : spec.y, 0);
    const width = number(rect.width !== undefined ? rect.width : spec.width, 0, 0.01, 1e6);
    const height = number(rect.height !== undefined ? rect.height : spec.height, 0, 0.01, 1e6);
    const radius = number(spec.radius, 0, 0, 1e5);
    return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(
      height
    )}" rx="${round(radius)}" ${fillAttributes(spec)} ${
      spec.stroke === undefined && spec.strokeWidth === undefined ? '' : strokeAttributes(spec)
    } ${group.join(' ')} />`;
  }

  if (type === 'ellipse' || type === 'circle') {
    const cx = number(spec.cx, NaN);
    const cy = number(spec.cy, NaN);
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      const rx = number(spec.rx, type === 'circle' ? spec.r : 0, 0.01, 1e6);
      const ry = number(spec.ry, type === 'circle' ? spec.r : rx, 0.01, 1e6);
      return `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(rx)}" ry="${round(
        ry
      )}" ${fillAttributes(spec)} ${
        spec.stroke === undefined && spec.strokeWidth === undefined ? '' : strokeAttributes(spec)
      } ${group.join(' ')} />`;
    }
    const rect = spec.rect && typeof spec.rect === 'object' ? spec.rect : {};
    const x = number(rect.x !== undefined ? rect.x : spec.x, 0);
    const y = number(rect.y !== undefined ? rect.y : spec.y, 0);
    const width = number(rect.width !== undefined ? rect.width : spec.width, 1, 0.01, 1e6);
    const height = number(rect.height !== undefined ? rect.height : spec.height, 1, 0.01, 1e6);
    return `<ellipse cx="${round(x + width / 2)}" cy="${round(y + height / 2)}" rx="${round(
      width / 2
    )}" ry="${round(height / 2)}" ${fillAttributes(spec)} ${
      spec.stroke === undefined && spec.strokeWidth === undefined ? '' : strokeAttributes(spec)
    } ${group.join(' ')} />`;
  }

  if (type === 'polygon' || type === 'compound') {
    const groups = pointGroups(spec, 'A polygon');
    const d = groups
      .map(
        (points) =>
          `M ${points.map((point) => `${round(point[0])} ${round(point[1])}`).join(' L ')} Z`
      )
      .join(' ');
    return `<path d="${d}"${fillRuleAttribute(groups, spec)} ${fillAttributes(spec)} ${
      spec.stroke === undefined && spec.strokeWidth === undefined ? '' : strokeAttributes(spec)
    } ${group.join(' ')} />`;
  }

  if (type === 'text') {
    const text = String(spec.text === undefined ? '' : spec.text);
    if (!text.trim()) throw new Error('A text command needs non-empty `text`. Nothing was drawn.');
    const x = number(spec.x, 0);
    const y = number(spec.y, 0);
    const size = number(spec.size, 32, 1, 4000);
    const weight = number(spec.weight, 400, 100, 900);
    const anchor = String(spec.align || spec.anchor || 'left');
    const letterSpacing = number(spec.letterSpacing, 0, -100, 400);
    const rotation = number(spec.rotation, 0, -360, 360);
    const transform = rotation ? ` transform="rotate(${rotation} ${round(x)} ${round(y)})"` : '';
    const lines = text.split(/\r?\n/);
    const lineHeight = number(spec.lineHeight, size * 1.25, 1, 1e6);
    const spans = lines
      .map(
        (line, index) =>
          `<tspan x="${round(x)}" y="${round(y + index * lineHeight)}">${escapeXml(line)}</tspan>`
      )
      .join('');
    return `<text${transform} text-anchor="${
      anchor === 'center' || anchor === 'end' ? anchor : 'start'
    }" font-family="${escapeXml(spec.font || DEFAULT_FONT)}" font-size="${round(
      size
    )}" font-weight="${round(weight)}" ${spec.italic === true ? 'font-style="italic"' : ''} ${
      letterSpacing ? `letter-spacing="${round(letterSpacing)}"` : ''
    } fill="${normalizeColor(spec.color || spec.fill, '#ffffff')}" fill-opacity="${number(
      spec.opacity,
      1,
      0,
      1
    )}">${spans}</text>`;
  }

  throw new Error(
    'Unknown draw command "' +
      (type || '(missing type)') +
      '". Use stroke, sketch, line, arrow, rect, ellipse, polygon, compound, gradient or text.'
  );
}

function commandLabel(command) {
  const type = String((command && command.type) || '').toLowerCase();
  if (type === 'sketch') {
    const strokes = Array.isArray(command.strokes) ? command.strokes.length : 0;
    return strokes === 1 ? 'sketch stroke' : 'sketch (' + strokes + ' strokes)';
  }
  if (type === 'stroke' || type === 'brush' || type === 'freehand' || type === 'polyline')
    return 'brush stroke';
  if (type === 'text') return 'text';
  if (type === 'clone') return 'clone stamp';
  if (type === 'fill') return 'bucket fill';
  if (type === 'gradient') return 'gradient';
  if (type === 'arrow') return 'arrow';
  if (type === 'line') return 'line';
  if (type === 'rect' || type === 'rectangle') return 'rectangle';
  if (type === 'ellipse' || type === 'circle') return 'ellipse';
  if (type === 'compound' || (type === 'polygon' && Array.isArray(command.paths))) {
    return 'compound shape';
  }
  if (type === 'polygon') return 'polygon';
  return type || 'mark';
}

function normalizeCommands(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('photo_draw needs a non-empty `commands` array. Nothing was drawn.');
  }
  if (raw.length > MAX_COMMANDS) {
    throw new Error(
      'photo_draw takes at most ' + MAX_COMMANDS + ' commands per call. Nothing was drawn.'
    );
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each draw command must be an object. Nothing was drawn.');
    }
    return entry;
  });
}

function summary(commands) {
  const counts = new Map();
  for (const command of commands) {
    const label = commandLabel(command);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => (count === 1 ? 'a ' + label : count + ' ' + label + 's'))
    .join(' + ');
}

/** Axis-aligned bounds of every command, with room for the stroke and glyphs. */
function boundsOf(commands) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x, y, pad) => {
    const extra = pad || 0;
    minX = Math.min(minX, x - extra);
    minY = Math.min(minY, y - extra);
    maxX = Math.max(maxX, x + extra);
    maxY = Math.max(maxY, y + extra);
  };

  for (const command of commands) {
    const type = String(command.type || '').toLowerCase();
    if (type === 'clone') {
      const groups = clonePointGroups(command);
      const pad = number(command.width, 48, 0.25, 4000) / 2 + 2;
      for (const points of groups) for (const point of points) include(point[0], point[1], pad);
    } else if (type === 'sketch') {
      for (const stroke of sketchStrokes(command)) {
        const pad = stroke.width / 2 + 2;
        for (const point of stroke.points) include(point[0], point[1], pad);
      }
    } else if (type === 'fill') {
      include(number(command.x, 0), number(command.y, 0), 1);
    } else if (type === 'gradient') {
      const rect = gradientRect(command);
      include(rect.x, rect.y);
      include(rect.x + rect.width, rect.y + rect.height);
    } else if (type === 'stroke' || type === 'brush' || type === 'freehand' || type === 'polyline') {
      const groups = pointGroups(command, 'A stroke');
      const pad = number(command.width, 4, 0.25, 4000) / 2 + 2;
      for (const points of groups) for (const point of points) include(point[0], point[1], pad);
    } else if (type === 'line' || type === 'arrow') {
      const from = pointPair(command.from || command.start) || [
        number(command.x1, 0),
        number(command.y1, 0),
      ];
      const to = pointPair(command.to || command.end) || [
        number(command.x2, 0),
        number(command.y2, 0),
      ];
      const pad =
        Math.max(
          number(command.width, 4, 0.25, 4000),
          number(command.headSize, 0, 0, 4000) * (type === 'arrow' ? 1 : 0)
        ) / 2 + 2;
      include(from[0], from[1], pad);
      include(to[0], to[1], pad);
    } else if (type === 'rect' || type === 'rectangle' || type === 'ellipse' || type === 'circle') {
      const rect = command.rect && typeof command.rect === 'object' ? command.rect : {};
      let x;
      let y;
      let width;
      let height;
      if (Number.isFinite(Number(command.cx)) && Number.isFinite(Number(command.cy)) && type !== 'rect') {
        const rx = number(command.rx, type === 'circle' ? command.r : 0, 0.01, 1e6);
        const ry = number(command.ry, type === 'circle' ? command.r : rx, 0.01, 1e6);
        x = Number(command.cx) - rx;
        y = Number(command.cy) - ry;
        width = rx * 2;
        height = ry * 2;
      } else {
        x = number(rect.x !== undefined ? rect.x : command.x, 0);
        y = number(rect.y !== undefined ? rect.y : command.y, 0);
        width = number(rect.width !== undefined ? rect.width : command.width, 0, 0.01, 1e6);
        height = number(rect.height !== undefined ? rect.height : command.height, 0, 0.01, 1e6);
      }
      const pad = number(command.strokeWidth, 0, 0, 4000) / 2 + 2;
      include(x, y, pad);
      include(x + width, y + height, pad);
    } else if (type === 'polygon' || type === 'compound') {
      const groups = pointGroups(command, 'A polygon');
      const pad = number(command.strokeWidth, 0, 0, 4000) / 2 + 2;
      for (const points of groups) for (const point of points) include(point[0], point[1], pad);
    } else if (type === 'text') {
      const text = String(command.text || '');
      if (!text.trim()) throw new Error('A text command needs non-empty `text`.');
      const size = number(command.size, 32, 1, 4000);
      const lines = text.split(/\r?\n/);
      const lineHeight = number(command.lineHeight, size * 1.25, 1, 1e6);
      const x = number(command.x, 0);
      const y = number(command.y, 0);
      const anchor = String(command.align || command.anchor || 'left');
      // Without a font metrics pass, estimate generously; a clipped glyph is a
      // worse failure than a few transparent pixels.
      const widest = lines.reduce((width, line) => Math.max(width, line.length), 0);
      const estimated = widest * size * 0.62;
      const left = anchor === 'center' ? x - estimated / 2 : anchor === 'end' ? x - estimated : x;
      include(left, y - size * 1.1, size * 0.2);
      include(left + estimated, y + lineHeight * (lines.length - 1) + size * 0.35, size * 0.2);
    } else {
      throw new Error(
        'Unknown draw command "' + (type || '(missing type)') + '". Nothing was drawn.'
      );
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    throw new Error('The draw commands have no drawable area. Nothing was drawn.');
  }
  const x = Math.floor(minX);
  const y = Math.floor(minY);
  const width = Math.max(1, Math.ceil(maxX) - x);
  const height = Math.max(1, Math.ceil(maxY) - y);
  return { x: x, y: y, width: width, height: height };
}

/**
 * One SVG document for the commands, translated so `bounds` starts at (0,0).
 * The caller rasterises it at exactly the bounds' size.
 */
function buildSvg(bounds, commands) {
  const body = commands.map((command, index) => shapeOf(command, index)).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" ` +
    `viewBox="0 0 ${bounds.width} ${bounds.height}">` +
    `<g transform="translate(${round(-bounds.x)} ${round(-bounds.y)})">${body}</g>` +
    `</svg>`
  );
}

function rectPathPoints(command) {
  const rect = command.rect && typeof command.rect === 'object' ? command.rect : {};
  const x = number(rect.x !== undefined ? rect.x : command.x, 0);
  const y = number(rect.y !== undefined ? rect.y : command.y, 0);
  const width = number(rect.width !== undefined ? rect.width : command.width, 0, 0.01, 1e6);
  const height = number(rect.height !== undefined ? rect.height : command.height, 0, 0.01, 1e6);
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
    [x, y],
  ];
}

function ellipsePathPoints(command) {
  let cx = Number(command.cx);
  let cy = Number(command.cy);
  let rx = Number(command.rx);
  let ry = Number(command.ry);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    const rect = command.rect && typeof command.rect === 'object' ? command.rect : {};
    const x = number(rect.x !== undefined ? rect.x : command.x, 0);
    const y = number(rect.y !== undefined ? rect.y : command.y, 0);
    const width = number(rect.width !== undefined ? rect.width : command.width, 1, 0.01, 1e6);
    const height = number(rect.height !== undefined ? rect.height : command.height, 1, 0.01, 1e6);
    cx = x + width / 2;
    cy = y + height / 2;
    rx = width / 2;
    ry = height / 2;
  }
  const radiusX = number(rx, Number(command.r) || 0.01, 0.01, 1e6);
  const radiusY = number(ry, Number(command.r) || radiusX, 0.01, 1e6);
  const points = [];
  for (let step = 0; step < 64; step += 1) {
    const angle = (step / 64) * Math.PI * 2;
    points.push([cx + Math.cos(angle) * radiusX, cy + Math.sin(angle) * radiusY]);
  }
  points.push(points[0]);
  return points;
}

function pointerPoints(points) {
  if (points.length <= 200) return points;
  return Array.from({ length: 200 }, (_, index) =>
    points[Math.round((index * (points.length - 1)) / 199)]
  );
}

function pointerSegmentsOf(command) {
  const type = String(command.type || '').toLowerCase();
  if (type === 'sketch') {
    const strokes = sketchStrokes(command);
    let radius = 0;
    const segments = [];
    for (const stroke of strokes) {
      radius = Math.max(radius, stroke.width / 2);
      const points = pointerPoints(stroke.points);
      if (stroke.closed && points.length > 1) points.push(points[0]);
      const weights = stroke.weights;
      segments.push({
        points: points,
        smooth: stroke.smooth,
        pressure:
          weights === 'profile'
            ? points.map((_, index) =>
                Number(pressureAt('profile', index / Math.max(1, points.length - 1)).toFixed(3))
              )
            : Array.isArray(weights)
              ? points.map((_, index) =>
                  Number(pressureAt(weights, index / Math.max(1, points.length - 1)).toFixed(3))
                )
              : null,
      });
    }
    return { kind: 'brush', mode: 'stroke', radius: radius, segments: segments };
  }
  if (type === 'stroke' || type === 'brush' || type === 'freehand' || type === 'polyline') {
    return {
      kind: 'brush',
      radius: number(command.width, 4, 0.25, 4000) / 2,
      segments: pointGroups(command, 'A stroke').map((group) => {
        const points = pointerPoints(group);
        if (command.closed === true && points.length > 1) points.push(points[0]);
        return { points, smooth: command.smooth !== false };
      }),
    };
  }
  if (type === 'clone') {
    return {
      kind: 'brush',
      radius: number(command.width, 48, 0.25, 4000) / 2,
      segments: clonePointGroups(command).map((group) => ({
        points: pointerPoints(group),
        smooth: command.smooth !== false,
      })),
    };
  }
  if (type === 'text') {
    return {
      kind: 'type',
      radius: 0,
      segments: [{ points: [[number(command.x, 0), number(command.y, 0)]], smooth: false }],
    };
  }
  if (type === 'fill') {
    return {
      kind: 'shape',
      mode: 'click',
      radius: 0,
      segments: [{ points: [[number(command.x, 0), number(command.y, 0)]], smooth: false }],
    };
  }
  if (type === 'gradient') {
    const rect = gradientRect(command);
    const from = pointPair(command.from || command.start) || [
      rect.x,
      rect.y + rect.height / 2,
    ];
    const to = pointPair(command.to || command.end) || [
      rect.x + rect.width,
      rect.y + rect.height / 2,
    ];
    return { kind: 'shape', mode: 'drag', radius: 0, segments: [{ points: [from, to], smooth: false }] };
  }
  if (type === 'line' || type === 'arrow') {
    const from = pointPair(command.from || command.start) || [
      number(command.x1, 0),
      number(command.y1, 0),
    ];
    const to = pointPair(command.to || command.end) || [
      number(command.x2, 0),
      number(command.y2, 0),
    ];
    return { kind: 'line', radius: 0, segments: [{ points: [from, to], smooth: false }] };
  }
  if (type === 'rect' || type === 'rectangle') {
    return {
      kind: 'shape',
      mode: 'drag',
      radius: 0,
      segments: [{ points: rectPathPoints(command), smooth: false }],
    };
  }
  if (type === 'ellipse' || type === 'circle') {
    return {
      kind: 'shape',
      radius: 0,
      segments: [{ points: ellipsePathPoints(command), smooth: false }],
    };
  }
  if (type === 'polygon' || type === 'compound') {
    return {
      kind: 'shape',
      radius: 0,
      segments: pointGroups(command, 'A polygon').map((group) => {
        const points = pointerPoints(group);
        if (points.length > 1) points.push(points[0]);
        return { points, smooth: false };
      }),
    };
  }
  return null;
}

/** What the panel's simulated pointer follows, in canvas coordinates. */
function pointerOf(commands) {
  const segments = [];
  let last = null;
  for (const command of commands) {
    const piece = pointerSegmentsOf(command);
    if (!piece || !piece.segments.length) continue;
    segments.push(...piece.segments);
    last = piece;
  }
  if (!segments.length) {
    return {
      kind: 'shape',
      mode: 'drag',
      path: [[0, 0]],
      segments: [],
      radius: 0,
      label: summary(commands),
    };
  }
  const path = segments.reduce((all, segment) => all.concat(segment.points), []);
  return {
    kind: last.kind,
    mode: last.mode || (last.kind === 'brush' ? 'stroke' : last.kind === 'type' ? 'type' : 'drag'),
    path: path,
    segments: segments,
    radius: last.radius,
    label: commands.length === 1 ? commandLabel(commands[0]) : 'drawing',
  };
}

module.exports = {
  MAX_COMMANDS: MAX_COMMANDS,
  boundsOf: boundsOf,
  buildSvg: buildSvg,
  colorChannels: colorChannels,
  normalizeCommands: normalizeCommands,
  pointerOf: pointerOf,
  summary: summary,
};
