/*
 * 3D text: configuration, mask layout and the native job contract.
 *
 * Text layout stays in Node because that is where fonts, custom fontconfig and
 * the rest of the draw pipeline already live. The native engine receives a
 * coverage mask, turns it into a distance field and renders the extrusion. That
 * split is deliberate: adding a font parser and a tessellator to C++ would have
 * bought nothing the mask does not already know, and would have lost the
 * fallback and letter-spacing behaviour `photo_draw` guarantees.
 */
'use strict';

const fontsModule = require('./fonts.cjs');
const render = require('./render.cjs');

const DEFAULTS = {
  font: 'sans-serif',
  weight: 700,
  italic: false,
  letterSpacing: 0,
  lineHeight: 1.1,
  depth: 0.32,
  bevel: 0.03,
  twist: 0,
  scale: 1,
  maskSize: 1600,
  camera: { fov: 35, yaw: 0, pitch: 8, zoom: 1 },
  light: { direction: [0.4, 0.8, 1], color: '#fff4e0', intensity: 1.6, fill: 0.35, rim: 0.3, ambient: 0.3 },
  material: {
    face: '#f5c542',
    side: '#8a5a12',
    bevel: '#ffe9a8',
    specular: 0.5,
    shininess: 48,
    mode: 'solid',
    gradient: false,
    faceTop: '#ffe08a',
    faceBottom: '#e09b1a',
  },
  shadow: { enabled: false, opacity: 0.22, distance: 0.2, softness: 0.7, color: '#000000' },
  background: { mode: 'transparent', color: '#101418', top: '#18202e', bottom: '#05070a' },
  render: { samples: 2, exposure: 1, steps: 160 },
};

const IGNORED = ['action', 'name', 'width', 'height'];

const ALLOWED = [
  'text',
  'font',
  'weight',
  'italic',
  'letterSpacing',
  'lineHeight',
  'depth',
  'bevel',
  'twist',
  'scale',
  'maskSize',
  'rotation',
  'position',
  'camera',
  'light',
  'material',
  'shadow',
  'background',
  'render',
];

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function numberIn(value, min, max, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(label + ' must be a number.');
  if (parsed < min || parsed > max) {
    throw new Error(label + ' must be between ' + min + ' and ' + max + '.');
  }
  return parsed;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be true or false.');
  return value;
}

function enumIn(value, allowed, label) {
  if (allowed.indexOf(value) === -1) {
    throw new Error(label + ' must be one of: ' + allowed.join(', ') + '.');
  }
  return value;
}

function hex(value, label) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value.trim())) {
    throw new Error(label + ' must be a #rrggbb or #rrggbbaa colour.');
  }
  return value.trim();
}

function vector(value, label) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(label + ' must be an [x, y, z] array.');
  }
  return value.map((component, index) =>
    numberIn(component, -100000, 100000, label + '[' + index + ']')
  );
}

function objectInput(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object.');
  }
  return value;
}

function unknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (allowed.indexOf(key) === -1) {
      throw new Error('Unknown ' + label + ' option "' + key + '". Use ' + allowed.join(', ') + '.');
    }
  }
}

function normalize(input) {
  const raw = objectInput(input || {}, 'text3d');
  for (const key of Object.keys(raw)) {
    if (IGNORED.indexOf(key) !== -1) continue;
    if (ALLOWED.indexOf(key) === -1) {
      throw new Error(
        'Unknown 3D text option "' + key + '". Use ' + ALLOWED.join(', ') + '. Nothing was changed.'
      );
    }
  }

  const text = String(raw.text === undefined ? '' : raw.text);
  if (!text.trim()) throw new Error('3D text needs non-empty `text`.');
  if (text.length > 400) throw new Error('3D text is limited to 400 characters.');
  const lines = text.split(/\r?\n/);
  if (lines.length > 6) throw new Error('3D text is limited to six lines.');

  const config = clone(DEFAULTS);
  config.text = text;
  if (raw.font !== undefined) config.font = String(raw.font);
  if (raw.weight !== undefined) config.weight = Math.round(numberIn(raw.weight, 100, 900, 'weight'));
  if (raw.italic !== undefined) config.italic = bool(raw.italic, 'italic');
  if (raw.letterSpacing !== undefined) {
    config.letterSpacing = numberIn(raw.letterSpacing, -100, 400, 'letterSpacing');
  }
  if (raw.lineHeight !== undefined) config.lineHeight = numberIn(raw.lineHeight, 0.5, 3, 'lineHeight');
  if (raw.depth !== undefined) config.depth = numberIn(raw.depth, 0, 2, 'depth');
  if (raw.bevel !== undefined) config.bevel = numberIn(raw.bevel, 0, 0.3, 'bevel');
  if (raw.twist !== undefined) config.twist = numberIn(raw.twist, -720, 720, 'twist');
  if (raw.scale !== undefined) config.scale = numberIn(raw.scale, 0.1, 10, 'scale');
  if (raw.maskSize !== undefined) {
    config.maskSize = Math.round(numberIn(raw.maskSize, 512, 2048, 'maskSize'));
  }

  config.rotation =
    raw.rotation === undefined ? [0, 0, 0] : vector(raw.rotation, 'rotation').map((value) => {
      if (value < -180 || value > 180) throw new Error('rotation values must be between -180 and 180.');
      return value;
    });
  config.position = raw.position === undefined ? [0, 0, 0] : vector(raw.position, 'position');

  if (raw.camera !== undefined) {
    const value = objectInput(raw.camera, 'camera');
    unknownKeys(value, ['fov', 'yaw', 'pitch', 'zoom'], 'camera');
    if (value.fov !== undefined) config.camera.fov = numberIn(value.fov, 10, 100, 'camera.fov');
    if (value.yaw !== undefined) config.camera.yaw = numberIn(value.yaw, -80, 80, 'camera.yaw');
    if (value.pitch !== undefined) config.camera.pitch = numberIn(value.pitch, -80, 80, 'camera.pitch');
    if (value.zoom !== undefined) config.camera.zoom = numberIn(value.zoom, 0.4, 3, 'camera.zoom');
  }

  if (raw.light !== undefined) {
    const value = objectInput(raw.light, 'light');
    unknownKeys(
      value,
      ['direction', 'color', 'intensity', 'fill', 'rim', 'ambient'],
      'light'
    );
    if (value.direction !== undefined) {
      const direction = vector(value.direction, 'light.direction');
      if (Math.hypot(direction[0], direction[1], direction[2]) < 1e-6) {
        throw new Error('light.direction cannot be the zero vector.');
      }
      config.light.direction = direction;
    }
    if (value.color !== undefined) config.light.color = hex(value.color, 'light.color');
    if (value.intensity !== undefined) {
      config.light.intensity = numberIn(value.intensity, 0, 20, 'light.intensity');
    }
    if (value.fill !== undefined) config.light.fill = numberIn(value.fill, 0, 5, 'light.fill');
    if (value.rim !== undefined) config.light.rim = numberIn(value.rim, 0, 5, 'light.rim');
    if (value.ambient !== undefined) {
      config.light.ambient = numberIn(value.ambient, 0, 5, 'light.ambient');
    }
  }

  if (raw.material !== undefined) {
    const value = objectInput(raw.material, 'material');
    unknownKeys(
      value,
      ['face', 'side', 'bevel', 'specular', 'shininess', 'mode', 'gradient', 'faceTop', 'faceBottom'],
      'material'
    );
    if (value.face !== undefined) config.material.face = hex(value.face, 'material.face');
    if (value.side !== undefined) config.material.side = hex(value.side, 'material.side');
    if (value.bevel !== undefined) config.material.bevel = hex(value.bevel, 'material.bevel');
    if (value.specular !== undefined) {
      config.material.specular = numberIn(value.specular, 0, 2, 'material.specular');
    }
    if (value.shininess !== undefined) {
      config.material.shininess = numberIn(value.shininess, 4, 256, 'material.shininess');
    }
    if (value.mode !== undefined) {
      config.material.mode = enumIn(value.mode, ['solid', 'chrome', 'neon'], 'material.mode');
    }
    if (value.gradient !== undefined) config.material.gradient = bool(value.gradient, 'material.gradient');
    if (value.faceTop !== undefined) config.material.faceTop = hex(value.faceTop, 'material.faceTop');
    if (value.faceBottom !== undefined) {
      config.material.faceBottom = hex(value.faceBottom, 'material.faceBottom');
    }
  }

  if (raw.shadow !== undefined) {
    const value = objectInput(raw.shadow, 'shadow');
    unknownKeys(value, ['enabled', 'opacity', 'distance', 'softness', 'color'], 'shadow');
    if (value.enabled !== undefined) config.shadow.enabled = bool(value.enabled, 'shadow.enabled');
    if (value.opacity !== undefined) {
      config.shadow.opacity = numberIn(value.opacity, 0, 1, 'shadow.opacity');
    }
    if (value.distance !== undefined) {
      config.shadow.distance = numberIn(value.distance, 0, 2, 'shadow.distance');
    }
    if (value.softness !== undefined) {
      config.shadow.softness = numberIn(value.softness, 0, 1, 'shadow.softness');
    }
    if (value.color !== undefined) config.shadow.color = hex(value.color, 'shadow.color');
  }

  if (raw.background !== undefined) {
    const value = objectInput(raw.background, 'background');
    unknownKeys(value, ['mode', 'color', 'top', 'bottom'], 'background');
    if (value.mode !== undefined) {
      if (value.mode !== 'transparent' && value.mode !== 'solid' && value.mode !== 'gradient') {
        throw new Error('background.mode must be "transparent", "solid" or "gradient".');
      }
      config.background.mode = value.mode;
    }
    if (value.color !== undefined) config.background.color = hex(value.color, 'background.color');
    if (value.top !== undefined) config.background.top = hex(value.top, 'background.top');
    if (value.bottom !== undefined) config.background.bottom = hex(value.bottom, 'background.bottom');
  }

  if (raw.render !== undefined) {
    const value = objectInput(raw.render, 'render');
    unknownKeys(value, ['samples', 'exposure', 'steps'], 'render');
    if (value.samples !== undefined) {
      config.render.samples = Math.round(numberIn(value.samples, 1, 3, 'render.samples'));
    }
    if (value.exposure !== undefined) {
      config.render.exposure = numberIn(value.exposure, 0.2, 3, 'render.exposure');
    }
    if (value.steps !== undefined) {
      config.render.steps = Math.round(numberIn(value.steps, 48, 256, 'render.steps'));
    }
  }

  return config;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(config) {
  const lines = config.text.split(/\r?\n/);
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const width = config.maskSize;
  const fontSize = Math.max(
    48,
    Math.min(width * 0.24, width / Math.max(3.2, longest * 0.58))
  );
  const lineHeight = fontSize * config.lineHeight;
  const pad = Math.max(16, Math.round(fontSize * 0.28));
  const height = Math.max(
    Math.round(fontSize * 1.2),
    Math.ceil(pad * 2 + lineHeight * (lines.length - 1) + fontSize * 1.05)
  );
  return { lines, width, height, fontSize, lineHeight, pad };
}

function maskSvg(config, dataDir) {
  const box = layout(config);
  const baseline = box.pad + box.fontSize * 0.82;
  const spans = box.lines
    .map(
      (line, index) =>
        '<tspan x="' +
        box.width / 2 +
        '" y="' +
        Math.round(baseline + index * box.lineHeight) +
        '">' +
        escapeXml(line) +
        '</tspan>'
    )
    .join('');
  const letterSpacing = config.letterSpacing ? ' letter-spacing="' + config.letterSpacing + '"' : '';
  const italic = config.italic ? ' font-style="italic"' : '';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    box.width +
    '" height="' +
    box.height +
    '" viewBox="0 0 ' +
    box.width +
    ' ' +
    box.height +
    '">' +
    '<text text-anchor="middle" font-family="' +
    escapeXml(config.font) +
    '" font-size="' +
    Math.round(box.fontSize) +
    '" font-weight="' +
    config.weight +
    '"' +
    italic +
    letterSpacing +
    ' fill="#ffffff">' +
    spans +
    '</text></svg>';

  const custom = fontsModule
    .list(dataDir)
    .some((font) => String(font.family).toLowerCase() === String(config.font).toLowerCase());
  return { svg, width: box.width, height: box.height, custom: custom };
}

function cropAlpha(raw) {
  const { data, width, height } = raw;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < 8) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) {
    throw new Error('The text rendered no visible ink. Check the font and the text. Nothing was changed.');
  }
  const pad = 10;
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width - 1, maxX + pad);
  const bottom = Math.min(height - 1, maxY + pad);
  const croppedWidth = right - left + 1;
  const croppedHeight = bottom - top + 1;
  const output = Buffer.alloc(croppedWidth * croppedHeight * 4);
  for (let y = 0; y < croppedHeight; y += 1) {
    const source = ((top + y) * width + left) * 4;
    const destination = y * croppedWidth * 4;
    data.copy(output, destination, source, source + croppedWidth * 4);
  }
  return { data: output, width: croppedWidth, height: croppedHeight };
}

async function prepareMask(dataDir, config) {
  const built = maskSvg(config, dataDir);
  const raster = await render.rasterizeSvg(
    built.svg,
    built.width,
    built.height,
    built.custom ? { fontDir: fontsModule.fontDir(dataDir) } : null
  );
  const cropped = cropAlpha(raster);
  const encoded = await render.encodeRaw(
    { data: cropped.data, width: cropped.width, height: cropped.height, channels: 4 },
    { format: 'png' }
  );
  return {
    buffer: encoded.buffer,
    width: cropped.width,
    height: cropped.height,
    aspect: cropped.width / cropped.height,
  };
}

function jobFor(config, options) {
  const settings = options || {};
  if (!settings.maskPath || !settings.outputPath) {
    throw new Error('The 3D text job needs a mask and an output path.');
  }
  const width = Math.round(Number(settings.width));
  const height = Math.round(Number(settings.height));
  if (!(width > 0 && height > 0)) throw new Error('3D text dimensions must be positive.');
  const aspect = Number(settings.aspect) || 1;
  const scale = config.scale;
  const worldHeight = scale;
  const worldWidth = aspect * scale;
  const depth = config.depth * scale;
  const bevel = config.bevel * scale;
  return [
    'mask ' + settings.maskPath,
    'out ' + settings.outputPath,
    'width ' + width,
    'height ' + height,
    'samples ' + config.render.samples,
    'steps ' + config.render.steps,
    'world_width ' + worldWidth,
    'world_height ' + worldHeight,
    'depth ' + depth,
    'bevel ' + bevel,
    'twist ' + config.twist,
    'position ' + config.position.join(' '),
    'rotation ' + config.rotation.join(' '),
    'camera_fov ' + config.camera.fov,
    'camera_yaw ' + config.camera.yaw,
    'camera_pitch ' + config.camera.pitch,
    'camera_zoom ' + config.camera.zoom,
    'light_dir ' + config.light.direction.join(' '),
    'light_color ' + config.light.color,
    'light_intensity ' + config.light.intensity,
    'fill ' + config.light.fill,
    'rim ' + config.light.rim,
    'ambient ' + config.light.ambient,
    'specular ' + config.material.specular,
    'shininess ' + config.material.shininess,
    'face ' + config.material.face,
    'side ' + config.material.side,
    'bevel_color ' + config.material.bevel,
    'material_mode ' + config.material.mode,
    'face_gradient ' + (config.material.gradient ? 1 : 0),
    'face_top ' + config.material.faceTop,
    'face_bottom ' + config.material.faceBottom,
    'shadow_enabled ' + (config.shadow.enabled ? 1 : 0),
    'shadow_opacity ' + config.shadow.opacity,
    'shadow_distance ' + config.shadow.distance,
    'shadow_softness ' + config.shadow.softness,
    'shadow_color ' + config.shadow.color,
    'background ' + config.background.mode,
    'bg_color ' + config.background.color,
    'bg_top ' + config.background.top,
    'bg_bottom ' + config.background.bottom,
    'exposure ' + config.render.exposure,
    '',
  ].join('\n');
}

function summary(config) {
  const first = config.text.split(/\r?\n/)[0];
  const label = first.length > 28 ? first.slice(0, 27) + '…' : first;
  return (
    '3D text "' +
    label +
    '" · ' +
    config.font +
    ' ' +
    config.weight +
    ' · depth ' +
    config.depth +
    ' · bevel ' +
    config.bevel +
    ' · native C++'
  );
}

module.exports = {
  DEFAULTS: DEFAULTS,
  jobFor: jobFor,
  layout: layout,
  maskSvg: maskSvg,
  normalize: normalize,
  prepareMask: prepareMask,
  summary: summary,
};
