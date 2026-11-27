/*
 * The PhotoNext cockpit.
 *
 * This document owns no edit state. Every control calls a `photo_*` tool
 * through the bridge, exactly as the agent does, and every visible value comes
 * back from `photo_status`. That is what keeps one document: the layer list,
 * the adjustment stack and the canvas are the engine's state rendered, not a
 * second copy that can disagree with it.
 *
 * The simulated pointer is the other half of the idea. A tool call already
 * knows its geometry — a crop is a rectangle, a brush is a path, a sketch is
 * many paths — so the panel can show the agent working at the pixel it is
 * working on, with pressure-tapered brush halos, marquee drags and a crop
 * frame, instead of a spinner. Pointer events are decoration: a malformed one
 * must never stop the poll or the control surface.
 */
(function () {
  'use strict';

  var api = window.minotauris;
  var el = function (id) {
    return document.getElementById(id);
  };
  var REDUCED =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var POLL_IDLE_MS = 900;
  var POLL_BUSY_MS = 260;

  /* ── Tool catalogue ──────────────────────────────────────────────────── */

  var TOOLS = [
    {
      id: 'inspect',
      label: 'Inspect',
      title: 'Inspect the document',
      tab: 'info',
      glyph: 'arrow',
      hint: 'Read the document. Nothing is armed.',
    },
    {
      id: 'marquee',
      label: 'Marquee',
      title: 'Rectangular selection (photo_select)',
      tab: 'select',
      glyph: 'marquee',
      group: 'separator',
      hint: 'Drag on the canvas to call photo_select with a rect.',
    },
    {
      id: 'wand',
      label: 'Magic wand',
      title: 'Magic wand selection (photo_select)',
      tab: 'select',
      glyph: 'wand',
      hint: 'Click a pixel to flood-select it at the current tolerance.',
    },
    {
      id: 'fill',
      label: 'Bucket fill',
      title: 'Fuzzy bucket fill (photo_draw)',
      tab: 'brush',
      glyph: 'fill',
      hint: 'Click a pixel to flood-fill it with the brush colour at the fill tolerance.',
    },
    {
      id: 'crop',
      label: 'Crop',
      title: 'Crop the document (photo_edit)',
      tab: 'select',
      glyph: 'crop',
      group: 'separator',
      hint: 'Drag a crop frame, then apply it. The frame is not an edit until you do.',
    },
    {
      id: 'adjust',
      label: 'Adjust',
      title: 'Tone and colour (photo_adjust)',
      tab: 'adjust',
      glyph: 'adjust',
      group: 'separator',
      hint: 'Open the adjustment stack.',
    },
    {
      id: 'brush',
      label: 'Brush',
      title: 'Sketch with tapered strokes (photo_draw)',
      tab: 'brush',
      glyph: 'brush',
      hint: 'Drag to sketch one tapered photo_draw sketch command.',
    },
    {
      id: 'gradient',
      label: 'Gradient',
      title: 'Linear or radial gradient (photo_draw)',
      tab: 'brush',
      glyph: 'gradient',
      hint: 'Drag the gradient direction; it paints the canvas and respects a selection.',
    },
    {
      id: 'layer',
      label: 'Layers',
      title: 'Layer stack (photo_layer)',
      tab: 'layers',
      glyph: 'layers',
      group: 'separator',
      hint: 'Open the layer stack.',
    },
    {
      id: 'mask',
      label: 'Mask',
      title: 'Layer masks (photo_mask)',
      tab: 'layers',
      glyph: 'mask',
      hint: 'Masks are created from the selection; see the Layers panel.',
    },
    {
      id: 'scene',
      label: '3D scene',
      title: 'Native 3D compositing (photo_3d)',
      tab: 'info',
      glyph: '3d',
      group: 'separator',
      hint: 'Orbit the native preview; rendering adds a raster layer.',
    },
    {
      id: 'text3d',
      label: '3D text',
      title: 'Native 3D text (photo_text3d)',
      tab: 'text3d',
      glyph: 'text3d',
      hint: 'Type, preview and add a native extruded text layer.',
    },
    {
      id: 'effects',
      label: 'Effects',
      title: 'Native effects (photo_effect)',
      tab: 'effects',
      glyph: 'effects',
      hint: 'Preview and apply a native effect to the active raster layer.',
    },
    {
      id: 'history',
      label: 'History',
      title: 'Undo and redo (photo_history)',
      tab: 'history',
      glyph: 'history',
      hint: 'Walk the document through its undo history.',
    },
    {
      id: 'export',
      label: 'Export',
      title: 'Export the flattened document (photo_export)',
      tab: 'info',
      glyph: 'export',
      hint: 'Export is approval-gated; the agent names the destination.',
    }
  ];

  var glyphs = {
    arrow:
      '<path d="M4 3.2 19.2 12l-6.7 1.5-2.9 6.1z" fill="currentColor" stroke="none"/>',
    marquee:
      '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/>',
    wand:
      '<path d="M4 20 14 10M17 3l.9 2.6L21 6.5l-2.6.9L17 10l-.9-2.6L13.5 6.5l2.6-.9z"/>',
    crop: '<path d="M7 3v14h14M3 7h14v14"/>',
    adjust:
      '<path d="M5 7h14M5 12h14M5 17h14"/><circle cx="9" cy="7" r="2.1"/><circle cx="15" cy="12" r="2.1"/><circle cx="11" cy="17" r="2.1"/>',
    brush:
      '<path d="M14.5 4.5 19.5 9.5 10 19H5v-5z"/><path d="M12.5 6.5 17.5 11.5"/>',
    fill:
      '<path d="m5 11 6-6 6 6-6 6z"/><path d="M19 15c0 1.4-.9 2.5-2 2.5s-2-1.1-2-2.5 2-4 2-4 2 2.6 2 4z"/>',
    gradient:
      '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M7 16h10M7 13h10M7 10h10" opacity=".45"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>',
    mask: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16" fill="none"/>',
    '3d': '<path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6zM12 3.2v8.8M12 12l8-4.4M12 12 4 7.6"/>',
    text3d: '<path d="M5 5h14M12 5v14"/><path d="M8.5 8.5h14M15.5 8.5v14" opacity=".4"/>',
    effects: '<path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6z"/><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4.4l3 1.8"/>',
    export: '<path d="M12 3v11M8 10l4 4 4-4M5 19h14"/>'
  };

  /* ── State ───────────────────────────────────────────────────────────── */

  var status = null;
  var previewSrc = '';
  var lastRevision = -1;
  var failures = 0;
  var timer = null;
  var armed = 'inspect';
  var activeTab = 'layers';
  var zoomMode = 'fit';
  var busy = false;

  var lastPointerKey = '';
  var pointerQueue = [];
  var pointerBusy = false;
  var lastCursor = null;
  var labelTimer = null;
  var trailClearTimer = null;

  var stamps = {
    layers: '',
    history: '',
    info: '',
    blend: '',
    tools: '',
    saved: '',
  };
  var blendOptions = '';

  var pendingCrop = null;
  var agentRegion = null;
  var drag = null;
  var brushPoints = [];
  var scene = {
    on: false,
    orbit: null,
    src: '',
    busy: false,
    queued: null,
    serial: 0,
    drag: null,
    timer: null,
    refine: null,
    stamp: '',
    lastStatus: ''
  };

  /* ── Small helpers ───────────────────────────────────────────────────── */

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function num(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatBytes(bytes) {
    var number = Number(bytes);
    if (!Number.isFinite(number) || number <= 0) return '';
    if (number < 1024) return number + ' B';
    if (number < 1024 * 1024) return (number / 1024).toFixed(number < 10240 ? 1 : 0) + ' KB';
    return (number / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function ago(value) {
    var timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return '';
    var seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    return Math.round(minutes / 60) + 'h ago';
  }

  function toolName(value) {
    return String(value || '').replace(/^photo_/, '') || 'edit';
  }

  function canvasSize() {
    var canvas = status && status.canvas ? status.canvas : null;
    if (canvas && canvas.width && canvas.height) return canvas;
    return { width: (status && status.width) || 0, height: (status && status.height) || 0 };
  }

  function activeLayer() {
    var layers = (status && status.layers) || [];
    for (var index = 0; index < layers.length; index += 1) {
      if (layers[index].active) return layers[index];
    }
    return null;
  }

  /**
   * The layer a brush stroke can actually land on.
   *
   * photo_adjust makes its adjustment layer active, and an adjustment layer has
   * no pixels. A brush is still a raster tool: after an adjustment, sketch on
   * the active raster if there is one, otherwise on the topmost raster. This is
   * passed explicitly as target.layer so arming the brush does not move the
   * agent's active layer just to draw.
   */
  function rasterLayerId() {
    var layers = (status && status.layers) || [];
    var active = activeLayer();
    // A 3D text layer is already rasterised, so an effect can consume its
    // pixels just like a paint layer. Excluding it made Preview and Apply do
    // nothing right after Add layer, when the new text was the active layer.
    var hasPixels = function (layer) {
      return layer.kind === 'raster' || layer.kind === 'text3d';
    };
    if (active && hasPixels(active)) return active.id;
    for (var index = layers.length - 1; index >= 0; index -= 1) {
      if (hasPixels(layers[index])) return layers[index].id;
    }
    return null;
  }

  function paintTarget() {
    var target = {};
    var id = rasterLayerId();
    if (id) target.layer = id;
    if (status && status.selection) target.selection = true;
    return Object.keys(target).length ? target : undefined;
  }

  function setStateTone(tone) {
    var dot = el('liveDot');
    if (tone) dot.setAttribute('data-tone', tone);
    else dot.removeAttribute('data-tone');
  }

  function setState(text, tone) {
    el('activity').textContent = text;
    setStateTone(tone || null);
  }

  function notify(text, tone) {
    var toast = el('toast');
    toast.textContent = text;
    if (tone) toast.setAttribute('data-tone', tone);
    else toast.removeAttribute('data-tone');
    toast.hidden = false;
    if (notify.timer) clearTimeout(notify.timer);
    notify.timer = window.setTimeout(function () {
      toast.hidden = true;
    }, tone === 'error' ? 5200 : 2800);
  }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(poll, delay);
  }

  /** The structured payload of one tool call, or a thrown, human error. */
  function payloadOf(response) {
    if (!response) throw new Error('The editor did not answer.');
    if (response.ok === false) throw new Error(response.error || 'The editor refused the call.');
    var result = response.result || {};
    if (result.error) throw new Error(result.error);
    var data = result.data || result;
    if (data && data.ok === false) throw new Error(data.error || 'The editor refused the call.');
    if (data && data.isError) {
      var content = data.content || [];
      throw new Error((content[0] && content[0].text) || 'The editor refused the call.');
    }
    var payload = data && (data.structuredContent || data.payload || data);
    if (!payload || typeof payload !== 'object') throw new Error('The editor returned no document.');
    return payload;
  }

  /**
   * The one way a control changes the document.
   *
   * It is deliberately the same bridge the agent's tool calls take, so approval,
   * auditing and history all apply. `label` is what the activity line says while
   * it runs; a failure is a toast, never a silent no-op.
   */
  function callTool(name, args, label, options) {
    var apply = !options || options.apply !== false;
    busy = true;
    setState(label || name, 'busy');
    return api.tools
      .call(name, args || {})
      .then(function (response) {
        var payload = payloadOf(response);
        // Preview calls return an image, not a document. Applying that payload
        // as status would replace the cockpit with an empty state.
        if (apply) applyStatus(payload, { keepPreview: true });
        return payload;
      })
      .catch(function (error) {
        notify((error && error.message) || String(error), 'error');
        setState((error && error.message) || 'The editor refused the call.', 'error');
        schedule(1200);
        return null;
      })
      .then(function (payload) {
        busy = false;
        schedule(120);
        return payload;
      });
  }

  /* ── Header and chrome ───────────────────────────────────────────────── */

  function renderToolrail() {
    var rail = el('toolrail');
    var last = latestHistory();
    var lastTool = last ? String(last.tool || '') : '';
    var html = '';
    TOOLS.forEach(function (tool) {
      var live = lastTool && lastTool.indexOf(tool.id) !== -1;
      html +=
        '<button type="button" class="rail-btn' +
        (armed === tool.id ? ' is-armed' : '') +
        (live ? ' is-live' : '') +
        '" data-tool="' +
        tool.id +
        '" data-group="' +
        (tool.group || '') +
        '" title="' +
        tool.title +
        '" aria-label="' +
        tool.label +
        '" aria-pressed="' +
        (armed === tool.id ? 'true' : 'false') +
        '"><svg viewBox="0 0 24 24" aria-hidden="true">' +
        (glyphs[tool.glyph] || glyphs.arrow) +
        '</svg><span class="rail-dot" aria-hidden="true"></span></button>';
    });
    rail.innerHTML = html;
    var readout = TOOLS.filter(function (tool) {
      return tool.id === armed;
    })[0];
    el('toolReadout').textContent = readout ? readout.label : 'Inspect';
    el('plate').setAttribute('data-armed', armed);
  }

  function armTool(id) {
    var tool = TOOLS.filter(function (candidate) {
      return candidate.id === id;
    })[0];
    if (!tool) return;
    armed = id;
    if (tool.tab) selectTab(tool.tab, false);
    renderToolrail();
    if (tool.hint) setState(tool.hint, null);
    if (id === 'crop' && !pendingCrop) {
      // A crop needs a frame before it means anything.
      el('cropConfirm').hidden = true;
    }
  }

  function selectTab(tab, focus) {
    activeTab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (button) {
      button.setAttribute('aria-selected', button.getAttribute('data-tab') === tab ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (panel) {
      var selected = panel.getAttribute('data-panel') === tab;
      if (selected) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
    if (focus) {
      var button = document.querySelector('.tabs button[data-tab="' + tab + '"]');
      if (button) button.focus();
    }
  }

  function latestHistory() {
    var history = (status && status.history) || [];
    return history.length ? history[history.length - 1] : null;
  }

  function renderHeader() {
    var loaded = Boolean(status && status.loaded);
    var layer = activeLayer();
    el('docTitle').textContent = loaded
      ? status.sourceName || (status.layers && status.layers.length ? 'Working image' : 'Untitled')
      : 'No document';
    el('docSubtitle').textContent = loaded
      ? (status.width + ' × ' + status.height) +
        ' · ' +
        ((status.layers || []).length + ((status.layers || []).length === 1 ? ' layer' : ' layers')) +
        (layer && layer.kind === 'adjustment' ? ' · ' + layer.name : '')
      : 'Waiting for the agent';
    el('rev').textContent = 'rev ' + ((status && status.revision) || 0);
    el('file').textContent = loaded ? status.sourceName || status.fileName || 'Working image' : 'Waiting for an image';
    el('file').title = loaded ? status.fileName || '' : '';
    el('size').textContent = loaded ? status.width + ' × ' + status.height : '';
    el('format').textContent = loaded
      ? [
          String(status.format || '').toUpperCase(),
          formatBytes(status.bytes),
          (status.historyState ? status.historyState.applied + '/' + status.historyState.total : '')
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
    var engine = status && status.capabilities ? status.capabilities : null;
    el('engine').textContent = engine && engine.backend
      ? engine.backend + (engine.version ? ' ' + engine.version : '')
      : 'photo_status';
  }

  /* ── Layout and preview ──────────────────────────────────────────────── */

  function layout() {
    if (!status || !status.loaded) return;
    var size = canvasSize();
    if (!size.width || !size.height) return;
    if (scene.on) {
      el('canvasDims').textContent = size.width + ' × ' + size.height;
      el('scaleReadout').textContent = '3D';
      return;
    }
    var stage = el('stage');
    var plate = el('plate');
    var padding = 44;
    var availableWidth = Math.max(40, stage.clientWidth - padding);
    var availableHeight = Math.max(40, stage.clientHeight - padding);
    var scale =
      zoomMode === 'fit'
        ? Math.min(availableWidth / size.width, availableHeight / size.height, 1)
        : num(zoomMode, 1);
    plate.style.width = Math.max(1, Math.round(size.width * scale)) + 'px';
    plate.style.height = Math.max(1, Math.round(size.height * scale)) + 'px';
    stage.classList.toggle('is-zoomed', zoomMode !== 'fit');
    var image = el('preview');
    image.classList.toggle('is-crisp', scale > 1.25);
    el('scaleReadout').textContent = Math.round(scale * 100) + '%';
    el('canvasDims').textContent = size.width + ' × ' + size.height;
    placeOverlay();
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 100);
  });

  function showEmpty(message, tone) {
    el('empty').hidden = false;
    el('plate').hidden = true;
    el('stage').classList.remove('is-scene');
    el('file').textContent = 'Waiting for an image';
    el('size').textContent = '';
    el('format').textContent = '';
    el('docTitle').textContent = 'No document';
    el('docSubtitle').textContent = 'Waiting for the agent';
    el('layerCount').textContent = '0';
    el('historyCount').textContent = '0';
    el('layers').innerHTML = '';
    el('history').innerHTML = '';
    el('info').innerHTML = '';
    el('toolList').innerHTML = '';
    el('savedSelections').innerHTML = '';
    el('layersEmpty').hidden = false;
    el('historyEmpty').hidden = false;
    el('savedEmpty').hidden = false;
    el('histogram').hidden = true;
    el('histogramEmpty').hidden = false;
    el('empty').querySelector('p').textContent =
      message ||
      'The agent opens this cockpit when it starts a photo. Import with photo_import and the document appears here.';
    previewSrc = '';
    stamps.layers = '';
    stamps.history = '';
    stamps.info = '';
    el('cursor').hidden = true;
    el('cursor').classList.remove('is-on', 'show-label');
    pendingCrop = null;
    agentRegion = null;
    drawRegionBox(null);
    placeHalo(0);
    setCursorTrail(null);
    setState(tone === 'error' ? 'The editor could not start' : 'Waiting for the agent', tone === 'error' ? 'error' : null);
  }

  function render(next) {
    status = next;
    if (!next || !next.loaded) {
      showEmpty(
        next && next.storageError
          ? 'PhotoNext storage could not be opened: ' + next.storageError
          : null,
        next && next.capabilities && next.capabilities.available === false ? 'error' : 'waiting'
      );
      renderToolrail();
      return;
    }

    el('empty').hidden = true;
    el('plate').hidden = scene.on ? true : false;

    if (next.preview && next.preview !== previewSrc) {
      previewSrc = next.preview;
      var image = el('preview');
      image.src = next.preview;
      image.classList.remove('is-new');
      void image.offsetWidth;
      image.classList.add('is-new');
    }
    el('preview').alt =
      (next.sourceName || next.fileName || 'Working image') + ' — preview from the agent';

    renderHeader();
    layout();
    renderLayers(next);
    renderHistory(next);
    renderSelection(next);
    renderInfo(next);
    renderBrushFromStatus(next);
    renderNativePanels(next);
    updateSceneChrome();
    if (scene.on && currentSceneStamp() !== scene.stamp) {
      scene.stamp = currentSceneStamp();
      requestScenePreview('final', true);
    }

    var pointer = pointerCandidate(next);
    if (pointer) {
      var key = pointerKey(pointer);
      if (key !== lastPointerKey) {
        lastPointerKey = key;
        enqueuePointer(pointer);
      }
    }

    if (!pointerQueue.length && !pointerBusy && !drag) restingStatus();
  }

  function applyStatus(next, options) {
    if (!next) return;
    if (!options || !options.keepPreview) previewSrc = '';
    render(next);
    // A tool payload can omit the preview. Keep the revision stale in that case
    // so the next poll asks for one; advancing it here would make the panel
    // treat the old image as current after an undo or a paint call.
    if (next.revision !== undefined && next.preview !== undefined) lastRevision = next.revision;
  }

  /* ── Layers ──────────────────────────────────────────────────────────── */

  function blendModeStamp(next) {
    var modes = (next.capabilities && next.capabilities.blendModes) || [];
    var stamp = modes.join(',');
    if (stamp === stamps.blend) return;
    stamps.blend = stamp;
    blendOptions = modes;
    var select = el('blendMode');
    select.innerHTML = modes
      .map(function (mode) {
        return '<option value="' + mode + '">' + mode.replace(/-/g, ' ') + '</option>';
      })
      .join('');
  }

  function styleShortName(type) {
    return (
      {
        dropShadow: 'shadow',
        outerGlow: 'glow',
        stroke: 'stroke',
        innerStroke: 'inner',
        bevel: 'bevel'
      }[type] || type
    );
  }

  function renderTextProps(layer) {
    var wrap = el('textProps');
    if (!wrap) return;
    var text = layer && layer.kind === 'text' ? layer.text : null;
    wrap.hidden = !text;
    if (!text) return;
    var transform = text.transform || {};
    if (document.activeElement !== el('textContent')) el('textContent').value = text.content || '';
    if (document.activeElement !== el('textSize')) el('textSize').value = String(text.size);
    if (document.activeElement !== el('textColor')) {
      el('textColor').value = String(text.color || '#ffffff').slice(0, 7);
    }
    if (document.activeElement !== el('textX')) el('textX').value = String(transform.x || 0);
    if (document.activeElement !== el('textY')) el('textY').value = String(transform.y || 0);
  }

  function renderLayers(next) {
    var layers = next.layers || [];
    var active = activeLayer();
    var stamp = layers
      .map(function (layer) {
        return [
          layer.id,
          layer.name,
          layer.kind,
          layer.visible ? 1 : 0,
          layer.locked ? 1 : 0,
          layer.opacity,
          layer.blendMode,
          layer.mask ? layer.mask.inverted : '',
          layer.active ? 1 : 0,
          layer.parentId || '',
          layer.depth || 0,
          layer.children || 0,
          layer.offset ? layer.offset.x + ',' + layer.offset.y : '',
          (layer.styles || [])
            .map(function (style) {
              return style.id + ':' + (style.enabled === false ? 0 : 1);
            })
            .join(','),
          layer.text
            ? [
                layer.text.content,
                layer.text.size,
                layer.text.color,
                layer.text.transform ? layer.text.transform.x + ',' + layer.text.transform.y : ''
              ].join(':')
            : ''
        ].join(':');
      })
      .join('|');
    el('layerCount').textContent = String(layers.length);
    el('layersEmpty').hidden = layers.length > 0;
    blendModeStamp(next);

    // Top of the stack first, which is how every layer panel reads.
    var ordered = layers.slice().reverse();
    if (stamp !== stamps.layers) {
      stamps.layers = stamp;
      var html = '';
      ordered.forEach(function (layer) {
        html +=
          '<li class="layer-row' +
          (layer.active ? ' is-active' : '') +
          '" data-layer="' +
          layer.id +
          '" data-depth="' +
          (layer.depth || 0) +
          '" style="padding-left:' +
          (4 + (layer.depth || 0) * 10) +
          'px"' +
          '" title="Select ' +
          (layer.name || layer.id) +
          ' (photo_layer select)">' +
          '<button type="button" class="layer-eye" data-visible="' +
          layer.id +
          '" aria-label="' +
          (layer.visible ? 'Hide' : 'Show') +
          ' ' +
          (layer.name || layer.id) +
          '" title="' +
          (layer.visible ? 'Hide' : 'Show') +
          ' layer (photo_layer set)"><svg viewBox="0 0 24 24" aria-hidden="true">' +
          (layer.visible
            ? '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>'
            : '<path d="M3 3l18 18"/><path d="M10.6 6.2A10.9 10.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.1 3.6M6.3 7.9A17.6 17.6 0 0 0 2 12s3.6 6 10 6c1.4 0 2.7-.3 3.8-.8"/>') +
          '</svg></button>' +
          '<span class="layer-kind" data-kind="' +
          layer.kind +
          '" aria-hidden="true"></span>' +
          '<span class="layer-name">' +
          escapeHtml(layer.name || layer.id) +
          (layer.mask ? ' <span class="layer-mask">mask</span>' : '') +
          '</span>' +
          '<span class="layer-meta">' +
          (layer.kind === 'adjustment'
            ? (layer.adjustments || 0) + ' adj'
            : layer.kind === 'group'
              ? (layer.children || 0) + ' layers'
              : layer.kind === 'text' && layer.text
                ? Math.round(layer.text.size) + 'px'
                : Math.round((layer.opacity === undefined ? 1 : layer.opacity) * 100) + '%') +
          '</span>' +
          (layer.kind === 'adjustment'
            ? ''
            : '<div class="layer-styles">' +
              (layer.styles || [])
                .map(function (style) {
                  var name = styleShortName(style.type);
                  var on = style.enabled !== false;
                  return (
                    '<span class="layer-style' +
                    (on ? '' : ' is-off') +
                    '"><button type="button" class="layer-style-toggle" data-style-toggle="' +
                    style.id +
                    '" data-style-layer="' +
                    layer.id +
                    '" aria-pressed="' +
                    (on ? 'true' : 'false') +
                    '" title="' +
                    (on ? 'Disable ' : 'Enable ') +
                    name +
                    ' (photo_style set)">' +
                    name +
                    '</button><button type="button" class="layer-style-remove" data-style-remove="' +
                    style.id +
                    '" data-style-layer="' +
                    layer.id +
                    '" title="Remove ' +
                    name +
                    ' (photo_style remove)" aria-label="Remove ' +
                    name +
                    '">×</button></span>'
                  );
                })
                .join('') +
              '<button type="button" class="layer-style-add" data-style-add="' +
              layer.id +
              '" title="Add a drop shadow (photo_style add)">+ style</button></div>') +
          '</li>';
      });
      el('layers').innerHTML = html;
    }

    if (active) {
      var select = el('blendMode');
      if (select.value !== active.blendMode && blendOptions.indexOf(active.blendMode) !== -1) {
        select.value = active.blendMode;
      }
      select.disabled = false;
      var opacity = Math.round((active.opacity === undefined ? 1 : active.opacity) * 100);
      var range = el('layerOpacity');
      if (document.activeElement !== range) range.value = String(opacity);
      el('layerOpacityOut').textContent = opacity + '%';
      range.disabled = false;
      el('layerProps').removeAttribute('data-empty');
      renderTextProps(active);
    } else {
      renderTextProps(null);
      el('blendMode').disabled = true;
      el('layerOpacity').disabled = true;
      el('layerOpacityOut').textContent = '—';
      el('layerProps').setAttribute('data-empty', 'true');
    }

    renderSelectFromStatus(next);
    renderSavedSelections(next);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Selection ───────────────────────────────────────────────────────── */

  function renderSelection(next) {
    var selection = next.selection;
    if (el('selectFeather').value === '' || el('selectFeather').value === '0') {
      if (selection && selection.feather) el('selectFeather').value = String(selection.feather);
    }
    drawSelectionBox(selection);
  }

  function renderSelectFromStatus(next) {
    var tolerance = next.selection && next.selection.tolerance;
    if (tolerance !== undefined && document.activeElement !== el('wandTolerance')) {
      el('wandTolerance').value = String(tolerance);
      el('wandToleranceOut').textContent = String(tolerance);
    }
  }

  function renderSavedSelections(next) {
    var names = next.savedSelections || [];
    var stamp = names.join(',');
    if (stamp === stamps.saved) return;
    stamps.saved = stamp;
    el('savedSelections').innerHTML = names
      .map(function (name) {
        return (
          '<li><button type="button" data-load-selection="' +
          escapeHtml(name) +
          '" title="Load ' +
          escapeHtml(name) +
          ' (photo_select load)">' +
          escapeHtml(name) +
          '</button></li>'
        );
      })
      .join('');
    el('savedEmpty').hidden = names.length > 0;
  }

  /* ── History ─────────────────────────────────────────────────────────── */

  function renderHistory(next) {
    var state = next.historyState || {};
    var entries = state.entries || [];
    var stamp =
      entries
        .map(function (entry) {
          return entry.index + ':' + entry.applied + ':' + entry.tool + ':' + entry.summary;
        })
        .join('|') +
      '#' +
      state.applied +
      '/' +
      state.total;
    el('historyCount').textContent = String(entries.length);
    el('undoButton').disabled = !state.canUndo;
    el('redoButton').disabled = !state.canRedo;
    el('historyEmpty').hidden = entries.length > 0;
    if (stamp === stamps.history) return;
    stamps.history = stamp;
    el('history').innerHTML = entries
      .map(function (entry) {
        var current = entry.index === state.applied;
        var rowState = entry.applied ? (current ? 'current' : 'applied') : 'redo';
        return (
          '<li data-state="' +
          rowState +
          '" data-history-index="' +
          entry.index +
          '" data-applied="' +
          (entry.applied ? '1' : '0') +
          '" title="' +
          (entry.applied ? 'Undo back to this step' : 'Redo forward to this step') +
          ' (photo_history)">' +
          '<span class="step-index">' +
          String(entry.index).padStart(2, '0') +
          '</span>' +
          '<span class="step-summary">' +
          escapeHtml(entry.summary) +
          '</span>' +
          '<span class="step-tool">' +
          escapeHtml(toolName(entry.tool)) +
          '</span></li>'
        );
      })
      .join('');
  }

  /**
   * Walk the history to a step by undoing or redoing the difference.
   *
   * photo_history has no "jump to" verb on purpose — an op log is a stack, and
   * a jump would have to replay every intermediate state anyway. Doing exactly
   * that here keeps one history model instead of adding a second.
   */
  function stepHistory(index, applied) {
    var state = status && status.historyState ? status.historyState : null;
    if (!state) return;
    var delta = applied ? state.applied - index : index - state.applied;
    if (delta <= 0) return;
    var action = applied ? 'undo' : 'redo';
    var chain = Promise.resolve();
    for (var step = 0; step < delta; step += 1) {
      chain = chain.then(function () {
        return callTool('photo_history', { action: action }, action + ' → step ' + index);
      });
    }
    chain.then(function () {
      setState(action === 'undo' ? 'Undid to step ' + index : 'Redid to step ' + index, null);
    });
  }

  /* ── Info ────────────────────────────────────────────────────────────── */

  function infoGroup(parent, title, rows, empty) {
    var group = document.createElement('div');
    group.className = 'info-group';
    var heading = document.createElement('h3');
    heading.textContent = title;
    group.appendChild(heading);
    if (!rows.length) {
      var note = document.createElement('p');
      note.className = 'panel-empty';
      note.textContent = empty || '—';
      group.appendChild(note);
    } else {
      var list = document.createElement('dl');
      rows.forEach(function (row) {
        var item = document.createElement('div');
        item.className = 'info-row';
        var term = document.createElement('dt');
        term.textContent = row[0];
        var value = document.createElement('dd');
        value.textContent = row[1];
        value.title = String(row[1]);
        item.appendChild(term);
        item.appendChild(value);
        list.appendChild(item);
      });
      group.appendChild(list);
    }
    parent.appendChild(group);
  }

  function renderInfo(next) {
    var size = canvasSize();
    var layer = activeLayer();
    var history = next.historyState || {};
    var sceneData = next.scene3d;
    var stamp = [
      size.width,
      size.height,
      next.format,
      next.bytes,
      next.revision,
      next.updatedAt,
      layer ? layer.id + ':' + layer.name + ':' + layer.kind + ':' + layer.blendMode + ':' + layer.opacity : 'none',
      next.selection ? next.selection.summary + ':' + JSON.stringify(next.selection.bounds) : 'none',
      (next.savedSelections || []).join(','),
      history.applied,
      history.total,
      history.bytes,
      history.budgetBytes,
      sceneData ? JSON.stringify(sceneData) : 'no-3d',
      (next.tools || []).map(function (tool) { return tool.name; }).join(',')
    ].join('|');
    if (stamp === stamps.info) return;
    stamps.info = stamp;

    var info = el('info');
    info.innerHTML = '';
    infoGroup(info, 'Document', [
      ['Canvas', size.width && size.height ? size.width + ' × ' + size.height : '—'],
      ['Format', String(next.format || '').toUpperCase() || '—'],
      ['File size', formatBytes(next.bytes) || '—'],
      ['Revision', 'rev ' + next.revision + (ago(next.updatedAt) ? ' · ' + ago(next.updatedAt) : '')]
    ]);

    if (layer) {
      infoGroup(info, 'Active layer', [
        ['Name', layer.name || layer.id],
        ['Kind', layer.kind === 'adjustment' ? 'Adjustment' : 'Raster'],
        ['Source', layer.width && layer.height ? layer.width + ' × ' + layer.height : '—'],
        [
          'Blend',
          String(layer.blendMode || 'normal').replace(/-/g, ' ') +
            ' · ' +
            Math.round((layer.opacity === undefined ? 1 : layer.opacity) * 100) +
            '%'
        ]
      ]);
    } else {
      infoGroup(info, 'Active layer', [], 'No layer selected. photo_layer select makes one active.');
    }

    if (next.selection) {
      var bounds = next.selection.bounds || {};
      infoGroup(info, 'Selection', [
        ['Shape', next.selection.summary || next.selection.kind || 'selection'],
        ['Bounds', bounds.width ? bounds.x + ', ' + bounds.y + ' · ' + bounds.width + ' × ' + bounds.height : '—'],
        ['Feather', next.selection.feather ? next.selection.feather + ' px' : 'hard edge'],
        ['Saved', (next.savedSelections || []).length ? String((next.savedSelections || []).length) : 'none']
      ]);
    } else {
      infoGroup(info, 'Selection', [], 'No selection. photo_select narrows an edit.');
    }

    if (sceneData) {
      var object = sceneData.object || {};
      var light = sceneData.light || {};
      var environment = sceneData.environment || {};
      var model = sceneData.model || {};
      var last = sceneData.lastRender;
      infoGroup(info, '3D scene', [
        ['Model', (model.name || 'model') + ' · ' + (model.triangles ? Number(model.triangles).toLocaleString() + ' tris' : 'probing')],
        ['Object', 'scale ' + (object.scale === undefined ? 1 : object.scale) + (object.placeOnGround ? ' · grounded' : ' · free')],
        ['Camera', (sceneData.camera && sceneData.camera.auto ? 'auto' : 'manual') + ' · ' + (sceneData.camera ? sceneData.camera.fov : 35) + '°'],
        ['Light', (light.shadows ? 'shadows' : 'no shadows') + ' · ' + (light.intensity === undefined ? 2.2 : light.intensity) + '×'],
        ['Environment', environment.mode === 'sky' ? 'sky' : 'transparent'],
        ['Render', last ? last.width + ' × ' + last.height + ' · ' + Math.max(1, Math.round(last.renderMs)) + ' ms' : 'not rendered']
      ]);
    } else {
      infoGroup(info, '3D scene', [], 'No model. photo_3d imports one.');
    }

    infoGroup(info, 'History', [
      ['Applied', (history.applied === undefined ? 0 : history.applied) + ' of ' + (history.total || 0)],
      ['Undo', history.canUndo ? 'available' : 'none'],
      ['Redo', history.canRedo ? 'available' : 'none'],
      ['Size', history.budgetBytes ? (formatBytes(history.bytes) || '0 B') + ' of ' + formatBytes(history.budgetBytes) : '—']
    ]);

    var fonts = next.fonts || [];
    infoGroup(
      info,
      'Fonts',
      fonts.map(function (font) {
        return [font.family, formatBytes(font.bytes) || 'installed'];
      }),
      'No downloaded fonts. photo_font adds one.'
    );

    renderToolList(next);
    renderHistogram(next);
  }

  function renderToolList(next) {
    var tools = next.tools || [];
    var stamp = tools
      .map(function (tool) {
        return tool.name + ':' + tool.readOnly + ':' + tool.requiresApproval;
      })
      .join(',');
    if (stamp === stamps.tools) return;
    stamps.tools = stamp;
    el('toolList').innerHTML = tools
      .map(function (tool) {
        return (
          '<li><span>' +
          escapeHtml(tool.name) +
          '</span><span class="tool-flag">' +
          (tool.requiresApproval ? 'approval' : tool.readOnly ? 'read' : 'write') +
          '</span></li>'
        );
      })
      .join('');
  }

  function renderHistogram(next) {
    var canvas = el('histogram');
    var context = canvas.getContext('2d');
    var histogram = next.histogram;
    var has = Boolean(histogram && histogram.red && histogram.red.length);
    canvas.hidden = !has;
    el('histogramEmpty').hidden = has;
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!has) return;

    var peak = 1;
    ['red', 'green', 'blue'].forEach(function (channel) {
      var bins = histogram[channel] || [];
      for (var index = 0; index < bins.length; index += 1) {
        if (bins[index] > peak) peak = bins[index];
      }
    });

    context.strokeStyle = 'rgba(127, 137, 152, .2)';
    context.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(function (fraction) {
      var y = Math.round(canvas.height * fraction) + 0.5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(canvas.width, y);
      context.stroke();
    });

    context.globalCompositeOperation = 'lighter';
    var inks = {
      red: 'rgba(255, 92, 92, .7)',
      green: 'rgba(74, 222, 128, .62)',
      blue: 'rgba(96, 140, 255, .72)'
    };
    ['red', 'green', 'blue'].forEach(function (channel) {
      var bins = histogram[channel] || [];
      if (!bins.length) return;
      context.beginPath();
      context.moveTo(0, canvas.height);
      for (var index = 0; index < bins.length; index += 1) {
        var x = (index / (bins.length - 1)) * canvas.width;
        var value = Math.sqrt(bins[index] / peak);
        context.lineTo(x, canvas.height - value * (canvas.height - 4));
      }
      context.lineTo(canvas.width, canvas.height);
      context.closePath();
      context.fillStyle = inks[channel];
      context.fill();
    });
    context.globalCompositeOperation = 'source-over';
  }

  /* ── Brush readout ───────────────────────────────────────────────────── */

  function brushSettings() {
    return {
      size: num(el('brushSize').value, 6),
      opacity: num(el('brushOpacity').value, 100) / 100,
      color: el('brushColor').value || '#161a20',
      pressure: el('brushPressure').checked,
      smooth: el('brushSmooth').checked,
      symmetry: el('brushSymmetry').value || 'none'
    };
  }

  function renderBrushFromStatus(next) {
    var settings = brushSettings();
    var nib = el('brushNib');
    nib.style.width = Math.min(26, Math.max(5, settings.size * 0.7)) + 'px';
    nib.style.height = nib.style.width;
    nib.style.background = settings.color;
    el('brushTitle').textContent = settings.pressure ? 'Sketch nib' : 'Constant nib';
    el('brushFacts').textContent =
      settings.size +
      ' px · ' +
      (settings.pressure ? 'pressure taper' : 'constant width') +
      ' · ' +
      (settings.smooth ? 'smoothed' : 'polyline') +
      (settings.symmetry === 'none' ? '' : ' · ' + settings.symmetry + ' symmetry') +
      ' · ' +
      Math.round(settings.opacity * 100) +
      '%';
    el('brushSizeOut').textContent = String(settings.size);
    el('brushOpacityOut').textContent = Math.round(settings.opacity * 100) + '%';
    var pointer = pointerCandidate(next);
    if (pointer && pointer.kind === 'brush') {
      el('brushFacts').textContent += ' · last ' + (pointer.label || 'stroke');
    }
  }

  /* ── Overlay ─────────────────────────────────────────────────────────── */

  function setSvgHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  function activeRegion(bounds) {
    agentRegion = bounds || null;
    drawRegionBox(bounds);
  }

  function drawRegionBox(bounds) {
    var box = el('regionBox');
    var handles = el('cropHandles');
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) {
      setSvgHidden(box, true);
      setSvgHidden(handles, true);
      return;
    }
    box.setAttribute('x', String(bounds.x));
    box.setAttribute('y', String(bounds.y));
    box.setAttribute('width', String(bounds.width));
    box.setAttribute('height', String(bounds.height));
    setSvgHidden(box, false);
    var size = 8;
    var corners = [
      ['nw', bounds.x, bounds.y],
      ['ne', bounds.x + bounds.width, bounds.y],
      ['se', bounds.x + bounds.width, bounds.y + bounds.height],
      ['sw', bounds.x, bounds.y + bounds.height]
    ];
    Array.prototype.forEach.call(handles.querySelectorAll('[data-handle]'), function (handle) {
      var name = handle.getAttribute('data-handle');
      var corner = corners.filter(function (entry) {
        return entry[0] === name;
      })[0];
      if (!corner) return;
      handle.setAttribute('x', String(corner[1] - size / 2));
      handle.setAttribute('y', String(corner[2] - size / 2));
    });
    setSvgHidden(handles, false);
  }

  function drawSelectionBox(selection) {
    var box = el('selectionBox');
    var bounds = selection ? selection.bounds : null;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      setSvgHidden(box, true);
      return;
    }
    box.setAttribute('x', String(bounds.x));
    box.setAttribute('y', String(bounds.y));
    box.setAttribute('width', String(bounds.width));
    box.setAttribute('height', String(bounds.height));
    setSvgHidden(box, false);
  }

  function placeOverlay() {
    var size = canvasSize();
    if (!size.width || !size.height) return;
    var overlay = el('overlay');
    overlay.setAttribute('viewBox', '0 0 ' + size.width + ' ' + size.height);
    overlay.setAttribute('preserveAspectRatio', 'none');
    drawSelectionBox(status && status.selection);
    drawRegionBox(pendingCrop || agentRegion);
  }

  function setCursorTrail(points) {
    var trail = el('trail');
    if (!points || points.length < 2) {
      trail.removeAttribute('points');
      delete trail.dataset.points;
      setSvgHidden(trail, true);
      return;
    }
    // Both forms are deliberate: the attribute is what the SVG renders, and the
    // dataset copy is the geometry readout the pointer simulation asserts on.
    trail.setAttribute('points', points);
    trail.dataset.points = points;
    setSvgHidden(trail, false);
  }

  function placeHalo(radius, x, y, opacity) {
    var halo = el('halo');
    if (!radius) {
      setSvgHidden(halo, true);
      return;
    }
    halo.setAttribute('r', String(radius));
    if (x !== undefined) {
      halo.setAttribute('cx', String(x));
      halo.setAttribute('cy', String(y));
    }
    halo.setAttribute('opacity', String(opacity === undefined ? 1 : opacity));
    setSvgHidden(halo, false);
  }

  function placeCursor(x, y) {
    var cursor = el('cursor');
    cursor.style.left = x * 100 + '%';
    cursor.style.top = y * 100 + '%';
    cursor.classList.toggle('label-left', x > 0.78);
    cursor.classList.toggle('label-up', y > 0.82);
  }

  function showMarquee(rect) {
    var live = el('marqueeLive');
    if (!rect || rect.width < 1 || rect.height < 1) {
      live.hidden = true;
      return;
    }
    live.style.left = rect.left + 'px';
    live.style.top = rect.top + 'px';
    live.style.width = rect.width + 'px';
    live.style.height = rect.height + 'px';
    live.hidden = false;
  }

  function pulseAt(x, y) {
    var size = canvasSize();
    if (!size.width || !size.height) return;
    var pulse = el('pulse');
    pulse.setAttribute('cx', String(x * size.width));
    pulse.setAttribute('cy', String(y * size.height));
    pulse.setAttribute('r', '14');
    pulse.classList.remove('is-live');
    setSvgHidden(pulse, false);
    void pulse.getBoundingClientRect();
    pulse.classList.add('is-live');
    window.setTimeout(function () {
      pulse.classList.remove('is-live');
      setSvgHidden(pulse, true);
    }, 700);
  }

  /* ── Cursor glyphs ───────────────────────────────────────────────────── */

  var DARK = '#10151d';
  var LIGHT = '#ffffff';

  function strokePath(d, width) {
    return (
      '<path d="' +
      d +
      '" fill="none" stroke="' +
      DARK +
      '" stroke-width="' +
      (width + 1.6) +
      '" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="' +
      d +
      '" fill="none" stroke="' +
      LIGHT +
      '" stroke-width="' +
      width +
      '" stroke-linecap="round" stroke-linejoin="round"/>'
    );
  }

  var CURSORS = {
    arrow:
      '<path d="M3.5 2.8 20 12l-7.4 1.6L9.2 21z" fill="' +
      LIGHT +
      '" stroke="' +
      DARK +
      '" stroke-width="1.5" stroke-linejoin="round"/>',
    brush:
      '<circle cx="12" cy="12" r="7.4" fill="none" stroke="' +
      DARK +
      '" stroke-width="3"/>' +
      '<circle cx="12" cy="12" r="7.4" fill="none" stroke="' +
      LIGHT +
      '" stroke-width="1.4"/>' +
      '<circle cx="12" cy="12" r="1.5" fill="' +
      LIGHT +
      '" stroke="' +
      DARK +
      '" stroke-width=".9"/>',
    marquee: strokePath(
      'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16',
      1.7
    ),
    lasso:
      strokePath('M12 5c-4.6 0-7 2.6-7 5.2 0 2.4 2 4.1 4.4 4.1 1.9 0 3.2-1 3.2-2.4 0-1.2-.9-2-2-2', 1.6) +
      '<circle cx="11" cy="19" r="1.6" fill="' +
      LIGHT +
      '" stroke="' +
      DARK +
      '" stroke-width="1"/>',
    type: strokePath('M7 4h10M7 20h10M12 4v16', 1.8),
    move: strokePath('M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3', 1.5),
    crop: strokePath('M7 3v14h14M3 7h14v14', 1.8),
    shape: strokePath('M4.5 4.5h15v15h-15z', 1.6),
    line: strokePath('M4 20 19 5', 1.8) + '<circle cx="19" cy="5" r="1.8" fill="' + LIGHT + '"/>',
    wand:
      strokePath('M4 20 14 10', 2) +
      '<path d="M17 3l.9 2.6L21 6.5l-2.6.9L17 10l-.9-2.6L13.5 6.5l2.6-.9z" fill="' +
      LIGHT +
      '" stroke="' +
      DARK +
      '" stroke-width="1"/>',
    adjust:
      strokePath('M5 7h14M5 12h14M5 17h14', 1.6) +
      '<circle cx="9" cy="7" r="2.1" fill="' + LIGHT + '" stroke="' + DARK + '" stroke-width="1"/>' +
      '<circle cx="15" cy="12" r="2.1" fill="' + LIGHT + '" stroke="' + DARK + '" stroke-width="1"/>' +
      '<circle cx="11" cy="17" r="2.1" fill="' + LIGHT + '" stroke="' + DARK + '" stroke-width="1"/>',
    '3d':
      strokePath('M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6zM12 3.2v8.8M12 12l8-4.4M12 12 4 7.6', 1.35),
    rotate:
      '<path d="M20 12a8 8 0 1 1-2.3-5.6" fill="none" stroke="' + DARK + '" stroke-width="3.2" stroke-linecap="round"/>' +
      '<path d="M20 12a8 8 0 1 1-2.3-5.6" fill="none" stroke="' + LIGHT + '" stroke-width="1.7" stroke-linecap="round"/>' +
      '<path d="M20 3.4v4.2h-4.2" fill="none" stroke="' + LIGHT + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    transform: strokePath('M4 6h16M4 18h16M6 4v16M18 4v16', 1.4),
    history: strokePath('M4 12a8 8 0 1 0 2.4-5.7', 1.7) + strokePath('M4 4v4h4', 1.7) + strokePath('M12 8v4.4l3 1.8', 1.5),
    export: strokePath('M12 3v11M8 10l4 4 4-4M5 19h14', 1.7),
    image:
      strokePath('M3.5 4.5h17v15h-17z', 1.5) +
      '<circle cx="8.4" cy="9" r="1.4" fill="' + LIGHT + '"/>' +
      strokePath('M4 17l4.6-4.4 3.6 3.4 3.2-3 5 4', 1.4)
  };

  function setCursorGlyph(kind) {
    var glyph = CURSORS[kind] || CURSORS.arrow;
    var node = el('cursorGlyph');
    if (node.getAttribute('data-kind') === kind) return;
    node.setAttribute('data-kind', kind);
    node.innerHTML = glyph;
  }

  /* ── Pointer geometry ────────────────────────────────────────────────── */

  function pointerCandidate(next) {
    if (next.activePointer && next.activePointer.path && next.activePointer.path.length) {
      return next.activePointer;
    }
    var history = next.history || [];
    for (var index = history.length - 1; index >= 0; index -= 1) {
      if (history[index] && history[index].pointer) return history[index].pointer;
    }
    return null;
  }

  function pointerKey(pointer) {
    var path = pointer.path || [];
    var first = path.length ? path[0].join(',') : '';
    var last = path.length ? path[path.length - 1].join(',') : '';
    return [
      pointer.id || '',
      pointer.mode || '',
      pointer.label || '',
      (pointer.segments || []).length,
      path.length,
      first + '>' + last,
      pointer.region ? JSON.stringify(pointer.region) : ''
    ].join('|');
  }

  function catmull(points, steps) {
    if (points.length < 2) return points.slice();
    var out = [];
    var at = function (index) {
      return points[Math.max(0, Math.min(points.length - 1, index))];
    };
    for (var index = 0; index < points.length - 1; index += 1) {
      var p0 = at(index - 1);
      var p1 = at(index);
      var p2 = at(index + 1);
      var p3 = at(index + 2);
      for (var step = 0; step < steps; step += 1) {
        var t = step / steps;
        var t2 = t * t;
        var t3 = t2 * t;
        out.push([
          0.5 *
            (2 * p1[0] +
              (-p0[0] + p2[0]) * t +
              (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
              (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 *
            (2 * p1[1] +
              (-p0[1] + p2[1]) * t +
              (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
              (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
        ]);
      }
    }
    out.push(points[points.length - 1].slice());
    return out;
  }

  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function pointerTrack(pointer, size) {
    var raw =
      Array.isArray(pointer.segments) && pointer.segments.length
        ? pointer.segments
        : [{ points: pointer.path || [], smooth: pointer.smooth === true }];
    var track = [];
    raw.forEach(function (segment) {
      var points = (segment && Array.isArray(segment.points) ? segment.points : [])
        .filter(function (point) {
          return (
            Array.isArray(point) &&
            Number.isFinite(Number(point[0])) &&
            Number.isFinite(Number(point[1]))
          );
        })
        .map(function (point) {
          return [Number(point[0]) / size.width, Number(point[1]) / size.height];
        });
      if (!points.length) return;
      var smooth = segment.smooth === true && points.length > 2 ? catmull(points, 10) : points;
      var pressures = Array.isArray(segment.pressure) ? segment.pressure : null;
      for (var index = 0; index < smooth.length && track.length < 1400; index += 1) {
        var t = smooth.length > 1 ? index / (smooth.length - 1) : 0;
        var pressure = 1;
        if (pressures && pressures.length > 1) {
          var scaled = t * (pressures.length - 1);
          var low = Math.floor(scaled);
          var high = Math.min(pressures.length - 1, low + 1);
          pressure = pressures[low] + (pressures[high] - pressures[low]) * (scaled - low);
        }
        track.push({ x: smooth[index][0], y: smooth[index][1], p: pressure });
      }
    });
    return track;
  }

  function queueLength() {
    return pointerQueue.length;
  }

  function enqueuePointer(pointer) {
    // A fast agent can produce several pointers between frames. Keep the queue
    // short: the cursor is a live instrument, not a recording, and replaying a
    // backlog would make it lag behind the document it is describing.
    if (pointerQueue.length >= 5) pointerQueue = pointerQueue.slice(-3);
    pointerQueue.push(pointer);
    if (!pointerBusy) runPointerQueue();
  }

  function runPointerQueue() {
    var pointer = pointerQueue.shift();
    if (!pointer) {
      pointerBusy = false;
      if (!drag) restingStatus();
      return;
    }
    pointerBusy = true;
    animatePointer(pointer, function () {
      window.setTimeout(runPointerQueue, pointerQueue.length ? 60 : 0);
    });
  }

  function animatePointer(pointer, done) {
    var size = canvasSize();
    if (!size.width || !size.height) {
      done();
      return;
    }
    var track = pointerTrack(pointer, size);
    if (!track.length) {
      done();
      return;
    }

    var cursor = el('cursor');
    var kind = pointer.kind || 'arrow';
    var mode = pointer.mode || (kind === 'brush' ? 'stroke' : 'drag');
    setCursorGlyph(kind);
    el('cursorLabel').textContent = pointer.label || kind;
    cursor.hidden = false;
    cursor.classList.add('is-on');
    el('cursor').classList.remove('show-label');
    void cursor.offsetWidth;
    cursor.classList.add('show-label');
    if (labelTimer) clearTimeout(labelTimer);
    labelTimer = window.setTimeout(function () {
      cursor.classList.remove('show-label');
    }, 2200);
    setState(pointer.label ? 'Agent · ' + pointer.label : 'Agent is working', 'busy');

    // A pointer starts where the previous one ended when there is one, so a
    // sequence of edits reads as one hand moving. The first pointer starts at
    // its own geometry rather than from an invented approach point: the cursor
    // is evidence of where the work is, not a decorative entrance.
    var start = lastCursor || { x: track[0].x, y: track[0].y, p: track[0].p };
    var points = [{ x: start.x, y: start.y, p: track[0].p }].concat(track);
    var distances = [0];
    var total = 0;
    for (var index = 1; index < points.length; index += 1) {
      var dx = (points[index].x - points[index - 1].x) * size.width;
      var dy = (points[index].y - points[index - 1].y) * size.height;
      total += Math.sqrt(dx * dx + dy * dy) || 0;
      distances.push(total);
    }
    if (total < 0.5) {
      placeCursor(points[points.length - 1].x, points[points.length - 1].y);
      finishPointer(pointer, mode, points[points.length - 1], done);
      return;
    }

    var duration = REDUCED ? 0 : clamp(420 + track.length * 14, 320, 1900);
    var radius = Number(pointer.radius) || 0;
    var bounds = pointer.region || boundsOfPath(pointer.path);

    // The geometry is published before the cursor moves: a viewer can see the
    // whole path the agent is taking, and the cursor travels along it. This is
    // also what makes a sketch legible as one gesture instead of a line that
    // grows while the rest of the drawing is still unknown.
    var rawPath = (pointer.path || [])
      .filter(function (entry) {
        return Array.isArray(entry) && Number.isFinite(Number(entry[0])) && Number.isFinite(Number(entry[1]));
      })
      .map(function (entry) {
        return entry[0] + ',' + entry[1];
      })
      .join(' ');
    setCursorTrail(rawPath);
    if (radius) placeHalo(radius, track[0].x * size.width, track[0].y * size.height);
    if (bounds) {
      agentRegion = bounds;
      drawRegionBox(bounds);
    }

    function pointAtDistance(distance) {
      var low = 0;
      var high = distances.length - 1;
      while (low < high - 1) {
        var middle = (low + high) >> 1;
        if (distances[middle] <= distance) low = middle;
        else high = middle;
      }
      var span = distances[high] - distances[low] || 1;
      var ratio = clamp((distance - distances[low]) / span, 0, 1);
      return {
        x: points[low].x + (points[high].x - points[low].x) * ratio,
        y: points[low].y + (points[high].y - points[low].y) * ratio,
        p: points[low].p + (points[high].p - points[low].p) * ratio,
        index: high
      };
    }

    function frame(t) {
      var eased = easeInOut(clamp(t, 0, 1));
      var point = pointAtDistance(total * eased);
      placeCursor(point.x, point.y);
      el('cursorCoords').textContent =
        Math.round(point.x * size.width) + ', ' + Math.round(point.y * size.height);
      if (radius) {
        // Pressure is the brush's width, not a pulse: a light landing reads as a
        // thin halo and the body of the stroke as the full diameter.
        placeHalo(radius * (0.75 + point.p * 0.25), point.x * size.width, point.y * size.height);
      }
      if (t < 1) {
        requestAnimationFrame(frame);
        return;
      }
      finishPointer(pointer, mode, point, done);
    }

    if (REDUCED) {
      var end = points[points.length - 1];
      placeCursor(end.x, end.y);
      finishPointer(pointer, mode, end, done);
      return;
    }

    var began = performance.now();
    requestAnimationFrame(function step(now) {
      var t = clamp((now - began) / duration, 0, 1);
      frame(t);
    });
  }

  function finishPointer(pointer, mode, point, done) {
    var size = canvasSize();
    lastCursor = { x: point.x, y: point.y };
    el('cursorCoords').textContent =
      Math.round(point.x * size.width) + ', ' + Math.round(point.y * size.height);
    var cursor = el('cursor');
    cursor.classList.add('show-coords');
    window.setTimeout(function () {
      cursor.classList.remove('show-coords');
    }, 1600);
    if (!REDUCED) pulseAt(point.x, point.y);
    var region = pointer.region || (mode === 'crop' || mode === 'marquee' ? boundsOfPath(pointer.path) : null);
    if (region) {
      agentRegion = region;
      drawRegionBox(region);
    }
    if (trailClearTimer) clearTimeout(trailClearTimer);
    trailClearTimer = window.setTimeout(function () {
      setCursorTrail(null);
      if (mode === 'stroke') placeHalo(0);
      // The crop frame the agent drew is a marker, not a pending edit: clear it
      // unless the user has a frame of their own to keep.
      if (!pendingCrop) {
        agentRegion = null;
        drawRegionBox(null);
      }
    }, 2400);
    setState(pointer.label ? 'Agent · ' + pointer.label : 'Agent is working', null);
    done();
  }

  function boundsOfPath(path) {
    if (!Array.isArray(path) || !path.length) return null;
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    path.forEach(function (point) {
      if (!Array.isArray(point)) return;
      minX = Math.min(minX, Number(point[0]));
      minY = Math.min(minY, Number(point[1]));
      maxX = Math.max(maxX, Number(point[0]));
      maxY = Math.max(maxY, Number(point[1]));
    });
    if (!Number.isFinite(minX) || maxX <= minX) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function restingStatus() {
    if (!status || !status.loaded) {
      setState('Waiting for the agent', null);
      return;
    }
    if (scene.on) {
      setState(scene.lastStatus || '3D preview · drag to orbit', null);
      return;
    }
    var latest = latestHistory();
    if (latest) {
      setState(toolName(latest.tool) + ' · ' + latest.summary, null);
      return;
    }
    setState('Document ready · ' + status.width + ' × ' + status.height, null);
  }

  /* ── Canvas coordinates ──────────────────────────────────────────────── */

  function canvasPoint(event) {
    var plate = el('plate');
    var rect = plate.getBoundingClientRect();
    var size = canvasSize();
    if (!rect.width || !rect.height || !size.width || !size.height) return null;
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * size.width, 0, size.width),
      y: clamp(((event.clientY - rect.top) / rect.height) * size.height, 0, size.height)
    };
  }

  function localPoint(event) {
    var plate = el('plate');
    var rect = plate.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function rectFromPoints(a, b) {
    var x = Math.min(a.x, b.x);
    var y = Math.min(a.y, b.y);
    var width = Math.abs(a.x - b.x);
    var height = Math.abs(a.y - b.y);
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }

  function bindCanvas() {
    var plate = el('plate');

    plate.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || !status || !status.loaded || scene.on) return;
      var point = canvasPoint(event);
      if (!point) return;

      if (armed === 'wand') {
        event.preventDefault();
        callTool(
          'photo_select',
          {
            action: 'wand',
            x: Math.round(point.x),
            y: Math.round(point.y),
            tolerance: num(el('wandTolerance').value, 32)
          },
          'Magic wand at ' + Math.round(point.x) + ',' + Math.round(point.y)
        );
        return;
      }

      if (armed === 'fill') {
        event.preventDefault();
        var fillSettings = brushSettings();
        var fillArgs = {
          commands: [
            {
              type: 'fill',
              x: Math.round(point.x),
              y: Math.round(point.y),
              color: fillSettings.color,
              tolerance: clamp(num(el('fillTolerance').value, 32), 0, 255),
              contiguous: true,
              opacity: fillSettings.opacity
            }
          ]
        };
        var fillTarget = paintTarget();
        if (fillTarget) fillArgs.target = fillTarget;
        callTool(
          'photo_draw',
          fillArgs,
          'Bucket fill at ' + Math.round(point.x) + ',' + Math.round(point.y)
        );
        return;
      }

      if (armed === 'brush') {
        event.preventDefault();
        try {
          plate.setPointerCapture(event.pointerId);
        } catch (error) {
          /* capture is an enhancement */
        }
        drag = { kind: 'brush', id: event.pointerId };
        brushPoints = [[Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10]];
        el('cursor').classList.remove('show-label');
        return;
      }

      if (armed === 'marquee' || armed === 'crop' || armed === 'gradient') {
        event.preventDefault();
        try {
          plate.setPointerCapture(event.pointerId);
        } catch (error) {
          /* capture is an enhancement */
        }
        drag = {
          kind: armed,
          id: event.pointerId,
          start: point,
          startLocal: localPoint(event),
          current: point
        };
        showMarquee({
          left: drag.startLocal.x,
          top: drag.startLocal.y,
          width: 0,
          height: 0
        });
        return;
      }
    });

    plate.addEventListener('pointermove', function (event) {
      var point = canvasPoint(event);
      if (point) {
        el('coords').textContent =
          Math.round(point.x) + ', ' + Math.round(point.y) + ' px';
      }
      if (!drag || drag.id !== event.pointerId || !point) return;

      if (drag.kind === 'brush') {
        var last = brushPoints[brushPoints.length - 1];
        if (!last) return;
        var dx = point.x - last[0];
        var dy = point.y - last[1];
        if (dx * dx + dy * dy < 2.2) return;
        brushPoints.push([Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10]);
        var local = localPoint(event);
        showMarquee({ left: local.x - 6, top: local.y - 6, width: 12, height: 12 });
        return;
      }

      drag.current = point;
      var startLocal = drag.startLocal;
      var nowLocal = localPoint(event);
      showMarquee({
        left: Math.min(startLocal.x, nowLocal.x),
        top: Math.min(startLocal.y, nowLocal.y),
        width: Math.abs(nowLocal.x - startLocal.x),
        height: Math.abs(nowLocal.y - startLocal.y)
      });
    });

    function finish(event) {
      if (!drag || drag.id !== event.pointerId) return;
      var current = drag;
      drag = null;
      showMarquee(null);
      try {
        plate.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* already released */
      }

      if (current.kind === 'brush') {
        var points = brushPoints.slice();
        brushPoints = [];
        if (points.length === 1) {
          points.push([points[0][0] + 0.6, points[0][1] + 0.6]);
        }
        if (points.length < 2) return;
        var settings = brushSettings();
        var drawArgs = {
          commands: [
            {
              type: 'sketch',
              symmetry: settings.symmetry === 'none' ? undefined : settings.symmetry,
              strokes: [
                {
                  points: points,
                  width: settings.size,
                  color: settings.color,
                  opacity: settings.opacity,
                  pressure: settings.pressure,
                  smooth: settings.smooth
                }
              ]
            }
          ]
        };
        var targetLayer = rasterLayerId();
        if (targetLayer) drawArgs.target = { layer: targetLayer };
        callTool('photo_draw', drawArgs, 'Sketch ' + points.length + ' samples');
        return;
      }

      if (current.kind === 'gradient') {
        var start = current.start;
        var end = current.current;
        if (Math.abs(end.x - start.x) < 2 && Math.abs(end.y - start.y) < 2) {
          setState('Drag a gradient direction across the canvas.', null);
          return;
        }
        var gradientSettings = brushSettings();
        var size = canvasSize();
        var gradientArgs = {
          commands: [
            {
              type: 'gradient',
              shape: el('gradientShape').value || 'linear',
              from: [Math.round(start.x * 10) / 10, Math.round(start.y * 10) / 10],
              to: [Math.round(end.x * 10) / 10, Math.round(end.y * 10) / 10],
              x: 0,
              y: 0,
              width: size.width,
              height: size.height,
              colors: [gradientSettings.color, el('gradientEnd').value || '#ffffff'],
              opacity: gradientSettings.opacity
            }
          ]
        };
        var gradientTarget = paintTarget();
        if (gradientTarget) gradientArgs.target = gradientTarget;
        callTool(
          'photo_draw',
          gradientArgs,
          (el('gradientShape').value === 'radial' ? 'Radial' : 'Linear') + ' gradient'
        );
        return;
      }

      var rect = rectFromPoints(current.start, current.current);
      if (rect.width < 2 || rect.height < 2) return;
      if (current.kind === 'marquee') {
        callTool(
          'photo_select',
          {
            action: 'rect',
            rect: rect,
            feather: num(el('selectFeather').value, 0)
          },
          'Marquee ' + rect.width + ' × ' + rect.height
        );
        return;
      }
      pendingCrop = rect;
      activeRegion(rect);
      el('cropReadout').textContent = rect.width + ' × ' + rect.height + ' at ' + rect.x + ',' + rect.y;
      el('cropConfirm').hidden = false;
      setState('Crop frame ready · photo_edit has not run yet', null);
    }

    plate.addEventListener('pointerup', finish);
    plate.addEventListener('pointercancel', finish);
    plate.addEventListener('pointerleave', function () {
      if (!drag) el('coords').textContent = '—';
    });

    el('cropCancel').addEventListener('click', function () {
      pendingCrop = null;
      agentRegion = null;
      drawRegionBox(null);
      el('cropConfirm').hidden = true;
      setState('Crop cancelled · nothing changed', null);
    });
    el('cropApply').addEventListener('click', function () {
      if (!pendingCrop) return;
      var rect = pendingCrop;
      pendingCrop = null;
      agentRegion = null;
      drawRegionBox(null);
      el('cropConfirm').hidden = true;
      callTool('photo_edit', { crop: rect }, 'Crop ' + rect.width + ' × ' + rect.height);
    });
  }

  /* ── Layer and panel controls ────────────────────────────────────────── */

  function targetLayerId() {
    var layer = activeLayer();
    return layer ? layer.id : undefined;
  }

  function bindPanelControls() {
    if (el('textProps')) {
      el('textProps').addEventListener('click', function (event) {
        var textApply = event.target.closest('[data-text]');
        if (!textApply) return;
        var textLayer = activeLayer();
        if (!textLayer || textLayer.kind !== 'text') return;
        callTool(
          'photo_text',
          {
            action: 'set',
            target: { layer: textLayer.id },
            content: el('textContent').value,
            size: num(el('textSize').value, 48),
            color: el('textColor').value,
            x: num(el('textX').value, 0),
            y: num(el('textY').value, 0)
          },
          'Text · ' + textLayer.name
        );
      });
    }
    el('layers').addEventListener('click', function (event) {
      var styleToggle = event.target.closest('[data-style-toggle]');
      if (styleToggle) {
        event.stopPropagation();
        var styleLayerId = styleToggle.getAttribute('data-style-layer');
        var layerWithStyle = ((status && status.layers) || []).filter(function (candidate) {
          return candidate.id === styleLayerId;
        })[0];
        var style = layerWithStyle
          ? (layerWithStyle.styles || []).filter(function (candidate) {
              return candidate.id === styleToggle.getAttribute('data-style-toggle');
            })[0]
          : null;
        if (!style) return;
        callTool(
          'photo_style',
          {
            action: 'set',
            target: { layer: styleLayerId },
            styleId: style.id,
            enabled: style.enabled === false
          },
          (style.enabled === false ? 'Enable ' : 'Disable ') + styleShortName(style.type)
        );
        return;
      }
      var styleRemove = event.target.closest('[data-style-remove]');
      if (styleRemove) {
        event.stopPropagation();
        callTool(
          'photo_style',
          {
            action: 'remove',
            target: { layer: styleRemove.getAttribute('data-style-layer') },
            styleId: styleRemove.getAttribute('data-style-remove')
          },
          'Remove layer style'
        );
        return;
      }
      var styleAdd = event.target.closest('[data-style-add]');
      if (styleAdd) {
        event.stopPropagation();
        callTool(
          'photo_style',
          { action: 'add', target: { layer: styleAdd.getAttribute('data-style-add') }, type: 'dropShadow' },
          'Add drop shadow'
        );
        return;
      }
      var eye = event.target.closest('[data-visible]');
      if (eye) {
        event.stopPropagation();
        var id = eye.getAttribute('data-visible');
        var layer = ((status && status.layers) || []).filter(function (candidate) {
          return candidate.id === id;
        })[0];
        if (!layer) return;
        callTool(
          'photo_layer',
          { action: 'set', target: { layer: id }, visible: !layer.visible },
          (layer.visible ? 'Hide ' : 'Show ') + layer.name
        );
        return;
      }
      var row = event.target.closest('[data-layer]');
      if (!row) return;
      callTool('photo_layer', { action: 'select', target: { layer: row.getAttribute('data-layer') } }, 'Select layer');
    });

    el('blendMode').addEventListener('change', function () {
      var id = targetLayerId();
      if (!id) return;
      callTool(
        'photo_layer',
        { action: 'set', target: { layer: id }, blendMode: el('blendMode').value },
        'Blend · ' + el('blendMode').value
      );
    });

    el('layerOpacity').addEventListener('input', function () {
      el('layerOpacityOut').textContent = el('layerOpacity').value + '%';
    });
    el('layerOpacity').addEventListener('change', function () {
      var id = targetLayerId();
      if (!id) return;
      callTool(
        'photo_layer',
        {
          action: 'set',
          target: { layer: id },
          opacity: num(el('layerOpacity').value, 100) / 100
        },
        'Opacity · ' + el('layerOpacity').value + '%'
      );
    });

    document.querySelector('.layer-tools').addEventListener('click', function (event) {
      var button = event.target.closest('[data-layer-action]');
      if (!button) return;
      var action = button.getAttribute('data-layer-action');
      var id = targetLayerId();
      if (action === 'mask') {
        if (!id) return;
        callTool('photo_mask', { action: 'create', target: { layer: id } }, 'Mask from selection');
        return;
      }
      if (!id) return;
      if (action === 'mergeDown' || action === 'flatten') {
        callTool('photo_layer', { action: action, target: { layer: id } }, action === 'flatten' ? 'Flatten' : 'Merge down');
        return;
      }
      callTool('photo_layer', { action: action, target: { layer: id } }, action + ' layer');
    });

    el('adjustQuick').addEventListener('click', function (event) {
      var button = event.target.closest('[data-adjust]');
      if (!button) return;
      var kind = button.getAttribute('data-adjust');
      var map = {
        auto: [{ type: 'autoTone', mode: 'contrast', clip: 0.5 }],
        bw: [{ type: 'blackAndWhite' }],
        invert: [{ type: 'invert' }],
        warm: [{ type: 'whiteBalance', temperature: 7800, tint: 8 }],
        cool: [{ type: 'whiteBalance', temperature: 5200, tint: -6 }],
        punch: [{ type: 'vibrance', amount: 28 }, { type: 'clarity', amount: 18 }],
        soften: [{ type: 'gaussianBlur', radius: 2.4 }],
        sharpen: [{ type: 'unsharpMask', amount: 110, radius: 1.2, threshold: 2 }]
      };
      callTool(
        'photo_adjust',
        {
          asLayer: true,
          name: button.textContent,
          adjustments: map[kind],
          target: el('adjSelection').checked ? { selection: true } : undefined
        },
        button.textContent
      );
    });

    el('adjApply').addEventListener('click', function () {
      var stops = num(el('adjExposure').value, 0);
      var contrast = num(el('adjContrast').value, 0);
      var saturation = num(el('adjSaturation').value, 0);
      var temperature = num(el('adjTemperature').value, 6500);
      var adjustments = [];
      if (stops) adjustments.push({ type: 'exposure', stops: stops });
      if (contrast) adjustments.push({ type: 'brightnessContrast', brightness: 0, contrast: contrast });
      if (saturation) adjustments.push({ type: 'hueSaturation', saturation: saturation });
      if (temperature !== 6500) adjustments.push({ type: 'whiteBalance', temperature: temperature });
      if (!adjustments.length) {
        notify('Move a slider first — the stack is empty.', 'error');
        return;
      }
      var nonDestructive = el('adjLayer').checked;
      callTool(
        'photo_adjust',
        {
          asLayer: nonDestructive,
          name: nonDestructive ? 'Grade' : undefined,
          adjustments: adjustments,
          target: el('adjSelection').checked ? { selection: true } : undefined
        },
        'Adjustment stack · ' + adjustments.length
      );
    });

    el('selectFeather').addEventListener('change', function () {
      el('selectFeather').value = String(clamp(num(el('selectFeather').value, 0), 0, 400));
    });
    el('wandTolerance').addEventListener('input', function () {
      el('wandToleranceOut').textContent = el('wandTolerance').value;
    });

    document.querySelector('[data-panel="select"]').addEventListener('click', function (event) {
      var button = event.target.closest('[data-select]');
      if (!button) return;
      var action = button.getAttribute('data-select');
      if (action === 'feather') {
        callTool(
          'photo_select',
          { action: 'modify', feather: num(el('selectFeather').value, 6) },
          'Feather selection'
        );
        return;
      }
      if (action === 'grow' || action === 'contract') {
        callTool(
          'photo_select',
          { action: 'modify', [action]: num(el('selectGrow').value, 4) },
          button.textContent + ' selection'
        );
        return;
      }
      if (action === 'save') {
        var name = el('selectName').value.trim();
        if (!name) {
          notify('Name the selection first.', 'error');
          return;
        }
        callTool('photo_select', { action: 'save', name: name }, 'Save selection ' + name);
        return;
      }
      callTool('photo_select', { action: action }, button.textContent + ' selection');
    });

    el('savedSelections').addEventListener('click', function (event) {
      var button = event.target.closest('[data-load-selection]');
      if (!button) return;
      var name = button.getAttribute('data-load-selection');
      callTool('photo_select', { action: 'load', name: name }, 'Load selection ' + name);
    });

    el('history').addEventListener('click', function (event) {
      var row = event.target.closest('[data-history-index]');
      if (!row) return;
      stepHistory(
        Number(row.getAttribute('data-history-index')),
        row.getAttribute('data-applied') === '1'
      );
    });

    document.querySelector('[data-panel="history"]').addEventListener('click', function (event) {
      var button = event.target.closest('[data-history]');
      if (!button) return;
      var action = button.getAttribute('data-history');
      callTool('photo_history', { action: action }, action === 'undo' ? 'Undo' : 'Redo');
    });

    el('brushSize').addEventListener('input', function () {
      renderBrushFromStatus(status || {});
    });
    el('brushOpacity').addEventListener('input', function () {
      renderBrushFromStatus(status || {});
    });
    el('brushColor').addEventListener('input', function () {
      el('brushColorHex').value = el('brushColor').value;
      renderBrushFromStatus(status || {});
      markSwatch(el('brushColor').value);
    });
    el('brushColorHex').addEventListener('change', function () {
      var value = el('brushColorHex').value.trim();
      if (/^#[0-9a-f]{6}$/i.test(value)) {
        el('brushColor').value = value;
        renderBrushFromStatus(status || {});
        markSwatch(value);
      } else {
        el('brushColorHex').value = el('brushColor').value;
        notify('Use a #rrggbb colour.', 'error');
      }
    });
    el('brushPressure').addEventListener('change', function () {
      renderBrushFromStatus(status || {});
    });
    el('brushSmooth').addEventListener('change', function () {
      renderBrushFromStatus(status || {});
    });
    el('brushSymmetry').addEventListener('change', function () {
      renderBrushFromStatus(status || {});
    });

    var swatches = ['#161a20', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#30b0c7', '#007aff', '#af52de', '#ff2d55'];
    el('swatches').innerHTML = swatches
      .map(function (color) {
        return (
          '<button type="button" data-swatch="' +
          color +
          '" style="background:' +
          color +
          '" aria-label="' +
          color +
          '" title="' +
          color +
          '"></button>'
        );
      })
      .join('');
    el('swatches').addEventListener('click', function (event) {
      var button = event.target.closest('[data-swatch]');
      if (!button) return;
      var color = button.getAttribute('data-swatch');
      el('brushColor').value = color;
      el('brushColorHex').value = color;
      markSwatch(color);
      renderBrushFromStatus(status || {});
    });
    markSwatch('#161a20');
  }

  function markSwatch(color) {
    Array.prototype.forEach.call(el('swatches').querySelectorAll('[data-swatch]'), function (button) {
      button.setAttribute(
        'aria-pressed',
        button.getAttribute('data-swatch').toLowerCase() === String(color).toLowerCase() ? 'true' : 'false'
      );
    });
  }

  /* ── Native 3D text and effects ───────────────────────────────────────── */

  // The UI needs the same defaults and ranges the native validator enforces.
  // Keeping the table here means the sidebar can build its controls without a
  // second round trip, and the values it sends are exactly the tool's schema.
  function effectRange(key, label, min, max, step, value, unit) {
    return { key: key, label: label, type: 'range', min: min, max: max, step: step, value: value, unit: unit || '' };
  }
  function effectSelect(key, label, value, options) {
    return { key: key, label: label, type: 'select', value: value, options: options };
  }
  function effectColor(key, label, value) {
    return { key: key, label: label, type: 'color', value: value };
  }
  function effectToggle(key, label, value) {
    return { key: key, label: label, type: 'check', value: value };
  }

  var EFFECTS = {
    radialBlur: {
      label: 'Radial blur',
      fields: [
        effectRange('amount', 'Amount', 1, 200, 1, 30, 'px'),
        effectRange('centerX', 'Center X', 0, 1, 0.01, 0.5),
        effectRange('centerY', 'Center Y', 0, 1, 0.01, 0.5),
        effectRange('samples', 'Samples', 4, 64, 1, 16),
      ],
    },
    zoomBlur: {
      label: 'Zoom blur',
      fields: [
        effectRange('amount', 'Amount', 0, 1, 0.01, 0.15),
        effectRange('centerX', 'Center X', 0, 1, 0.01, 0.5),
        effectRange('centerY', 'Center Y', 0, 1, 0.01, 0.5),
        effectRange('samples', 'Samples', 4, 64, 1, 18),
      ],
    },
    motionBlur: {
      label: 'Motion blur',
      fields: [
        effectRange('distance', 'Distance', 1, 200, 1, 24, 'px'),
        effectRange('angle', 'Angle', 0, 360, 1, 0, '°'),
        effectRange('samples', 'Samples', 4, 64, 1, 18),
      ],
    },
    lensDistortion: {
      label: 'Lens distortion',
      fields: [
        effectRange('k1', 'K1', -1, 1, 0.01, -0.25),
        effectRange('k2', 'K2', -1, 1, 0.01, 0),
        effectRange('scale', 'Scale', 0.5, 2, 0.01, 1),
      ],
    },
    whirl: {
      label: 'Whirl',
      fields: [
        effectRange('angle', 'Angle', -720, 720, 5, 120, '°'),
        effectRange('radius', 'Radius', 0.05, 1.5, 0.01, 0.45),
        effectRange('centerX', 'Center X', 0, 1, 0.01, 0.5),
        effectRange('centerY', 'Center Y', 0, 1, 0.01, 0.5),
      ],
    },
    kaleidoscope: {
      label: 'Kaleidoscope',
      fields: [
        effectRange('segments', 'Mirrors', 3, 24, 1, 8),
        effectRange('angle', 'Angle', 0, 360, 1, 0, '°'),
        effectRange('centerX', 'Center X', 0, 1, 0.01, 0.5),
        effectRange('centerY', 'Center Y', 0, 1, 0.01, 0.5),
        effectRange('zoom', 'Zoom', 0.2, 3, 0.01, 1),
      ],
    },
    mosaic: {
      label: 'Mosaic',
      fields: [effectRange('cell', 'Cell', 2, 128, 1, 12, 'px')],
    },
    stainedGlass: {
      label: 'Stained glass',
      fields: [
        effectRange('cell', 'Cell', 6, 96, 1, 22, 'px'),
        effectRange('jitter', 'Jitter', 0, 1, 0.01, 0.8),
        effectRange('edge', 'Edge', 0, 10, 0.5, 1.5, 'px'),
        effectColor('edgeColor', 'Edge ink', '#0b0d11'),
      ],
    },
    oilify: {
      label: 'Oil paint',
      fields: [
        effectRange('radius', 'Radius', 1, 5, 1, 2),
        effectRange('levels', 'Levels', 8, 64, 1, 24),
      ],
    },
    halftone: {
      label: 'Halftone',
      fields: [
        effectRange('cell', 'Cell', 2, 64, 1, 8, 'px'),
        effectRange('angle', 'Angle', 0, 180, 1, 15, '°'),
        effectColor('ink', 'Ink', '#000000'),
      ],
    },
    dither: {
      label: 'Dither',
      fields: [
        effectRange('levels', 'Levels', 2, 8, 1, 2),
        effectSelect('mode', 'Mode', 'mono', ['mono', 'color']),
        effectToggle('serpentine', 'Serpentine', true),
      ],
    },
    pixelSort: {
      label: 'Pixel sort',
      fields: [
        effectRange('threshold', 'Threshold', 0, 255, 1, 128),
        effectSelect('direction', 'Direction', 'horizontal', ['horizontal', 'vertical']),
        effectRange('minLength', 'Min run', 2, 512, 1, 4, 'px'),
        effectToggle('reverse', 'Reverse', false),
      ],
    },
    glow: {
      label: 'Glow',
      fields: [
        effectRange('threshold', 'Threshold', 0, 255, 1, 190),
        effectRange('radius', 'Radius', 1, 80, 1, 12, 'px'),
        effectRange('intensity', 'Intensity', 0, 3, 0.05, 0.8),
      ],
    },
    wave: {
      label: 'Wave',
      fields: [
        effectRange('amplitude', 'Amplitude', 1, 100, 1, 12, 'px'),
        effectRange('wavelength', 'Wavelength', 4, 400, 1, 48, 'px'),
        effectRange('phase', 'Phase', 0, 360, 1, 0, '°'),
        effectSelect('axis', 'Axis', 'both', ['horizontal', 'vertical', 'both']),
      ],
    },
    glitch: {
      label: 'Glitch',
      fields: [
        effectRange('slices', 'Slices', 2, 64, 1, 12),
        effectRange('amount', 'Shift', 0, 120, 1, 24, 'px'),
        effectRange('rgbSplit', 'RGB split', 0, 60, 1, 8, 'px'),
        effectRange('seed', 'Seed', 0, 9999, 1, 1),
      ],
    },
    chromaticAberration: {
      label: 'Chromatic aberration',
      fields: [
        effectRange('amount', 'Amount', 0, 40, 1, 6, 'px'),
        effectRange('angle', 'Angle', 0, 360, 1, 0, '°'),
      ],
    },
    pencilSketch: {
      label: 'Pencil sketch',
      fields: [
        effectRange('strength', 'Strength', 0, 100, 1, 80),
        effectRange('detail', 'Detail', 1, 8, 1, 3, 'px'),
        effectRange('paper', 'Paper', 0, 100, 1, 20),
        effectToggle('invert', 'White on black', false),
        effectRange('seed', 'Seed', 0, 9999, 1, 11),
      ],
    },
    posterEdges: {
      label: 'Poster edges',
      fields: [
        effectRange('levels', 'Levels', 2, 12, 1, 6),
        effectRange('edge', 'Edge', 0, 5, 0.1, 1.5),
        effectColor('edgeColor', 'Edge ink', '#000000'),
        effectRange('saturation', 'Saturation', 0, 200, 1, 110, '%'),
      ],
    },
    watercolor: {
      label: 'Watercolour',
      fields: [
        effectRange('radius', 'Wash', 1, 6, 1, 3),
        effectRange('levels', 'Pigment levels', 6, 32, 1, 14),
        effectRange('edge', 'Pencil edge', 0, 3, 0.1, 0.8),
        effectRange('paper', 'Paper', 0, 100, 1, 15),
        effectRange('seed', 'Seed', 0, 9999, 1, 5),
      ],
    },
    paperGrain: {
      label: 'Paper grain',
      fields: [
        effectRange('amount', 'Amount', 0, 100, 1, 35),
        effectRange('scale', 'Scale', 1, 20, 1, 4, 'px'),
        effectRange('fiber', 'Fibre', 0, 100, 1, 50),
        effectRange('seed', 'Seed', 0, 9999, 1, 7),
      ],
    },
  };

  var nativePreviewStamps = { fonts: '', target: '' };

  function rangeText(value, step, unit) {
    var parsed = Number(value);
    var decimals = step < 0.01 ? 3 : step < 1 ? 2 : 0;
    return parsed.toFixed(decimals) + (unit || '');
  }

  function effectFieldHtml(field) {
    var key = 'data-param="' + field.key + '"';
    if (field.type === 'range') {
      return (
        '<label class="field row"><span>' +
        field.label +
        '</span><input ' +
        key +
        ' data-unit="' +
        (field.unit || '') +
        '" type="range" min="' +
        field.min +
        '" max="' +
        field.max +
        '" step="' +
        field.step +
        '" value="' +
        field.value +
        '"><output>' +
        rangeText(field.value, field.step, field.unit) +
        '</output></label>'
      );
    }
    if (field.type === 'select') {
      return (
        '<label class="field"><span>' +
        field.label +
        '</span><select ' +
        key +
        '>' +
        field.options
          .map(function (option) {
            return (
              '<option value="' +
              option +
              '"' +
              (option === field.value ? ' selected' : '') +
              '>' +
              option.replace(/-/g, ' ') +
              '</option>'
            );
          })
          .join('') +
        '</select></label>'
      );
    }
    if (field.type === 'color') {
      return (
        '<label class="field"><span>' +
        field.label +
        '</span><input ' +
        key +
        ' type="color" value="' +
        field.value +
        '"></label>'
      );
    }
    return (
      '<label class="check"><input ' +
      key +
      ' type="checkbox"' +
      (field.value ? ' checked' : '') +
      '> ' +
      field.label +
      '</label>'
    );
  }

  function renderEffectFields() {
    var select = el('effectType');
    if (!select) return;
    var type = select.value || 'radialBlur';
    var definition = EFFECTS[type] || EFFECTS.radialBlur;
    el('effectParams').innerHTML = definition.fields.map(effectFieldHtml).join('');
  }

  function readEffectParams() {
    var params = {};
    Array.prototype.forEach.call(el('effectParams').querySelectorAll('[data-param]'), function (input) {
      var key = input.getAttribute('data-param');
      if (!key) return;
      if (input.type === 'checkbox') params[key] = input.checked;
      else if (input.tagName === 'SELECT' || input.type === 'color') params[key] = input.value;
      else params[key] = Number(input.value);
    });
    return params;
  }

  function syncRangeOutput(input) {
    if (!input || input.type !== 'range') return;
    var output = input.parentNode ? input.parentNode.querySelector('output') : null;
    if (!output) return;
    output.textContent = rangeText(input.value, Number(input.step) || 1, input.getAttribute('data-unit') || '');
  }

  function text3dSettings() {
    var text = el('text3dText').value.trim();
    if (!text) {
      notify('Type the text to extrude first.', 'error');
      return null;
    }
    return {
      text: text,
      font: el('text3dFont').value.trim() || 'sans-serif',
      weight: Number(el('text3dWeight').value) || 700,
      depth: Number(el('text3dDepth').value),
      bevel: Number(el('text3dBevel').value),
      twist: Number(el('text3dTwist').value),
      camera: {
        yaw: Number(el('text3dYaw').value),
        pitch: Number(el('text3dPitch').value),
      },
      material: {
        mode: el('text3dMaterial').value,
        face: el('text3dFace').value,
        side: el('text3dSide').value,
        bevel: el('text3dBevelColor').value,
        gradient: el('text3dGradient').checked,
        faceTop: el('text3dFaceTop').value,
        faceBottom: el('text3dFaceBottom').value,
      },
      shadow: { enabled: el('text3dShadow').checked },
    };
  }

  function text3dPreviewSize() {
    var size = canvasSize();
    var aspect = size.width && size.height ? size.width / size.height : 1.5;
    var width = 900;
    var height = Math.round(width / aspect);
    if (height > 760) {
      height = 760;
      width = Math.round(height * aspect);
    }
    return { width: clamp(width, 240, 1400), height: clamp(height, 200, 900) };
  }

  function previewText3d() {
    var settings = text3dSettings();
    if (!settings) return;
    var size = text3dPreviewSize();
    callTool(
      'photo_text3d',
      Object.assign({ action: 'preview', width: size.width, height: size.height }, settings),
      '3D text preview',
      { apply: false }
    ).then(function (payload) {
      if (!payload || !payload.image) return;
      el('text3dPreview').src = payload.image;
      el('text3dPreviewWrap').hidden = false;
      el('text3dStats').textContent =
        settings.text.split(/\r?\n/)[0].slice(0, 28) +
        ' · ' +
        payload.width +
        ' × ' +
        payload.height +
        ' · ' +
        Math.max(1, Math.round(payload.renderMs)) +
        ' ms · native C++';
      setState('3D text preview · ' + payload.width + ' × ' + payload.height + ' · view only', null);
    });
  }

  function renderText3d() {
    if (!status || !status.loaded) {
      notify('Import an image first; the 3D text renders into the document.', 'error');
      return;
    }
    var settings = text3dSettings();
    if (!settings) return;
    callTool(
      'photo_text3d',
      Object.assign({ action: 'render' }, settings),
      'Add 3D text layer'
    ).then(function (payload) {
      if (!payload) return;
      el('text3dStats').textContent = 'Added to the layer stack · one undo step';
      el('text3dPreviewWrap').hidden = false;
      notify('3D text added to the document', 'ok');
    });
  }

  function previewEffect() {
    if (!status || !status.loaded) {
      notify('Import an image first.', 'error');
      return;
    }
    var target = rasterLayerId();
    if (!target) {
      notify('No raster layer to preview. Import or add one first.', 'error');
      return;
    }
    var type = el('effectType').value;
    var definition = EFFECTS[type] || EFFECTS.radialBlur;
    var args = Object.assign(
      { effect: type, target: { layer: target }, preview: true, previewSize: 900 },
      readEffectParams()
    );
    callTool('photo_effect', args, 'Effect preview · ' + definition.label, { apply: false }).then(
      function (payload) {
        if (!payload || !payload.image) return;
        el('effectPreview').src = payload.image;
        el('effectPreviewWrap').hidden = false;
        el('effectStats').textContent =
          definition.label +
          ' · ' +
          payload.width +
          ' × ' +
          payload.height +
          ' · ' +
          Math.max(1, Math.round(payload.renderMs)) +
          ' ms · preview only';
        setState('Effect preview · ' + definition.label + ' · view only', null);
      }
    );
  }

  function applyEffect() {
    if (!status || !status.loaded) {
      notify('Import an image first.', 'error');
      return;
    }
    var target = rasterLayerId();
    if (!target) {
      notify('No raster layer to edit.', 'error');
      return;
    }
    var type = el('effectType').value;
    var definition = EFFECTS[type] || EFFECTS.radialBlur;
    var args = Object.assign({ effect: type, target: { layer: target } }, readEffectParams());
    callTool('photo_effect', args, 'Apply ' + definition.label).then(function (payload) {
      if (!payload) return;
      el('effectStats').textContent = definition.label + ' applied · one undo step';
      notify(definition.label + ' applied to the active layer', 'ok');
    });
  }

  function renderNativePanels(next) {
    var families = ['sans-serif', 'serif', 'monospace', 'Georgia', 'Impact'];
    (next.fonts || []).forEach(function (font) {
      if (font && font.family && families.indexOf(font.family) === -1) families.push(font.family);
    });
    var fontStamp = families.join('|');
    if (fontStamp !== nativePreviewStamps.fonts) {
      nativePreviewStamps.fonts = fontStamp;
      el('text3dFonts').innerHTML = families
        .map(function (family) {
          return '<option value="' + escapeHtml(family) + '"></option>';
        })
        .join('');
    }

    var target = rasterLayerId();
    var layer = target
      ? (next.layers || []).filter(function (candidate) {
          return candidate.id === target;
        })[0]
      : null;
    var targetLabel = layer ? layer.name || layer.id : 'none — add a raster layer';
    if (targetLabel !== nativePreviewStamps.target) {
      nativePreviewStamps.target = targetLabel;
      el('effectTarget').textContent = targetLabel;
    }
  }

  function bindNativePanels() {
    var effectSelect = el('effectType');
    if (!effectSelect) return;
    effectSelect.innerHTML = Object.keys(EFFECTS)
      .map(function (key) {
        return '<option value="' + key + '">' + EFFECTS[key].label + '</option>';
      })
      .join('');
    renderEffectFields();

    effectSelect.addEventListener('change', function () {
      renderEffectFields();
      el('effectPreviewWrap').hidden = true;
    });

    el('effectParams').addEventListener('input', function (event) {
      syncRangeOutput(event.target);
      if (!el('effectPreviewWrap').hidden) {
        el('effectStats').textContent = 'Settings changed · preview again';
      }
    });

    var effectPreviewButton = el('effectPreviewBtn');
    if (effectPreviewButton) effectPreviewButton.addEventListener('click', previewEffect);
    var effectApplyButton = el('effectApplyBtn');
    if (effectApplyButton) effectApplyButton.addEventListener('click', applyEffect);

    var textPanel = document.querySelector('[data-panel="text3d"]');
    if (textPanel) {
      textPanel.addEventListener('input', function (event) {
        syncRangeOutput(event.target);
        if (!el('text3dPreviewWrap').hidden) {
          el('text3dStats').textContent = 'Settings changed · preview again';
        }
      });
    }
    el('text3dPreviewBtn').addEventListener('click', previewText3d);
    el('text3dRenderBtn').addEventListener('click', renderText3d);
  }

  /* ── 3D scene ────────────────────────────────────────────────────────── */

  function currentSceneStamp() {
    var data = status && status.scene3d;
    if (!data) return '';
    return JSON.stringify({
      model: data.model,
      object: data.object,
      camera: data.camera,
      light: data.light,
      environment: data.environment,
      ground: data.ground,
      render: data.render
    });
  }

  function sceneAvailable() {
    return Boolean(status && status.scene3d);
  }

  function orbitText() {
    if (!scene.orbit) return 'Framing…';
    var yaw = Math.round(((scene.orbit.yaw % 360) + 360) % 360);
    return (
      yaw + '° yaw · ' + Math.round(scene.orbit.pitch) + '° pitch · ' + scene.orbit.zoom.toFixed(2) + '×'
    );
  }

  function updateSceneChrome() {
    var toggle = el('sceneToggle');
    if (!toggle) return;
    var available = sceneAvailable();
    if (!available) scene.on = false;
    toggle.hidden = !available;
    toggle.setAttribute('aria-pressed', scene.on ? 'true' : 'false');
    toggle.classList.toggle('is-on', scene.on);
    el('sceneView').hidden = !scene.on;
    el('stage').classList.toggle('is-scene', scene.on);
    if (status && status.loaded) el('plate').hidden = scene.on;
    el('sceneImage').classList.toggle('is-ready', Boolean(scene.src));
    el('orbitReadout').textContent = orbitText();
  }

  function setSceneLoader(text, visible) {
    var loader = el('sceneLoader');
    loader.textContent = text;
    loader.hidden = !visible;
  }

  function sceneData(response) {
    if (!response || response.ok === false) {
      throw new Error((response && response.error) || 'The editor could not render the preview.');
    }
    var result = response.result || {};
    var data = result.data && result.data.structuredContent;
    if (!data || !data.image) throw new Error('The preview response contained no image.');
    return data;
  }

  function scheduleScenePreview(delay, quality) {
    if (scene.timer) clearTimeout(scene.timer);
    scene.timer = setTimeout(function () {
      scene.timer = null;
      requestScenePreview(quality || 'draft');
    }, delay);
  }

  function scheduleSceneRefine(delay) {
    if (scene.refine) clearTimeout(scene.refine);
    scene.refine = setTimeout(function () {
      scene.refine = null;
      requestScenePreview('final');
    }, delay);
  }

  function requestScenePreview(quality, reset) {
    if (!scene.on || !sceneAvailable()) return;
    if (scene.busy) {
      if (quality === 'final' || !scene.queued) scene.queued = quality;
      return;
    }
    if (reset) {
      scene.orbit = null;
      scene.src = '';
      el('sceneImage').removeAttribute('src');
      updateSceneChrome();
    }
    scene.busy = true;
    var serial = ++scene.serial;
    if (!scene.src) setSceneLoader('Rendering native 3D preview…', true);
    else setSceneLoader('Refining 3D preview…', false);
    var payload = {
      action: 'preview',
      width: 720,
      height: 540,
      quality: quality === 'draft' ? 'draft' : 'final'
    };
    if (scene.orbit) {
      payload.orbit = { yaw: scene.orbit.yaw, pitch: scene.orbit.pitch, zoom: scene.orbit.zoom };
    }
    api.tools
      .call('photo_3d', payload)
      .then(function (response) {
        if (serial !== scene.serial || !scene.on) return;
        var data = sceneData(response);
        scene.orbit = {
          yaw: Number(data.orbit.yaw),
          pitch: Number(data.orbit.pitch),
          zoom: Number(data.orbit.zoom)
        };
        scene.src = data.image;
        var image = el('sceneImage');
        image.src = data.image;
        image.alt =
          '3D preview of ' +
          ((status.scene3d.model && status.scene3d.model.name) || 'the model') +
          ' — drag to orbit';
        setSceneLoader('', false);
        scene.lastStatus =
          '3D preview · ' +
          data.width +
          ' × ' +
          data.height +
          ' · ' +
          Math.max(1, Math.round(data.renderMs)) +
          ' ms';
        setState(scene.lastStatus, null);
        updateSceneChrome();
      })
      .catch(function (error) {
        if (serial !== scene.serial || !scene.on) return;
        scene.lastStatus = '3D preview unavailable';
        setSceneLoader('Preview unavailable · ' + ((error && error.message) || 'render failed'), true);
        setState('3D preview unavailable · ' + ((error && error.message) || 'render failed'), 'error');
      })
      .then(function () {
        if (serial !== scene.serial) return;
        scene.busy = false;
        var queued = scene.queued;
        scene.queued = null;
        if (queued && scene.on) requestScenePreview(queued);
      });
  }

  function resetScenePreview() {
    if (!scene.on) return;
    scene.orbit = null;
    scene.src = '';
    el('sceneImage').removeAttribute('src');
    setSceneLoader('Framing native 3D preview…', true);
    setState('Framing 3D preview…', 'busy');
    updateSceneChrome();
    requestScenePreview('final');
  }

  function setSceneMode(active) {
    if (active && !sceneAvailable()) return;
    if (active === scene.on) return;
    scene.on = active;
    if (scene.on) {
      scene.stamp = currentSceneStamp();
      updateSceneChrome();
      setState(scene.src ? scene.lastStatus : 'Framing 3D preview…', 'busy');
      requestScenePreview('final', !scene.src && !scene.orbit);
      return;
    }
    scene.serial += 1;
    scene.busy = false;
    scene.queued = null;
    scene.drag = null;
    el('sceneView').classList.remove('is-dragging');
    if (scene.timer) clearTimeout(scene.timer);
    if (scene.refine) clearTimeout(scene.refine);
    scene.timer = null;
    scene.refine = null;
    updateSceneChrome();
    layout();
    restingStatus();
  }

  function bindSceneControls() {
    var toggle = el('sceneToggle');
    var image = el('sceneImage');
    if (!toggle || !image) return;
    toggle.addEventListener('click', function () {
      setSceneMode(!scene.on);
    });
    image.addEventListener('pointerdown', function (event) {
      if (!scene.on || !scene.orbit || event.button !== 0) return;
      event.preventDefault();
      scene.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      try {
        image.setPointerCapture(event.pointerId);
      } catch (error) {
        /* pointer capture is an enhancement */
      }
      el('sceneView').classList.add('is-dragging');
    });
    image.addEventListener('pointermove', function (event) {
      if (!scene.drag || event.pointerId !== scene.drag.id || !scene.orbit) return;
      var dx = event.clientX - scene.drag.x;
      var dy = event.clientY - scene.drag.y;
      scene.drag.x = event.clientX;
      scene.drag.y = event.clientY;
      scene.orbit.yaw += dx * 0.35;
      scene.orbit.pitch = Math.max(-80, Math.min(80, scene.orbit.pitch + dy * 0.28));
      updateSceneChrome();
      scheduleScenePreview(80, 'draft');
      scheduleSceneRefine(360);
    });
    function endDrag(event) {
      if (!scene.drag || event.pointerId !== scene.drag.id) return;
      scene.drag = null;
      el('sceneView').classList.remove('is-dragging');
      scheduleSceneRefine(100);
    }
    image.addEventListener('pointerup', endDrag);
    image.addEventListener('pointercancel', endDrag);
    image.addEventListener(
      'wheel',
      function (event) {
        if (!scene.on || !scene.orbit) return;
        event.preventDefault();
        scene.orbit.zoom = Math.max(0.25, Math.min(4, scene.orbit.zoom * Math.exp(event.deltaY * 0.0012)));
        updateSceneChrome();
        scheduleScenePreview(70, 'draft');
        scheduleSceneRefine(360);
      },
      { passive: false }
    );
    image.addEventListener('dblclick', function (event) {
      event.preventDefault();
      resetScenePreview();
    });
    el('sceneReset').addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      resetScenePreview();
    });
  }

  /* ── Polling ─────────────────────────────────────────────────────────── */

  function poll() {
    api.tools
      .call('photo_status', { sinceRevision: lastRevision })
      .then(function (response) {
        if (!response || response.ok === false) {
          failures += 1;
          setState(
            failures > 2
              ? 'The editor is not running. Reopen PhotoNext to reconnect.'
              : 'Starting the editor…',
            failures > 2 ? 'error' : null
          );
          schedule(failures > 2 ? 2600 : 1200);
          return;
        }
        var result = response.result || {};
        var data = result.data || result;
        if (data && data.isError) {
          failures += 1;
          setState(((data.content || [])[0] || {}).text || 'The editor refused photo_status.', 'error');
          schedule(2000);
          return;
        }
        var next = data && (data.structuredContent || data.payload || data);
        if (!next) {
          failures += 1;
          setState('The editor returned no status. Reopen it to reconnect.', 'error');
          schedule(2600);
          return;
        }

        failures = 0;
        var changed = next.revision !== lastRevision;
        render(next);
        lastRevision = next.revision;
        schedule(changed || next.activePointer ? POLL_BUSY_MS : POLL_IDLE_MS);
      })
      .catch(function () {
        failures += 1;
        setState('Starting the editor…', null);
        schedule(1500);
      });
  }

  /* ── Chrome wiring ───────────────────────────────────────────────────── */

  // The panel's own X. It asks the host to put this sidebar away and nothing
  // else: the extension process, the document and the agent's work continue,
  // so reopening the panel in this chat returns to the same edit.
  var closeButton = el('closePanel');
  if (closeButton) {
    closeButton.addEventListener('click', function () {
      closeButton.disabled = true;
      api.close().then(function (response) {
        if (!response || !response.ok) closeButton.disabled = false;
      });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (button) {
    button.addEventListener('click', function () {
      selectTab(button.getAttribute('data-tab'), false);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-zoom]'), function (button) {
    button.addEventListener('click', function () {
      zoomMode = button.getAttribute('data-zoom');
      Array.prototype.forEach.call(document.querySelectorAll('[data-zoom]'), function (other) {
        other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      });
      layout();
    });
  });

  el('toolrail').addEventListener('click', function (event) {
    var button = event.target.closest('[data-tool]');
    if (button) armTool(button.getAttribute('data-tool'));
  });

  el('adjExposure').addEventListener('input', function () {
    el('adjExposureOut').textContent = Number(el('adjExposure').value).toFixed(2);
  });
  el('adjContrast').addEventListener('input', function () {
    el('adjContrastOut').textContent = el('adjContrast').value;
  });
  el('adjSaturation').addEventListener('input', function () {
    el('adjSaturationOut').textContent = el('adjSaturation').value;
  });
  el('adjTemperature').addEventListener('input', function () {
    el('adjTemperatureOut').textContent = el('adjTemperature').value + 'K';
  });

  bindCanvas();
  bindPanelControls();
  bindNativePanels();
  bindSceneControls();
  renderToolrail();
  renderBrushFromStatus({});

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) schedule(120);
  });

  window.addEventListener('beforeunload', function () {
    if (timer) clearTimeout(timer);
    if (labelTimer) clearTimeout(labelTimer);
    if (trailClearTimer) clearTimeout(trailClearTimer);
    if (scene.timer) clearTimeout(scene.timer);
    if (scene.refine) clearTimeout(scene.refine);
  });

  api.onReady(function () {
    setState('Connecting to the editor…', null);
    poll();
  });
})();
