/*
 * The 3D scene is document metadata, not a second document.
 *
 * A model is imported into extension storage once; the scene describes where it
 * sits, how it is lit and what the next render should produce. Rendering is a
 * normal photo operation: it writes a raster layer and a history entry. Keeping
 * this module free of file I/O makes the defaults and validation unit-testable.
 */
'use strict';

const ENGINE_VERSION = '1.1.0';

const DEFAULT_LIGHT = {
  direction: [0.5, 1, 0.4],
  color: '#fff4e0',
  intensity: 2.2,
  fill: 0.55,
  rim: 0.35,
  ambient: 0.35,
  shadows: true,
  shadowOpacity: 0.45,
  shadowSoftness: 1,
};

const DEFAULT_ENVIRONMENT = {
  mode: 'transparent',
  top: '#7ca6cc',
  horizon: '#d7e6ef',
  alpha: 1,
};

const DEFAULT_GROUND = {
  enabled: true,
  y: 0,
  color: '#000000',
  alpha: 0,
};

const DEFAULT_RENDER = {
  samples: 2,
  shadowMap: 1024,
  exposure: 1,
};

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
  return value.map((component, index) => numberIn(component, -100000, 100000, label + '[' + index + ']'));
}

function objectInput(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object.');
  }
  return value;
}

function defaultScene(model) {
  return {
    version: 1,
    engine: 'native-cpp',
    engineVersion: ENGINE_VERSION,
    model: clone(model),
    object: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
      placeOnGround: true,
    },
    camera: {
      auto: true,
      position: [0, 0, 0],
      target: [0, 0, 0],
      fov: 35,
      framing: 1,
    },
    light: clone(DEFAULT_LIGHT),
    environment: clone(DEFAULT_ENVIRONMENT),
    ground: clone(DEFAULT_GROUND),
    render: clone(DEFAULT_RENDER),
    lastRender: null,
    importedAt: new Date().toISOString(),
  };
}

function isScene(value) {
  return Boolean(value && typeof value === 'object' && value.version === 1 && value.model);
}

/** Merge only known sections and fields, so a typo cannot quietly do nothing. */
function configure(current, input) {
  if (!isScene(current)) throw new Error('No 3D scene is loaded. Use photo_3d import first.');
  const options = objectInput(input || {}, 'configure');
  const allowed = ['object', 'camera', 'light', 'environment', 'ground', 'render'];
  for (const key of Object.keys(options)) {
    if (allowed.indexOf(key) === -1) {
      throw new Error('Unknown 3D scene section "' + key + '". Use ' + allowed.join(', ') + '.');
    }
  }
  const scene = clone(current);

  if (options.object !== undefined) {
    const value = objectInput(options.object, 'object');
    const known = ['position', 'rotation', 'scale', 'placeOnGround'];
    for (const key of Object.keys(value)) {
      if (known.indexOf(key) === -1) throw new Error('Unknown object option "' + key + '".');
    }
    if (value.position !== undefined) scene.object.position = vector(value.position, 'object.position');
    if (value.rotation !== undefined) scene.object.rotation = vector(value.rotation, 'object.rotation');
    if (value.scale !== undefined) scene.object.scale = numberIn(value.scale, 0.001, 1000, 'object.scale');
    if (value.placeOnGround !== undefined) {
      scene.object.placeOnGround = bool(value.placeOnGround, 'object.placeOnGround');
    }
  }

  if (options.camera !== undefined) {
    const value = objectInput(options.camera, 'camera');
    const known = ['auto', 'position', 'target', 'fov', 'framing'];
    for (const key of Object.keys(value)) {
      if (known.indexOf(key) === -1) throw new Error('Unknown camera option "' + key + '".');
    }
    if (value.auto !== undefined) scene.camera.auto = bool(value.auto, 'camera.auto');
    if (value.position !== undefined) scene.camera.position = vector(value.position, 'camera.position');
    if (value.target !== undefined) scene.camera.target = vector(value.target, 'camera.target');
    if (value.fov !== undefined) scene.camera.fov = numberIn(value.fov, 10, 100, 'camera.fov');
    if (value.framing !== undefined) {
      scene.camera.framing = numberIn(value.framing, 0.5, 10, 'camera.framing');
    }
  }

  if (options.light !== undefined) {
    const value = objectInput(options.light, 'light');
    const known = [
      'direction',
      'color',
      'intensity',
      'fill',
      'rim',
      'ambient',
      'shadows',
      'shadowOpacity',
      'shadowSoftness',
    ];
    for (const key of Object.keys(value)) {
      if (known.indexOf(key) === -1) throw new Error('Unknown light option "' + key + '".');
    }
    if (value.direction !== undefined) {
      const direction = vector(value.direction, 'light.direction');
      if (Math.hypot(direction[0], direction[1], direction[2]) < 1e-6) {
        throw new Error('light.direction cannot be the zero vector.');
      }
      scene.light.direction = direction;
    }
    if (value.color !== undefined) scene.light.color = hex(value.color, 'light.color');
    if (value.intensity !== undefined) {
      scene.light.intensity = numberIn(value.intensity, 0, 20, 'light.intensity');
    }
    if (value.fill !== undefined) {
      scene.light.fill = numberIn(value.fill, 0, 5, 'light.fill');
    }
    if (value.rim !== undefined) {
      scene.light.rim = numberIn(value.rim, 0, 5, 'light.rim');
    }
    if (value.ambient !== undefined) {
      scene.light.ambient = numberIn(value.ambient, 0, 5, 'light.ambient');
    }
    if (value.shadows !== undefined) scene.light.shadows = bool(value.shadows, 'light.shadows');
    if (value.shadowOpacity !== undefined) {
      scene.light.shadowOpacity = numberIn(value.shadowOpacity, 0, 1, 'light.shadowOpacity');
    }
    if (value.shadowSoftness !== undefined) {
      scene.light.shadowSoftness = numberIn(value.shadowSoftness, 0, 4, 'light.shadowSoftness');
    }
  }

  if (options.environment !== undefined) {
    const value = objectInput(options.environment, 'environment');
    const known = ['mode', 'top', 'horizon', 'alpha'];
    for (const key of Object.keys(value)) {
      if (known.indexOf(key) === -1) throw new Error('Unknown environment option "' + key + '".');
    }
    if (value.mode !== undefined) {
      if (value.mode !== 'transparent' && value.mode !== 'sky') {
        throw new Error('environment.mode must be "transparent" or "sky".');
      }
      scene.environment.mode = value.mode;
    }
    if (value.top !== undefined) scene.environment.top = hex(value.top, 'environment.top');
    if (value.horizon !== undefined) {
      scene.environment.horizon = hex(value.horizon, 'environment.horizon');
    }
    if (value.alpha !== undefined) {
      scene.environment.alpha = numberIn(value.alpha, 0, 1, 'environment.alpha');
    }
  }

  if (options.ground !== undefined) {
    const value = objectInput(options.ground, 'ground');
    const known = ['enabled', 'y', 'color', 'alpha'];
    for (const key of Object.keys(value)) {
      if (known.indexOf(key) === -1) throw new Error('Unknown ground option "' + key + '".');
    }
    if (value.enabled !== undefined) scene.ground.enabled = bool(value.enabled, 'ground.enabled');
    if (value.y !== undefined) scene.ground.y = numberIn(value.y, -100000, 100000, 'ground.y');
    if (value.color !== undefined) scene.ground.color = hex(value.color, 'ground.color');
    if (value.alpha !== undefined) scene.ground.alpha = numberIn(value.alpha, 0, 1, 'ground.alpha');
  }

  if (options.render !== undefined) {
    const value = objectInput(options.render, 'render');
    const known = ['samples', 'shadowMap', 'exposure'];
    for (const key of Object.keys(value)) {
      if (known.indexOf(key) === -1) throw new Error('Unknown render option "' + key + '".');
    }
    if (value.samples !== undefined) {
      scene.render.samples = Math.round(numberIn(value.samples, 1, 3, 'render.samples'));
    }
    if (value.shadowMap !== undefined) {
      scene.render.shadowMap = Math.round(numberIn(value.shadowMap, 256, 2048, 'render.shadowMap'));
    }
    if (value.exposure !== undefined) {
      scene.render.exposure = numberIn(value.exposure, 0.1, 4, 'render.exposure');
    }
  }

  return scene;
}

function publicScene(scene) {
  if (!isScene(scene)) return null;
  return {
    version: scene.version,
    engine: scene.engine,
    engineVersion: scene.engineVersion,
    model: clone(scene.model),
    object: clone(scene.object),
    camera: clone(scene.camera),
    light: clone(scene.light),
    environment: clone(scene.environment),
    ground: clone(scene.ground),
    render: clone(scene.render),
    lastRender: clone(scene.lastRender || null),
    importedAt: scene.importedAt,
  };
}

function summarize(scene) {
  if (!isScene(scene)) return 'No 3D scene. Use photo_3d import with an absolute .glb or .gltf path.';
  const model = scene.model;
  const parts = [
    model.name + ' · ' + model.triangles.toLocaleString('en-US') + ' triangles',
    'camera ' + (scene.camera.auto ? 'auto' : 'manual') + ' @ ' + scene.camera.fov + '°',
    scene.light.shadows ? 'shadows on' : 'shadows off',
    scene.environment.mode === 'sky' ? 'sky background' : 'transparent background',
  ];
  if (scene.lastRender) {
    parts.push(
      'last render ' + scene.lastRender.width + '×' + scene.lastRender.height + ' in ' +
        Math.max(1, Math.round(scene.lastRender.renderMs)) + ' ms'
    );
  }
  return parts.join(' · ');
}

/**
 * Build the line-oriented job the native renderer consumes. Paths are the last
 * values on their line, so a home directory containing spaces survives.
 */
function jobFor(scene, options) {
  if (!isScene(scene)) throw new Error('No 3D scene is loaded.');
  const settings = options || {};
  if (!settings.modelPath) throw new Error('The scene has no imported model file.');
  if (!settings.outputPath) throw new Error('A render output path is required.');
  const width = Math.round(Number(settings.width));
  const height = Math.round(Number(settings.height));
  if (!(width > 0 && height > 0)) throw new Error('Render dimensions must be positive.');
  const light = scene.light;
  const fill = light.fill === undefined ? DEFAULT_LIGHT.fill : light.fill;
  const rim = light.rim === undefined ? DEFAULT_LIGHT.rim : light.rim;
  const direction = light.direction;
  const alpha = scene.environment.mode === 'sky' ? scene.environment.alpha : 0;
  return [
    'model ' + settings.modelPath,
    'out ' + settings.outputPath,
    'width ' + width,
    'height ' + height,
    'samples ' + scene.render.samples,
    'shadow_map ' + scene.render.shadowMap,
    'camera_auto ' + (scene.camera.auto ? 1 : 0),
    'camera_pos ' + scene.camera.position.join(' '),
    'camera_target ' + scene.camera.target.join(' '),
    'fov ' + scene.camera.fov,
    'framing ' + scene.camera.framing,
    'object_pos ' + scene.object.position.join(' '),
    'object_rot ' + scene.object.rotation.join(' '),
    'object_scale ' + scene.object.scale,
    'place_on_ground ' + (scene.object.placeOnGround ? 1 : 0),
    'light_dir ' + direction.join(' '),
    'light_color ' + light.color,
    'light_intensity ' + light.intensity,
    'fill ' + fill,
    'rim ' + rim,
    'ambient ' + light.ambient,
    'environment ' + scene.environment.mode,
    'sky_top ' + scene.environment.top,
    'sky_horizon ' + scene.environment.horizon,
    'background_alpha ' + alpha,
    'exposure ' + scene.render.exposure,
    'ground_enabled ' + (scene.ground.enabled ? 1 : 0),
    'ground_color ' + scene.ground.color,
    'ground_alpha ' + scene.ground.alpha,
    'ground_y ' + scene.ground.y,
    'shadows ' + (light.shadows ? 1 : 0),
    'shadow_opacity ' + light.shadowOpacity,
    'shadow_softness ' + light.shadowSoftness,
    '',
  ].join('\n');
}

const DEG = Math.PI / 180;

function previewBounds(scene) {
  const model = scene && scene.model;
  const bounds = model && model.bounds;
  if (
    !bounds ||
    !Array.isArray(bounds.min) ||
    !Array.isArray(bounds.max) ||
    bounds.min.length !== 3 ||
    bounds.max.length !== 3
  ) {
    throw new Error('The 3D model has no usable bounds for a preview.');
  }
  const object = scene.object || {};
  const scale = Number(object.scale) || 1;
  const rotation = Array.isArray(object.rotation) ? object.rotation : [0, 0, 0];
  const position = Array.isArray(object.position) ? object.position : [0, 0, 0];
  const rx = (Number(rotation[0]) || 0) * DEG;
  const ry = (Number(rotation[1]) || 0) * DEG;
  const rz = (Number(rotation[2]) || 0) * DEG;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const p = [x * scale, y * scale, z * scale];
        const zx = p[0] * cz - p[1] * sz;
        const zy = p[0] * sz + p[1] * cz;
        const xx = zx;
        const xy = zy * cx - p[2] * sx;
        const xz = zy * sx + p[2] * cx;
        const yx = xx * cy + xz * sy;
        const yy = xy;
        const yz = -xx * sy + xz * cy;
        const world = [yx + position[0], yy + position[1], yz + position[2]];
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis], world[axis]);
          max[axis] = Math.max(max[axis], world[axis]);
        }
      }
    }
  }
  if (object.placeOnGround !== false) {
    const groundY = Number(scene.ground && scene.ground.y) || 0;
    const shift = groundY - min[1];
    min[1] += shift;
    max[1] += shift;
  }
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    radius: Math.max(0.05, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2),
  };
}

function initialOrbit(scene) {
  const camera = scene.camera || {};
  const target = Array.isArray(camera.target) ? camera.target.map(Number) : [0, 0, 0];
  const position = Array.isArray(camera.position) ? camera.position.map(Number) : [0, 0, 0];
  if (camera.auto === false && position.every(Number.isFinite) && target.every(Number.isFinite)) {
    const dx = position[0] - target[0];
    const dy = position[1] - target[1];
    const dz = position[2] - target[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance > 1e-5) {
      return {
        yaw: Math.atan2(dx, dz) / DEG,
        pitch: Math.asin(Math.max(-1, Math.min(1, dy / distance))) / DEG,
        zoom: 1,
        distance,
        target,
      };
    }
  }
  const bounds = previewBounds(scene);
  const fov = Number(camera.fov) || 35;
  const framing = Number(camera.framing) || 1;
  const distance = (bounds.radius / Math.tan((fov * DEG) / 2)) * 1.02 * framing;
  const direction = [1, 0.35, 1];
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  return {
    yaw: Math.atan2(direction[0], direction[2]) / DEG,
    pitch: Math.asin(direction[1] / length) / DEG,
    zoom: 1,
    distance,
    target: bounds.center,
  };
}

function orbitPose(scene, orbit) {
  const base = initialOrbit(scene);
  const value = orbit && typeof orbit === 'object' ? orbit : {};
  const yaw = value.yaw === undefined ? base.yaw : numberIn(value.yaw, -360, 360, 'orbit.yaw');
  const pitch =
    value.pitch === undefined ? base.pitch : numberIn(value.pitch, -85, 85, 'orbit.pitch');
  const zoom = value.zoom === undefined ? 1 : numberIn(value.zoom, 0.25, 4, 'orbit.zoom');
  const yawRad = yaw * DEG;
  const pitchRad = pitch * DEG;
  const cosPitch = Math.cos(pitchRad);
  const direction = [
    Math.sin(yawRad) * cosPitch,
    Math.sin(pitchRad),
    Math.cos(yawRad) * cosPitch,
  ];
  const distance = base.distance * zoom;
  const target = base.target.slice();
  return {
    orbit: { yaw, pitch, zoom },
    camera: {
      position: [
        target[0] + direction[0] * distance,
        target[1] + direction[1] * distance,
        target[2] + direction[2] * distance,
      ],
      target,
      distance,
      fov: Number(scene.camera && scene.camera.fov) || 35,
    },
  };
}

function previewScene(scene, options) {
  if (!isScene(scene)) throw new Error('No 3D scene is loaded. Use photo_3d import first.');
  const settings = options || {};
  const pose = orbitPose(scene, settings.orbit);
  const draft = settings.quality === 'draft';
  const preview = clone(scene);
  preview.camera = Object.assign({}, scene.camera, {
    auto: false,
    position: pose.camera.position,
    target: pose.camera.target,
  });
  preview.render = Object.assign({}, scene.render, {
    samples: draft ? 1 : 2,
    shadowMap: Math.min(Number(scene.render.shadowMap) || 1024, draft ? 512 : 768),
  });
  return { scene: preview, orbit: pose.orbit, camera: pose.camera };
}

module.exports = {
  DEFAULT_ENVIRONMENT: DEFAULT_ENVIRONMENT,
  DEFAULT_GROUND: DEFAULT_GROUND,
  DEFAULT_LIGHT: DEFAULT_LIGHT,
  DEFAULT_RENDER: DEFAULT_RENDER,
  ENGINE_VERSION: ENGINE_VERSION,
  configure: configure,
  defaultScene: defaultScene,
  initialOrbit: initialOrbit,
  isScene: isScene,
  jobFor: jobFor,
  orbitPose: orbitPose,
  previewBounds: previewBounds,
  previewScene: previewScene,
  publicScene: publicScene,
  summarize: summarize,
};
