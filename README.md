# PhotoNext

**An agent-first image cockpit that ships inside [Minotauris](https://github.com/RickyFFYT/Minotauris).**

PhotoNext is a built-in extension for the Minotauris desktop app: one document (a canvas
with a real layer stack), **29 tools** exposed to the agent over MCP, a Photoshop-style
sidebar panel that renders that document, a native C++ raster engine, and a vendored
libvips backend so it works on an installed app with no npm and no network.

This repository is the source of that extension, mirrored from
`apps/desktop-tauri/src-tauri/resources/extensions-builtin/com.minotauris.photonext`
in the Minotauris monorepo.

- **Extension id:** `com.minotauris.photonext`
- **Version:** 0.14.0
- **Runtime:** Node process (`server/main.cjs`), stdio, MCP `Content-Length` framing
- **Surface:** right sidebar beside the conversation (`sidebar.agentOnly: true`)
- **Tools:** 29 (`photo_*`)
- **Skills:** 1 (`skills/photo.md`)
- **Capabilities:** `filesystem: "extension-data"`, `tools: true`

---

## Why it exists

The first version of this editor shelled out to `/usr/bin/sips`. `sips` can rotate, flip,
crop, resample and convert — and nothing else. No amount of tool surface would have
produced a tone curve, a blend mode, a layer or a mask, so the backend was replaced.
The decision record (in the app repo: `docs/decisions/photo-editor-backend.md`) settles on
**vendoring `sharp@0.34.5` (libvips 8.17.3)** inside the extension and keeping every
operation that Photoshop defines *by formula* — curves, levels, HSL, all 26 blend modes —
as the extension's own banded raw `Uint8Array` passes.

That split is the whole architecture in one sentence: **libvips is the pixel carrier,
PhotoNext owns the maths.**

It mattered, and the spike proved it rather than assuming it: libvips' native `soft-light`
is **26 levels off** the W3C/Photoshop formula on a measured sample (`rgb(186,90,67)` vs
`rgb(181,71,41)`), so compositing does not delegate to it.

---

## Repository layout

```
manifest.json              extension manifest (id, runtime, view, capabilities, contributes)
index.html                 the sidebar document — plain HTML, no bundler
view.js                    the cockpit: layers, adjustments, selections, brush, history, 3D type
app.css                    panel styling against the host's theme tokens
bridge.js                  ~100-line dependency-free host bridge client (postMessage protocol)
logo.png / mark.png        assets

skills/photo.md            the skill the agent is given: procedures, ranges, recipes, limits

server/main.cjs            MCP server: 29 tool definitions, dispatch, envelope, document state
server/document.cjs        document model: layer tree, groups, revisions
server/pixels.cjs          raw-band passes: LUTs, blend, warp, histogram
server/adjustments.cjs     tone, colour and focus adjustments
server/blend.cjs           26 blend modes by W3C compositing formula
server/transform.cjs       rotation, skew, perspective, canvas arithmetic
server/selection.cjs       coverage-mask selections (rect, ellipse, polygon, wand, colour)
server/draw.cjs            brush, sketch, shapes, fill, gradients, clone stamp
server/text.cjs            editable text layers
server/styles.cjs          layer styles (shadow, glow, stroke, bevel)
server/effects.cjs         20 native effects
server/tone.cjs            curves/levels/HSL/histogram
server/inspect.cjs         describe/find/bounds/sample/region/diff snapshots
server/history.cjs         undo entries and undo groups
server/render.cjs          libvips bridge: decode, encode, resize, blur, SVG text
server/store.cjs           layer/mask/selection/snapshot files + garbage collection
server/native3d.cjs        native renderer loader (prebuilt, or compiled from source)
server/scene3d.cjs         glTF scene, camera, light, shadow catcher
server/text3d.cjs          SDF ray-marched 3D type
server/ops.cjs             operation table shared by tools and recipes
server/fonts.cjs           font library (host fonts + installed families)

native/photonext_fx.cpp    native engine: effects, 3D renderer, SDF 3D text, shadow map
native/photo3d.cpp         glTF rasteriser
native/prebuilt/           per-platform binaries (darwin-arm64, darwin-x64, win32-x64)
native/vendor/             stb_image, stb_image_write, tiny_gltf, nlohmann/json (+ licenses)

server/vendor/             vendored backend: sharp@0.34.5 + libvips per platform
  README.md                provenance, digests, reinstall steps
  digests.cjs/json          sha256 of every vendored file, sha512 of every package
```

---

## Installing and running

### As the built-in extension (what ships)

It is already part of the app. Nothing to install, nothing to configure, and it cannot be
uninstalled — the user did not install it. It is loaded by the same loader that reads
sideloaded extensions and the dev directory; there is no privileged code path.

### As a developer build

Copy this directory to `~/Minotauris/extensions-dev/com.minotauris.photonext` and restart
the app. It loads as a `sideload` source (badged as a developer build, uninstallable),
through the same manifest validation as anything else.

### Requirements

- The Node runtime that Minotauris ships (`Resources/nodejs/node`). No npm, no network.
- A `photonext_fx` binary for the platform, or a C++ compiler to build one on first use.
  Prebuilts cover macOS arm64/x64 and Windows x64. A machine with neither gets an
  actionable error — never a JavaScript approximation.
- The vendored backend is required **by path** (`server/vendor/node_modules/sharp`), never
  by module name, because the process runs with `PATH=/nonexistent`.

Verify the vendored tree at any time:

```sh
cd server/vendor && node digests.cjs        # fails on a missing, extra or altered file
```

---

## The surface: 29 tools

| Tools | What they own |
|---|---|
| `photo_import` | Bring an absolute path in as a document. EXIF orientation baked first. Source is copied, never modified. |
| `photo_status` | The document: dimensions, layer tree, selection, histogram, history, capabilities, preview when the revision changed. |
| `photo_edit` | Geometry, in a fixed order: rotate → flip → skew → perspective → crop → resize → canvas → trim. |
| `photo_select` | Rect, ellipse, polygon, wand (flood fill), colour range, all/none/invert, modify (grow, contract, smooth, border, feather), save/load named. |
| `photo_adjust` | 32 adjustments: curves, levels, exposure, white balance, HSL bands, vibrance, channel mixer, LUTs, blur, sharpen, clarity, dehaze, denoise, vignette, grain. `asLayer: true` makes a non-destructive adjustment layer. |
| `photo_draw` | Brush, `sketch` (up to 32 tapered strokes + symmetry), lines, arrows, rects, ellipses, polygons/compound paths, fuzzy bucket fill, linear/radial gradients (16 stops), clone stamp, baked text. |
| `photo_layer` | Add, set (blend mode, opacity, offset, visibility, parent), group, ungroup, duplicate, mergeDown, flatten, delete, select. |
| `photo_mask` | Create from selection, paint, feather, invert, apply, delete. |
| `photo_style` | Drop shadow, outer glow, stroke, inner stroke, bevel — stacked, live, toggleable. |
| `photo_text` | Editable text layers: the record stays live through snapshots and undo; rasterised at preview/export. |
| `photo_font` | Install a `.ttf`/`.otf` by URL into extension storage; list families. |
| `photo_3d` | `import` / `configure` / `preview` / `render` / `status` — glTF model, camera, light, transparent shadow catcher, renders to a normal layer. |
| `photo_text3d` | SDF ray-marched extruded type from any renderable font: depth, bevel, twist, chrome/neon materials. |
| `photo_effect` | 20 native effects: oil paint, halftone, whirl, pixel sort, bloom, mosaic, lens distortion, wave, chromatic aberration, pencil sketch, poster edges, watercolour, paper grain, glitch, dither, stained glass, kaleidoscope, radial/zoom/motion blur. |
| `photo_history` | Undo, redo, list. |
| `photo_describe` | Compact layer tree: ids, kinds, frames, text, styles, parent, depth. |
| `photo_delta` | What changed since a revision: added, removed, changed. |
| `photo_find` | Resolve a layer by name fragment, kind, text or colour; ambiguous queries return ranked candidates. |
| `photo_bounds` | Frame bbox **and** alpha-trimmed ink bbox, pixels + normalised. |
| `photo_sample` | RGBA/hex/luminance at up to 256 points, dominant palette, clipping, channel means. |
| `photo_region` | A 1:1 or 2–4× crop with document mapping — where hairlines actually get checked. |
| `photo_measure_text` | Line breaks, ink box, overflow against a box, contrast against a sampled background, the size that fits. |
| `photo_catalog` | Every effect, adjustment, style, preset and blend mode with ranges and defaults. Cheaper than guessing. |
| `photo_preflight` | Preset dimensions, DPI, transparency, colour space, live styles, estimated bytes before export. |
| `photo_layout` | Align, distribute, space layers and groups by named anchors. |
| `photo_diff` | Changed bbox, changed-pixel share, MAE/RMSE/PSNR/SSIM, optional heatmap. |
| `photo_recipe` | Several calls as one undo group with `$alias` references; `atomic: true` rolls the whole group back on failure. |
| `photo_lut` | Install, list, show, remove `.cube` looks. |
| `photo_export` | The only step that writes outside the editor (and it asks first). Presets (`ig_post`, `ig_story`), naming tokens, several sizes from one flatten. |

---

## How we use it

### The loop

1. **Import** the path. Chat attachments and workspace files already arrive as paths.
2. **Look before editing**: `photo_status` gives dimensions, the layer tree and a
   histogram. Do not guess the canvas size — sketch coordinates are canvas pixels.
3. **Scope the edit**: `photo_select` when the change is local, `photo_layer select` when
   the change belongs to a specific layer.
4. **Change it**: `photo_adjust` (tone/colour/focus), `photo_edit` (geometry),
   `photo_draw` (marks), `photo_text` (type that stays editable), `photo_3d` /
   `photo_text3d` / `photo_effect` (native passes), `photo_layer` / `photo_mask` /
   `photo_style` (compose).
5. **Verify** with the envelope and, when it matters, with `photo_diff` or a
   `photo_region` crop. `no_op: true` means nothing happened — read it before claiming a
   change.
6. **Export** to an absolute path inside the project (`artifacts/`), optionally as several
   presets in one call.

### The panel is a view of the tools

PhotoNext opens itself the moment any `photo_*` tool runs — the agent never has to call
`extensions.open` first. Every control in the sidebar *is* a tool call: layer rows call
`photo_layer`, style chips call `photo_style`, the adjustment stack calls `photo_adjust`,
the brush calls `photo_draw`, the history list calls `photo_history`. Nothing in the panel
edits the document directly, so `photo_status` and the panel always agree. If a button and
a tool result ever disagree, the tool result is the truth.

The panel is filed **per chat** — a photo an agent opened in one conversation does not sit
beside another conversation's thread.

A simulated pointer follows the agent at the pixel it is working on, with a pressure-aware
brush halo for strokes, a marquee for selections, a crop frame for geometry, a transform
outline and an I-beam for text.

### Concurrency, retries, errors

Every mutating call returns a fixed envelope — `revision_before`, `revision_after`,
`changed[{id, name, reasons, frame}]`, `created_ids`, `removed_ids`, `selection_changed`,
`warnings`, `no_op`, `undo_group`, `next_actions` — so a model updates its world model in
one step instead of re-reading the document.

- Pass **`if_revision`** when the user may be editing the same document. A mismatch returns
  `REVISION_CONFLICT` with the changed layers and a suggested call instead of overwriting
  their work.
- Pass **`op_id`** to make a retried call idempotent.
- Errors carry `code`, `field`, `received`, `allowed`, `candidates` and `suggested_call`,
  so a failed call usually has one obvious recovery.

### Batches and undo

`photo_recipe` runs several calls as one undo group with `$alias` references, and
`atomic: true` rolls the whole group back on failure. Every other call is one entry; a
text layer's create plus its first `set` is one intent; `photo_mask apply` is deliberately
two entries (pixels, then mask removal).

### Measured cost

From the backend decision record, Apple Silicon, the Node runtime the app actually ships:

| Canvas | Full pipeline | PNG encode | Raw LUT pass | Resize 2048 | Blur σ3 | WebP q80 | Peak RSS |
|---|---|---|---|---|---|---|---|
| 12 MP (4000×3000) | 397 ms | 20 ms | 45 ms | 12 ms | 21 ms | 248 ms | 298 MB |
| 80 MP (10000×8000) | 2 756 ms | 126 ms | 300 ms | 77 ms | 149 ms | 1 785 ms | 751 MB |

Native blur replaced the JS approximation at 12 MP by ~24× (1 298 ms → 54 ms), unsharp
from 1 556 ms to 126 ms. WebP encode is the one deliberate export-time cost; it is never on
a polling path.

---

## Limits (stated, not hidden)

Content-aware or generative fill, RAW develop pipelines, CMYK/print output, video, 3D
animation or live orbit controls, PSD round-trips and Photoshop plugins are out of scope.
Still missing from the matrices: warp/forward mesh, auto-straighten, lens correction,
content-aware scale, editable shape layers (vectors bake into the target layer), selective
colour, radial/zoom blur *adjustments*, lens blur and match colour. Text layers are
editable but one layer holds one font/colour run. 3D is one imported static model scene per
document. `dehaze` and `clarity` are documented approximations; gaussian blur is three box
passes, documented as such. The preview is JPEG at 1400 px — judge composition there and
verify exact pixels with `photo_region`. AVIF is not in this libvips build.

Effects are original implementations of operations GIMP popularised, not ports of GIMP
code (GIMP is GPLv3). They are not "GIMP filters" and must not be called that.

---

## Testing

The suites live with the app (they need its harness), not in this mirror:

```sh
cd apps/desktop-tauri
npx jest --runInBand photo-next-extension photo-next-tone photo-next-raster \
  photo-next-blend-selection-transform photo-next-document-history \
  photo-next-3d photo-next-text3d photo-next-draw photo-next-effects \
  photo-next-inspect photo-next-pointer photo-next-view photo-next-backend-spike
```

`photo-next-backend-spike` is the one that proves the shipped arrangement: it launches the
server by absolute path with `PATH=/nonexistent`, checks the Mach-O headers of the Intel and
arm64 libvips payloads, re-hashes the vendored tree, and asserts every file written lands
inside the extension data directory.

---

## Vendored runtime and licences

`server/vendor/` ships `sharp@0.34.5` with libvips 8.17.3 for macOS arm64, macOS x64 and
Windows x64, because an installed app has no npm and no registry. Provenance, the sha256
digests and the exact reinstall command are in `server/vendor/README.md`.

`native/vendor/` ships `stb_image`, `stb_image_write`, `tiny_gltf` and `nlohmann/json` with
their licence files beside them.

---

## More

**[docs/ENGINE-LEVERAGE.md](docs/ENGINE-LEVERAGE.md)** — what this surface becomes on the
Minotaur engine: the Coordinator / Supervisor / Executor split, per-agent todos, structured
`ui.render` answers, Prism review, the revision contract under parallel agents, and where
the leverage is actually measurable.

**[skills/photo.md](skills/photo.md)** — the skill the agent is handed. It is the real
manual: parameter ranges, the compositing rules for groups and styles, sketching tactics,
and the recipes that keep a turn from turning into twenty tool calls.
