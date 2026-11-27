# PhotoNext

PhotoNext owns one document: a canvas with a layer stack (nested groups, blend
modes, opacity, masks, offsets, non-destructive layer styles, editable text
layers), a selection, an activity log, an undo history, a
small font library, one optional 3D scene, native 3D text, a native effect
engine and a set of LUT looks. The tools are the edit surface, backed by a
read-only inspection layer (`photo_describe`, `photo_find`, `photo_bounds`,
`photo_sample`, `photo_region`, `photo_diff`); the right sidebar beside the
thread is a Photoshop-style cockpit that renders that document. It is not a work
tab and never owns the center column.

The cockpit is **agent-owned and agent-first**. It opens itself the moment any
`photo_*` tool runs — there is no need to call `extensions.open` first — and the
user's Tools row for it is a status line, not a button. Every control in it is a
view of a tool: layer rows call `photo_layer`, style chips call `photo_style`,
the adjustment stack calls `photo_adjust`, the brush calls `photo_draw`, and the
history list calls `photo_history`. Nothing in the panel edits the document directly, so what you
see in `photo_status` and what the sidebar shows are the same document. You can
drive every control from a tool call, and the panel reflects it on the next
poll. Its simulated pointer follows your latest action, with a pressure-aware
brush halo for strokes, a marquee for selections, a crop frame for geometry, a
transform outline and an I-beam for text.

## Workflow

1. `photo_import` with the absolute path of the image. Chat attachments and files
   in the task workspace already arrive as paths. The source is copied and never
   modified.
2. `photo_select` when the edit is local: `rect`, `ellipse`, `polygon`, `wand`
   (flood fill from `x`/`y` with `tolerance`), `colorRange`, `all`, `none`,
   `invert`, `modify` (grow, contract, smooth, border, feather), and named
   `save`/`load`. A selection is a coverage mask, so `photo_adjust` with
   `target.selection: true` clips to it.
3. `photo_edit` for geometry, in the fixed order rotate → flip → skew →
   perspective → crop → resize → canvas → trim.
   - `rotate` takes any clockwise angle; 90/180/270 stay exact quarter turns.
     An arbitrary angle expands the canvas unless `rotateFit: "crop"`.
   - `skew` shears by up to ±60° per axis; `perspective` maps the four source
     corners to `corners` (topLeft, topRight, bottomRight, bottomLeft) at an
     explicit `width`/`height`.
   - `crop` is measured in the transformed image, so `(0,0)` is its top-left.
   - `resize` takes `fit`: `stretch` (default), `fit`, `fill` (crop to cover) or
     `pad` (extend the canvas).
   - `canvas` resizes with a 9-point `anchor` and a `background`; `trim` removes
     a uniform or transparent border.
4. `photo_adjust` for tone, colour and focus. `adjustments` is an array of
   `{ "type": ... }` objects; they run in a fixed engine order, not list order.
   - Tone: `curves`, `levels`, `exposure`, `brightnessContrast`, `gamma`,
     `shadowsHighlights`, `autoTone`, `posterize`, `threshold`, `invert`
   - Colour: `whiteBalance`, `hueSaturation` (master or one band: reds, oranges,
     yellows, greens, aquas, blues, purples, magentas), `vibrance`,
     `colorBalance`, `channelMixer`, `blackAndWhite`, `grayscale`,
     `gradientMap`, `splitToning`, `photoFilter`, and `lut3d`
   - Focus: `gaussianBlur`, `boxBlur`, `medianBlur`, `motionBlur`,
     `unsharpMask`, `smartSharpen`, `clarity`, `dehaze`, `denoise`, `vignette`,
     `grain`
   Curves take `points` as `[x, y]` pairs in 0–255; levels take input/output
   black and white plus gamma; white balance takes `temperature` (Kelvin) and
   `tint`. `dehaze` and `clarity` are documented approximations, not physical
   models — say so if the user asks for exact dehazing. `denoise` is a bilateral
   pass (`strength` 0–100, `detail` 0–100); raise `detail` to keep texture.
   `lut3d` takes `lut` (an installed look from `photo_lut`) and `intensity`
   (0–100). Install a `.cube` file first: `photo_lut { action: "install", path:
   "/abs/look.cube", name: "teal-orange" }`.
   `target` controls scope: `"active"` (default), `"all"` raster layers, or a
   layer id; `target.selection` and `target.mask` compose.
5. `photo_draw` for marks that are not tone or geometry: smoothed brush strokes
   (`points`, `width`, `color`, solid/dashed/dotted `style`, round caps), a
   `sketch` command for many tapered freehand strokes in one call, lines and
   arrows, rectangles and ellipses (filled and/or stroked), polygons, and
   GIMP-style `fill` (fuzzy bucket fill from a seed) and `gradient` (linear or
   radial, two colours or up to 16 stops), plus
   multi-line `text` with `size`, `weight`, `font`, `align`, `letterSpacing` and
   clockwise `rotation`. Coordinates are pixels from the canvas top-left; text
   `y` is the baseline. A `photo_draw` text command is baked into the target
   raster layer; use `photo_text` instead when the type must stay editable. All commands in one call are one undoable entry; pass
   `target.selection: true` to clip a mark to the selection. A downloaded font
   is a normal `font` value after `photo_font install` returns its family. A `polygon` (or
   `compound`) may use `paths` instead of `points`: an array of point arrays with
   `fillRule: "evenodd"` for holes, so one command draws a car silhouette and its
   windows. `stroke` also accepts `paths` for several detail lines. Do not emit
   dozens of primitives for a simple object: one compound body plus one detail
   stroke is the intended shape of the call.
   - A `sketch` command is the rough-work path: `{ "type": "sketch", "strokes":
     [{ "points": [...], "width": 6, "color": "#161a20", "pressure": true }],
     "opacity": 0.9 }`. Up to 32 strokes, each optionally carrying its own
     `width`, `color`, `opacity`, `closed`, `smooth` and `pressure`. `pressure:
     true` tapers like a pen; an array of 0–1 samples sets a custom profile. Use
     one sketch command for a whole rough pass instead of one stroke command per
     line: one tool call, one history entry, and the panel animates all the
     strokes as a single sweep.
     Add `symmetry: "horizontal" | "vertical" | "quad" | "radial"` to mirror a
     whole pass in the same command. Horizontal mirrors across a vertical axis,
     vertical across a horizontal one, quad does both, and radial repeats around
     a centre (`segments` 2–16, default 6). `axisX` / `axisY` override the centre,
     which otherwise is the bounds of the supplied strokes.
   - A bucket fill is `{ "type": "fill", "x": 420, "y": 310, "color":
     "#e8482f", "tolerance": 28, "contiguous": true, "opacity": 1 }`. It floods
     the target layer from the seed; `tolerance` is 0–255 and `contiguous: false`
     fills every similar pixel. Seed and fill use canvas coordinates, so an
     offset layer needs no manual subtraction.
   - A gradient is `{ "type": "gradient", "shape": "linear", "from": [0, 0],
     "to": [1000, 0], "rect": { "x": 0, "y": 0, "width": 1000, "height": 500 },
     "colors": ["#000000", "#ffffff"] }`. `shape` may be `radial` (centre at
     `from`, radius to `to`), `colors` is shorthand for two stops, and `stops`
     accepts up to 16 `{ offset, color, opacity }` entries. A selection clips a
     fill or gradient, so use `target.selection: true` for a masked wash.
   - A clone stamp is `{ "type": "clone", "from": [420, 260], "points":
     [[560, 300], [600, 310]], "width": 60, "softness": 0.7 }`. `from` is the
     source point matching the first stroke sample; the engine copies from that
     offset along the stroke with a soft round falloff, so dust, a stray cable or
     a blemish goes away without a second layer. `offset` works instead of
     `from`, and `opacity` limits the strength.
6. Fonts: `photo_font install` with a `.ttf`/`.otf` URL downloads it into
   extension storage and returns `family`; `photo_font list` shows installed
   families. Pass that family to a text command or `photo_text` (`font: "Bebas
   Neue"`). The font stays in the extension data directory; it is not added to
   the host system. `photo_text create` is the editable-text path; `photo_draw`
   text commands bake their glyphs into the target raster layer.
   - `photo_layer select` makes a layer active without changing pixels. Use it
     before a series of edits whose `target` omits a layer id; the sidebar calls
     the same action when a layer row is clicked, so both surfaces agree about
     which layer is active.
7. Composing:
   - `photo_layer add` places an external image as a layer (centred unless `x`/
     `y` is given). `set` changes `blendMode` (26 modes: normal, multiply,
     screen, overlay, darken, lighten, colorDodge, colorBurn, hardLight,
     softLight, difference, exclusion, hue, saturation, color, luminosity, …),
     `opacity`, `visible`, `locked`, `name` or `offset`.
   - `photo_mask create` builds a layer mask from the selection (or all-white),
     then `paint`, `feather`, `invert`, `delete` or `apply`. `paint` takes a
     `rect`/`ellipse`, or a brush stroke with `points` (or `paths`) and `width`.
     A mask hides where it is black; both `photo_export` and the preview flatten it.
   - `mergeDown` and `flatten` bake the composite into one raster layer.
   - `photo_layer group` makes a group from `layers: [ids]`; `set parent` moves a
     layer in or out; `ungroup` keeps the children. See **Layer groups** below for
     the compositing and transform rules.
8. Non-destructive work stays non-destructive: `photo_adjust` with
   `asLayer: true` adds an **adjustment layer** that applies to every layer below
   it. Target it later with `target.layer` to change its stack without touching
   pixels; `photo_select … toMask` or `photo_mask` can clip it.
9. `photo_history` to undo or redo: `action: "undo"`, `"redo"` or `"list"`. Each
   edit is one entry and restores pixels, an adjustment spec, a mask, a
   selection or the layer stack. `photo_mask apply` is deliberately two entries
   (pixels, then mask removal). Re-read `photo_status` rather than assuming.
10. `photo_export` with an absolute destination path. This is the only step that
   writes outside the editor, so the user is asked before it runs. Export to the
   project's `artifacts/` unless the user named a different place. Pass
   `presets: ["ig_post", "ig_story"]` to write several named sizes from one
   flatten; `naming` accepts `{stem}`, `{preset}`, `{width}`, `{height}` and
   `{ext}` (default `{stem}-{preset}.{ext}`). The result lists every variant with
   its path and pixel size.

`photo_status` reads the document without changing it: dimensions, layer tree
(kind, blend mode, opacity, mask, offsets, styles), selection, saved selection names,
histogram (256 bins per channel plus luminance, with means and clipping), history
depth, blend modes and adjustment types, the 3D scene, native renderer
availability, capabilities and (when the revision changed) the preview. Use the
histogram and layer tree to verify an edit.

## Inspecting and verifying

Every tool returns an envelope: `revision_before` / `revision_after`,
`changed[{id, name, reasons, frame}]`, `created_ids`, `removed_ids`,
`selection_changed`, `warnings`, `no_op`, `undo_group` and `next_actions`. Read
`no_op` and `warnings` before claiming a change. These read-only tools answer
questions without re-reading the whole document:

- `photo_describe` (`detail: summary | standard | full`) — compact layer tree
  with ids, kinds, frames, text and (standard/full) style records; summary is
  enough for most turns.
- `photo_find` — resolve a layer by name fragment, kind, text or colour; an
  ambiguous query returns ranked candidates instead of guessing.
- `photo_bounds` — frame bbox and alpha-trimmed ink bbox, in pixels and 0–1
  normalized form. Centering by frame is usually wrong for a logo; use ink.
- `photo_sample` — RGBA/hex/luminance at up to 256 points, dominant palette, or
  histogram clipping and channel means.
- `photo_region` — a 1:1 or 2–4× crop with `bbox` and document mapping; fine text
  and hairlines disappear in the 1400 px preview.
- `photo_measure_text` — line breaks, ink box, overflow against `box`, contrast
  against a sampled background, and the size that fits.
- `photo_delta` (`sinceRevision`) — added, removed and changed layers only.
- `photo_diff` (`fromRevision`, `toRevision`) — changed bbox, changed-pixel
  share, MAE/RMSE/PSNR/SSIM and an optional heatmap. This is how to answer "did
  that actually change anything?".
- `photo_preflight` — preset dimensions, DPI, transparency, colour space,
  active layer styles and estimated bytes before an export.
- `photo_catalog` — effects, adjustments, styles, export presets and blend modes
  with parameter ranges and defaults; cheaper than guessing a parameter name.
- `photo_layout` — align, distribute and space layers by named anchors.
- `photo_recipe` — run several tool calls as one undo group with `$alias`
  references; `atomic: true` rolls the whole group back on failure.
- `photo_lut` — install, list, show and remove `.cube` looks.

Pass `if_revision` when the user may be editing the same document: a mismatch
returns `REVISION_CONFLICT` with the changed layers and a suggested call instead
of overwriting their work. `op_id` makes a retried call idempotent. Errors carry
`code`, `field`, `received`, `allowed`, `candidates` and `suggested_call`, so a
failed call usually has one obvious recovery.

## Layer groups

A group is an isolated compositing container, not a second document. Children
render bottom-to-top into a transparent buffer, then the group's blend mode,
opacity, mask and offset apply to that one composite. Groups nest (up to 8) and
may hold adjustment layers: an adjustment inside a group only sees layers below
it inside that group, while a top-level adjustment still sees the group result.

- `photo_layer group` takes `layers: [ids]` (all sharing one parent) and an
  optional `name`. It inserts the group above the topmost member and reparents
  them. Grouping a group with one of its own children is rejected.
- `photo_layer set parent: "<group id>"` moves a layer or group in;
  `parent: null` (or `"none"`) moves it back to the document root. A group
  cannot be moved inside itself or its own subtree.
- `set offset` on a group translates every descendant as one unit. `photo_layout`
  aligns and distributes groups by their union frame and writes that single
  offset, so a group never drifts from its children. `layers: "all"` in layout
  means top-level layers, not every child.
- `set visible`, `opacity` or `blendMode` on a group applies after the children
  composite. `photo_mask` on a group clips the whole group; `apply` is
  raster-only.
- `photo_bounds` reports a group's union frame and union ink box;
  `photo_describe` adds `parentId`, `depth` and `children` to every row.
- `ungroup` keeps the children and bakes the group offset into them. It refuses
  to run while the group has opacity below 1, a mask or a non-normal blend, so
  dissolving never silently changes the picture; reset those or flatten first.
- `delete` on a group deletes its children too; `duplicate` copies the whole
  subtree. Deleting the last layer or group is still undoable.

## Layer styles

Layer styles are persistent records on a raster layer or group, not baked
pixels. Any number can be stacked; each has an id, a type and an `enabled` flag,
and paints in list order. `photo_style` drives them:

- `add` with `type` and `params` appends a style (or inserts at `index`).
  `enabled: false` creates it switched off.
- `set` changes `params`, `enabled` or `index` for one `styleId`. With exactly
  one style, `styleId` may be omitted. A style's type never changes; remove and
  add instead.
- `remove` deletes one style; `list` reports every layer's styles without
  changing anything. `target.layer` is optional for `list`.

Types and parameters (`photo_catalog` section `"styles"` has the live ranges and
defaults):

| type | paints | parameters |
| --- | --- | --- |
| `dropShadow` | behind the alpha | `color`, `opacity` 0–1, `size` 0–100 blur, `distance` 0–500, `angle` −360–360, `spread` 0–100, `blend` |
| `outerGlow` | behind the alpha | `color`, `opacity`, `size`, `spread`, `hardness` 0–100, `blend` |
| `stroke` | outside the alpha edge | `color`, `opacity`, `size` 0.5–60, `blend` |
| `innerStroke` | inside the alpha edge | `color`, `opacity`, `size`, `blend` |
| `bevel` | inside the alpha | `highlight`, `shadow`, `opacity`, `size`, `angle`, `soften` 0–100, `blend` |

Angles are degrees clockwise, 0 = right and 90 = down. Colours accept hex or
`rgb()`/`rgba()`. Shadow and glow extend the rendered footprint; a raster layer
is padded internally so its effect is not clipped by its pixel buffer, while a
group effect is clipped only by the canvas.

- A style on a **group** paints against the group's isolated composite, after
  its children are rendered but before the group's own mask, opacity and blend
  mode. It is not copied to each child. A style on a layer is clipped by that
  layer's mask, then the layer's opacity and blend mode apply as usual.
- Styles compose with nesting and stacking: paint order is shadow/glow/stroke
  behind the layer, then the layer's own pixels, then bevel on top. A layer's
  derived shadow/stroke pixels are never written into the document; `flatten`,
  `mergeDown` and export rasterise them at that moment.
- Undo treats an added style plus its first parameter edit as one intent: undo
  removes the style, redo restores the edited style. Later edits are separate
  entries. Undoing a remove restores the exact prior style record, including its
  id and position.
- `photo_describe` (standard/full), `photo_status` layer rows, `photo_preflight`
  and `photo_delta` report styles; the cockpit lists a chip per style with a
  toggle and remove button, plus `+ style` to add a drop shadow, all through
  `photo_style`.
- Rejected targets are explicit: missing layer ids return `NOT_FOUND` with
  candidates and a `suggested_call`; adjustment layers cannot carry styles
  because they have no pixels of their own; locked layers must be unlocked
  first.
- `photo_bounds`, `photo_describe.frame` and a group's union frame measure stored
  pixels, not the extra canvas painted by a shadow or glow; allow room in the
  canvas or flatten before measuring a deliverable.

Out of scope for this version: smart filters, copying styles between layers,
styles on adjustment layers, contour/quality controls, texture and gradient
overlays, and multiple light sources. Bevel shades only inside the layer alpha;
it does not generate a height map from colour. A style whose blur reaches past
the canvas is clipped there.

## Editable text layers

A text layer is a real layer (`kind: "text"`) whose content is stored as a
record, not as pixels. `photo_text` owns it:

- `create` adds a layer. Required: `content` (or `text`). Every other field is
  optional. It becomes the active layer and appears in the layer tree.
- `set` changes fields on `target.layer` (default `active`). The result is a
  field edit; no raster is overwritten. `photo_text` does not accept a raster,
  adjustment or group layer: that target returns `INVALID_ARGUMENT` with the
text-layer candidates and `suggested_call: photo_text { action: "list" }`.
- `remove` deletes the text layer; undo restores the exact record, name and
  position. `list` reports every editable text layer and its frame without
  changing anything.

Fields and ranges:

| field | meaning |
| --- | --- |
| `content` / `text` | the string; newlines make lines; 1–2000 characters |
| `font` / `fontFamily` | family (default `sans-serif`); an installed `photo_font` family works |
| `size` | pixels, 4–2000, before scale |
| `weight` | 100–900 |
| `italic` | boolean (`style: "italic"` is an alias) |
| `lineHeight` | multiplier of the font size, 0.5–4 (default 1.25), not pixels |
| `letterSpacing` | tracking in pixels, −200–1000 |
| `align` | `left`, `center` or `right`; affects the baseline anchor |
| `color` / `fill` | hex, `rgb()`/`rgba()` or a named colour |
| `x`, `y` | baseline origin in document pixels; stored on the layer offset |
| `rotation` | clockwise degrees, −360–360, around the baseline origin |
| `scale` | uniform multiplier 0.05–4; `size × scale` must stay at or below 4000px |
| `name` | optional layer name; defaults to the first line |

`x`/`y` are the same fields `photo_layer set offset` changes, so a group offset,
`photo_layout` and ordinary layer movement apply to text without a second
coordinate system. The frame reported by `photo_describe`, `photo_status`,
`photo_bounds` and `photo_text list` is the rotated ink box around the baseline.

Compositing and styles:

- The engine rasterises the record at export/preview/flatten time through the
  same libvips SVG path as `photo_draw`, then composites it with the layer's
  opacity, blend mode and mask. Text has no cached pixels in the document.
- Text can carry any layer style without a restriction: drop shadow, outer glow,
  stroke, inner stroke and bevel all paint around or inside the glyph alpha.
  Styles on a group still paint against the group's isolated composite, not per
  child, and text inside that group is included in the composite.
- Masks clip the glyphs and their styles exactly as they clip a raster layer.
  `photo_layer delete/duplicate`, `photo_layer group`, `photo_layer set`
  (`visible`, `locked`, `opacity`, `blendMode`, `parent`, `offset`) and
  `photo_history` all work on text layers.
- `photo_text create` plus its first `set` is one undo step: undo removes the
  layer, redo restores the edited record. Later edits are separate undo entries.
  A removed text layer comes back with undo.
- `photo_adjust` and `photo_draw` need pixels and reject a text layer with a
  clear message. Change the text fields, or use `photo_layer mergeDown`/`flatten`
  to deliberately bake the rendered type into a raster layer.
- `photo_describe` standard/full includes `text` (all fields, line count,
  summary and transform); `photo_status` layer rows and the cockpit expose the
  same record. `photo_delta` reports `text` as a change reason, and
  `photo_preflight` reports editable text layers in the export.

Out of scope: rich-text runs inside one layer (one font/colour per layer),
text on a path, paragraph wrapping inside a fixed box, OpenType feature
switches, variable-font axes, and shape layers that stay editable. Those remain
baked through `photo_draw` or split across several text layers.

## 3D compositing

`photo_3d` has five actions. The model is copied into extension storage, so a
later render does not depend on the source file still being in place.

1. `photo_3d import` with an absolute `.glb` or `.gltf` path. It probes the model
   and returns mesh, primitive, triangle, material and texture counts plus its
   bounds. Prefer `.glb`; a `.gltf` is supported when its external buffers and
   images sit beside it, because those resources are copied too. Draco-compressed
   meshes are not decoded.
2. `photo_3d configure` changes only the sections you pass:
   - `object`: `position` and `rotation` are `[x, y, z]` (rotation degrees),
     `scale` (default 1), `placeOnGround` (default true).
   - `camera`: `auto` (default true), manual `position`, `target`, `fov`
     (35° default). Auto framing fits the object to the current canvas.
   - `light`: `direction` (the direction *toward* the light), `color`, `intensity`,
     `fill` and `rim` (sky bounce and edge light), `ambient`, `shadows`,
     `shadowOpacity`, `shadowSoftness`.
   - `environment`: `mode` `"transparent"` (default) or `"sky"`, plus `top`,
     `horizon`, `alpha`.
   - `ground`: `enabled`, `y`, `color`, `alpha`. The default is a pure shadow
     catcher: `alpha: 0` writes a soft black shadow with transparency and the
     ground plane itself stays invisible, so it composites over a photo.
   - `render`: `samples` 1–3 (2× supersampling default), `shadowMap` 256–2048,
     `exposure`.
3. `photo_3d preview` returns a view-only frame for the panel's 3D toggle.
   Pass `orbit: { yaw, pitch, zoom }`; `quality: "draft"` is fast while
   dragging and `"final"` refines the still. It does not change the document,
   history or scene, so the user can inspect camera and light before rendering.
4. `photo_3d render` rasterises at the document aspect and size (the
   supersampled native buffer is capped at 8000 px on an edge, then resized to
   the canvas) and adds the PNG as a new raster layer. That layer is a normal layer: masks, blend modes,
   adjustments, ordering, export and undo all work on it. The render is one
   undoable entry. Set `environment.mode: "transparent"` and leave
   `ground.alpha` at 0 to drop a model and its shadow into an existing photo.
5. `photo_3d status` returns the scene and the last render without changing
   anything.

The rasteriser, texture sampling and shadow map run in native C++. Release
builds ship a per-platform `photonext_fx` binary under `native/prebuilt`, so no
compiler is needed. A development checkout without a matching prebuilt compiles
the bundled source into `MINOTAURIS_EXTENSION_DATA/native/` and caches it by
source timestamp; a machine with neither a prebuilt nor a compiler gets an
actionable error, never a JavaScript approximation. Renders are milliseconds to
a few seconds. Animation, skinning, morph targets, Draco and a GPU viewport are
not implemented; the 3D toggle gives an orbitable native preview, and the output
is still an editable raster layer.

## Native 3D text and effects

`photo_text3d` is not canvas text. The same font pipeline as `photo_draw`
rasterises the string into a coverage mask; the native C++ engine turns that
mask into a signed distance field and ray-marches an extrusion of it. That is
why counters in `O` and `A` stay open, a bevel is a distance-field profile rather
than a mesh artefact, and any font the extension can render becomes 3D text.

- `action: "preview"` returns a PNG data URL and changes nothing. Tune here
  first: `depth`, `bevel`, `twist`, `rotation`, `camera` and `material` are cheap
  to iterate. The default camera pitch is 8°; a `camera.yaw` of 20–35° shows the
  extrusion and the side walls.
- `action: "render"` adds a normal raster layer at document size in one
  undoable entry. It is a layer like any other: masks, blend modes, adjustment
  layers, ordering, export and undo all apply.
- `light.direction` points *toward* the light, as in `photo_3d`. `material.face`
  is the front/back colour, `material.side` the extrusion wall and
  `material.bevel` the rim highlight. `material.mode` is `solid`, `chrome`
  (reflective studio metal) or `neon` (dark body with a hot edge).
  `material.gradient` blends `faceBottom` to `faceTop`.
- `twist` rotates the extrusion around its centre across its depth, in degrees.
  15–40° reads as a deliberate twist; large values fold the word into a ribbon.
- `shadow` is opt-in and costs roughly 20× a clean render. Leave it off unless
  the user asks for a cast shadow; the default is a clean transparent cut-out.

The sidebar's 3D Type panel drives the same tool: type, set depth/bevel/twist
and camera, preview, then add the layer. No agent turn is required.

`photo_effect` applies a destructive native effect to one raster layer:
`radialBlur`, `zoomBlur`, `motionBlur`, `lensDistortion`, `whirl`,
`kaleidoscope`, `mosaic`, `stainedGlass`, `oilify` (Kuwahara oil paint),
`halftone`, `dither`, `pixelSort`, `glow`, `wave`, `glitch`,
`chromaticAberration`, `pencilSketch`, `posterEdges`, `watercolor` and
`paperGrain`. Pass the parameters flat or under `params`;
`target.layer` defaults to the active raster layer. The result replaces that
layer in one undoable entry. `preview: true` processes a downscaled copy and
returns a PNG data URL without touching the document; the Effects panel uses it
for its live preview. These are original implementations of the operations GIMP
popularised, not ports of GIMP code (GIMP is GPLv3); do not call them GIMP
filters.

## Sketching fast

Rough drawing is where an agent burns the most turns, so the surface is built
to shorten it:

1. **Block the shape, not the detail.** One `sketch` command per pass. A face
   is a head contour, two eye strokes, a nose and a mouth line — six strokes, one
   call. Refine in a second pass only after looking at the returned preview.
2. **Sample coarsely and let the engine smooth.** `smooth` is on by default; a
   stroke with five or six points reads as a curve. Do not emit hundreds of
   samples, and do not send one `stroke` command per sample.
3. **Coordinates are the canvas.** Work from the dimensions in `photo_status`:
   eyes at about 40% height, hairline at about 25%, mouth at about 70%, for a
   portrait. Guessing in a small 0–100 space is the usual reason a sketch lands
   in the corner.
4. **Use pressure for ink, not for every line.** `pressure: true` on the loose
   contour; a constant width reads as construction line (good for guides).
5. **Object silhouettes are not sketches.** A car, a mug or a logo is one
   `compound` command with `paths` and `fillRule: "evenodd"` plus one detail
   `stroke`; sketching it out of twenty brush lines is slower and harder to edit.
6. **Use symmetry for faces, ornaments and patterns.** One half of a face or one
   arm of a mandala plus `symmetry: "horizontal"` or `"radial"` is one call and
   one undo step; do not emit the mirrored strokes yourself.
7. **Verify with the preview, then stop.** The tool response already carries the
   preview and layer tree. Add a second pass only when the silhouette is wrong,
   not to polish what is already right.

## Recipes

- **Cut out a background, place a logo**: `photo_select wand` on the background,
  `photo_select invert`, `photo_select modify { contract: 1, feather: 1 }`,
  `photo_mask create` on the subject layer, `photo_layer add` the logo, then
  `photo_layer set` its `offset` and `blendMode` (`multiply` for a flat mark).
- **Correct perspective**: `photo_edit perspective` with the four corners moved
  to the rectangle you want, then `crop` and `resize` to the output size.
- **Make one area brighter**: `photo_select rect`/`ellipse`/`polygon`, then
  `photo_adjust` with `target.selection: true`; `feather` the selection first so
  the edge is not a hard step.
- **Add a caption or a callout**: `photo_draw` with a `text` command (and an
  `arrow` from the label to the thing it names). Scale `size` to the canvas — 4%
  of the short edge reads as a caption, 8–12% as a headline. For a scrim behind
  the text, draw a `rect` with `fill` and low `opacity` first.
- **Outline a subject**: select it, then `photo_draw` a `stroke` with
  `smooth: false` and `width: 2` and `target.selection: true` to keep the line
  inside the mask; `closed: true` joins the last point back to the first.
- **Draw a simple car**: one `compound` command for the body, window holes and
  wheel openings (`paths`, `fillRule: "evenodd"`), then one `stroke` command
  whose `paths` carries the roof, doors and handles. Two commands are enough;
  verify with the returned preview instead of adding primitives one by one.
- **Rough a portrait**: one `sketch` command with a head contour, hair mass,
  two eye strokes, a nose and a mouth (all with `pressure: true`), then read the
  preview. Correct the silhouette with a second sketch command only if needed;
  both passes stay independent undo steps.
- **Tint a sky or add a vignette**: `photo_select` an area (or use the whole
  canvas), then `photo_draw` a `gradient` with two stops and
  `target.selection: true`. For a vignette, use `shape: "radial"` with a
  transparent centre stop and a dark edge stop.
- **Flat-fill a background**: `photo_draw` a `fill` command at a background
  pixel with a generous `tolerance`; for a product cut-out, set
  `target.selection: true` first so the fill cannot leak onto the subject.

## What the backend can do

PNG, JPEG, TIFF, GIF, HEIC and WebP can be read. PNG, JPEG, WebP, TIFF and GIF can
be written; AVIF is not supported yet. `photo_status.capabilities` reports the
backend (`libvips`, with its version), blend modes and adjustment types; if it
ever reports `available: false`, the tools refuse with that reason and change
nothing. Heavy passes (gaussian/median blur, sharpening, quarter-turn rotation)
run native in libvips; warps and blend maths are the extension's own, so their
results are reproducible on any install.

## Notes

- Importing a second image replaces the document and clears the history. Export
  what you need first.
- Destructive `photo_adjust` rewrites the layer as lossless PNG, so repeated
  adjustments do not accumulate JPEG artifacts. `photo_edit` keeps the layer's
  current format unless `format` is passed.
- Selections and masks are canvas-sized 8-bit coverage: 0 hides, 255 includes.
  Feather is a real blur of that coverage, not a wider shape.
- Colours are sRGB, 8 bits per channel. `whiteBalance` is neutral at 6500 K.
- `photo_draw` rasterises through the same libvips pipeline, so strokes and text
  are anti-aliased and clipped by the layer's mask exactly like an adjustment.
  Text with a host font uses the system library; text with a family installed by
  `photo_font` uses the extension's own fontconfig view, including fonts added
  after the server started.
- Do not claim an edit succeeded without checking the returned dimensions, the
  layer tree, the histogram or the exported pixels.
- The preview is JPEG at 1400 px, so judge composition there and verify exact
  dimensions and pixels with the tool results.
- The sidebar can be closed by the user while you keep editing; closing it does
  not stop the process or change the document. It reopens automatically on your
  next `photo_*` call.
- A control in the cockpit is not a second API: it sends the same tool call you
  would. If a button and a tool ever disagree, the tool result is the truth.

## Out of scope here

Content-aware or generative fill, RAW develop pipelines, CMYK/print output, video,
3D animation or live orbit controls, PSD round-trips and Photoshop plugins. Still missing from the matrices:
warp/forward mesh, auto-straighten, lens correction, content-aware scale,
editable shape layers (`photo_draw` bakes vectors into the target layer; it
cannot restyle them later), selective colour, radial/zoom blur adjustments, lens
blur and match colour. Text layers are editable, but one layer holds one
font/colour run. 3D is limited to one imported static model scene per document;
re-importing replaces it, and old models are removed from extension storage. If a request needs one and the tool is missing, say so instead of
approximating it with a crop.
