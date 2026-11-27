/*
 * Where the agent is working, for the panel's simulated pointer.
 *
 * Tools already know their geometry: a crop is a rectangle, a wand is a seed, a
 * brush stroke is a path. This module reads that geometry back out of the tool's
 * arguments so the panel can show a cursor arriving at the edit instead of a
 * spinner. It never changes document state and never throws: a pointer is
 * decoration, and a malformed argument is already the tool's problem to report.
 */
'use strict';

const draw = require('./draw.cjs');

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pointOf(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = finite(value[0]);
  const y = finite(value[1]);
  return x === null || y === null ? null : [x, y];
}

function rectPath(rect, canvas) {
  if (!rect || typeof rect !== 'object') return null;
  const x = finite(rect.x);
  const y = finite(rect.y);
  const width = finite(rect.width);
  const height = finite(rect.height);
  if (x === null || y === null || width === null || height === null) return null;
  const path = [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
  return canvas ? clampPath(path, canvas) : path;
}

function ellipsePath(ellipse) {
  if (!ellipse || typeof ellipse !== 'object') return null;
  const cx = finite(ellipse.cx);
  const cy = finite(ellipse.cy);
  const rx = finite(ellipse.rx);
  const ry = finite(ellipse.ry);
  if (cx === null || cy === null || rx === null || ry === null) return null;
  const path = [];
  for (let step = 0; step < 48; step += 1) {
    const angle = (step / 48) * Math.PI * 2;
    path.push([cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry]);
  }
  return path;
}

function clampPath(path, canvas) {
  const width = canvas && canvas.width ? canvas.width : Infinity;
  const height = canvas && canvas.height ? canvas.height : Infinity;
  return path.map((point) => [
    Math.min(width, Math.max(0, point[0])),
    Math.min(height, Math.max(0, point[1])),
  ]);
}

function centerOf(path) {
  if (!path || !path.length) return null;
  let x = 0;
  let y = 0;
  for (const point of path) {
    x += point[0];
    y += point[1];
  }
  return [x / path.length, y / path.length];
}

function selectionPath(document) {
  const selection = document && document.selection;
  if (!selection) return null;
  if (selection.bounds) {
    return rectPath(selection.bounds, document.canvas);
  }
  return null;
}

function clampRegion(rect, canvas) {
  if (!rect || typeof rect !== 'object') return null;
  const x = finite(rect.x);
  const y = finite(rect.y);
  const width = finite(rect.width);
  const height = finite(rect.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  const canvasWidth = canvas && canvas.width ? canvas.width : x + width;
  const canvasHeight = canvas && canvas.height ? canvas.height : y + height;
  const left = Math.max(0, Math.min(canvasWidth, x));
  const top = Math.max(0, Math.min(canvasHeight, y));
  const right = Math.max(left, Math.min(canvasWidth, x + width));
  const bottom = Math.max(top, Math.min(canvasHeight, y + height));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function layerRegion(document, value) {
  const layers = (document && document.layers) || [];
  const layer =
    value && value !== 'active'
      ? layers.find((candidate) => candidate.id === value)
      : layers.find((candidate) => candidate.active || candidate.id === document.activeLayerId);
  if (!layer) return null;
  if (layer.kind === 'adjustment') {
    if (layer.mask) {
      return clampRegion(
        { x: 0, y: 0, width: layer.mask.width, height: layer.mask.height },
        document.canvas
      );
    }
    return null;
  }
  if (layer.pixels) {
    return clampRegion(
      {
        x: layer.offset ? layer.offset.x : 0,
        y: layer.offset ? layer.offset.y : 0,
        width: layer.pixels.width,
        height: layer.pixels.height,
      },
      document.canvas
    );
  }
  return null;
}

function pointGroups(value) {
  const raw = Array.isArray(value.paths) ? value.paths : [value.points || value.path];
  return raw
    .map((group) =>
      (Array.isArray(group) ? group : [])
        .map((point) => pointOf(point))
        .filter(Boolean)
    )
    .filter((group) => group.length > 0);
}

function describe(tool, args, document) {
  const canvas = document && document.canvas ? document.canvas : null;
  const input = args && typeof args === 'object' ? args : {};
  try {
    if (tool === 'photo_draw') {
      const commands = draw.normalizeCommands(input.commands);
      const pointer = draw.pointerOf(commands);
      return {
        kind: pointer.kind,
        mode: pointer.mode || 'stroke',
        path: clampPath(pointer.path, canvas),
        segments: pointer.segments.map((segment) => ({
          points: clampPath(segment.points, canvas),
          smooth: segment.smooth,
          pressure: Array.isArray(segment.pressure) ? segment.pressure : null,
        })),
        radius: pointer.radius,
        label: pointer.label || draw.summary(commands),
      };
    }

    if (tool === 'photo_import') {
      const width = canvas ? canvas.width : 0;
      const height = canvas ? canvas.height : 0;
      return {
        kind: 'image',
        mode: 'image',
        path: [
          [width * 0.12, height * 0.18],
          [width * 0.5, height * 0.5],
        ],
        label: 'import',
      };
    }

    if (tool === 'photo_edit') {
      if (input.crop) {
        return {
          kind: 'crop',
          mode: 'marquee',
          path: rectPath(input.crop, canvas),
          region: clampRegion(input.crop, canvas),
          label: 'crop',
        };
      }
      if (input.perspective && Array.isArray(input.perspective.corners)) {
        const path = input.perspective.corners.map(pointOf).filter(Boolean);
        if (path.length) {
          return {
            kind: 'transform',
            mode: 'transform',
            path: clampPath(path, canvas),
            label: 'perspective',
          };
        }
      }
      if (input.rotate !== undefined) {
        const path = selectionPath(document) || rectPath({ x: 0, y: 0, width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 });
        return { kind: 'rotate', mode: 'rotate', path: path, label: 'rotate ' + Number(input.rotate) + '°' };
      }
      if (input.skew) {
        const path = rectPath({ x: 0, y: 0, width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 });
        return { kind: 'transform', mode: 'transform', path: path, label: 'skew' };
      }
      const center = selectionPath(document) || [[canvas ? canvas.width / 2 : 0, canvas ? canvas.height / 2 : 0]];
      return {
        kind: 'move',
        mode: 'move',
        path: center,
        label: input.flip ? 'flip ' + input.flip : 'transform',
      };
    }

    if (tool === 'photo_adjust') {
      const target = input.target && typeof input.target === 'object' ? input.target : {};
      let region = null;
      if (target.selection && document && document.selection && document.selection.bounds) {
        region = clampRegion(document.selection.bounds, canvas);
      } else if (target.layer && target.layer !== 'all') {
        region = layerRegion(document, target.layer);
      } else if (target.layer === 'all') {
        region = clampRegion(
          { x: 0, y: 0, width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 },
          canvas
        );
      } else {
        region = layerRegion(document, 'active');
      }
      if (!region) {
        region = clampRegion(
          { x: 0, y: 0, width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 },
          canvas
        );
      }
      const center = region
        ? [region.x + region.width / 2, region.y + region.height / 2]
        : [canvas ? canvas.width / 2 : 0, canvas ? canvas.height / 2 : 0];
      return {
        kind: 'adjust',
        mode: 'adjust',
        path: [center],
        radius: 90,
        label: 'adjustment',
        region: region,
      };
    }

    if (tool === 'photo_select') {
      const action = String(input.action || '');
      if (action === 'rect' && input.rect) {
        return {
          kind: 'marquee',
          mode: 'marquee',
          path: rectPath(input.rect, canvas),
          region: clampRegion(input.rect, canvas),
          label: 'rect selection',
        };
      }
      if (action === 'ellipse' && input.ellipse) {
        return {
          kind: 'marquee',
          mode: 'marquee',
          path: ellipsePath(input.ellipse),
          label: 'ellipse selection',
        };
      }
      if (action === 'polygon' && Array.isArray(input.points)) {
        const path = input.points.map(pointOf).filter(Boolean);
        if (path.length) {
          return {
            kind: 'lasso',
            mode: 'lasso',
            path: clampPath(path, canvas),
            label: 'polygon selection',
          };
        }
      }
      if (action === 'wand' && finite(input.x) !== null) {
        return {
          kind: 'wand',
          mode: 'wand',
          path: [[finite(input.x), finite(input.y) || 0]],
          label: 'magic wand',
        };
      }
      if (action === 'colorRange' && input.sample) {
        const seed = pointOf([input.sample.x, input.sample.y]);
        if (seed) return { kind: 'wand', mode: 'wand', path: [seed], label: 'colour range' };
      }
      const center = centerOf(selectionPath(document)) || [canvas ? canvas.width / 2 : 0, canvas ? canvas.height / 2 : 0];
      return { kind: 'marquee', mode: 'marquee', path: [center], label: 'selection' };
    }

    if (tool === 'photo_mask') {
      const action = String(input.action || '');
      if (action === 'paint' && (Array.isArray(input.points) || Array.isArray(input.paths))) {
        const groups = pointGroups(input);
        if (groups.length) {
          const radius = Math.max(0.5, Number(input.width || 32) / 2);
          return {
            kind: 'brush',
            mode: 'stroke',
            path: clampPath(groups.reduce((all, group) => all.concat(group), []), canvas),
            segments: groups.map((group) => ({
              points: clampPath(group, canvas),
              smooth: input.smooth === true,
            })),
            radius: radius,
            label: 'mask brush',
          };
        }
      }
      if (action === 'paint' && input.shape === 'ellipse' && input.ellipse) {
        return {
          kind: 'brush',
          mode: 'stroke',
          path: clampPath(ellipsePath(input.ellipse), canvas),
          radius: 0,
          label: 'mask ellipse',
        };
      }
      if (action === 'paint' && (input.shape === 'rect' || input.rect)) {
        const rect = input.rect || { x: input.x, y: input.y, width: input.width, height: input.height };
        return {
          kind: 'brush',
          mode: 'stroke',
          path: rectPath(rect, canvas),
          radius: 0,
          label: 'mask rectangle',
        };
      }
      const path = selectionPath(document);
      if (path) {
        return {
          kind: 'brush',
          mode: 'stroke',
          path: path,
          radius: 60,
          label: action === 'create' ? 'mask from selection' : 'mask',
        };
      }
      const region = layerRegion(document, input.target && input.target.layer);
      const center = region
        ? [region.x + region.width / 2, region.y + region.height / 2]
        : [canvas ? canvas.width / 2 : 0, canvas ? canvas.height / 2 : 0];
      return { kind: 'brush', mode: 'stroke', path: [center], radius: 60, label: 'mask' };
    }

    if (tool === 'photo_layer') {
      const center = [canvas ? canvas.width / 2 : 0, canvas ? canvas.height / 2 : 0];
      return { kind: 'move', mode: 'move', path: [center], label: 'layer' };
    }

    if (tool === 'photo_3d') {
      const action = String(input.action || '');
      const region = clampRegion(
        { x: 0, y: 0, width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 },
        canvas
      );
      const center = region
        ? [region.x + region.width / 2, region.y + region.height / 2]
        : [canvas ? canvas.width / 2 : 0, canvas ? canvas.height / 2 : 0];
      return {
        kind: '3d',
        mode: 'orbit',
        path: region ? rectPath(region, canvas) : [center],
        region: action === 'render' ? region : null,
        label:
          action === 'import'
            ? 'import 3D model'
            : action === 'configure'
              ? 'configure 3D scene'
              : action === 'render'
                ? 'render 3D'
                : '3D scene',
      };
    }

    if (tool === 'photo_export') {
      const center = [canvas ? canvas.width * 0.5 : 0, canvas ? canvas.height * 0.5 : 0];
      return { kind: 'export', mode: 'export', path: [center], label: 'export' };
    }

    if (tool === 'photo_history') {
      const center = [canvas ? canvas.width / 2 : 0, canvas ? canvas.height / 2 : 0];
      return { kind: 'history', mode: 'history', path: [center], label: String(input.action || 'history') };
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = { describe: describe };
