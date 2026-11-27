# Vendored backend runtime

This directory ships the PhotoNext render backend **inside the builtin extension**,
because the installed app has no npm, no registry and no network: `server/main.cjs`
requires the module by path (`vendor/node_modules/sharp`), never by name, so it
works with `PATH=/nonexistent` exactly as it does in the app bundle.

It exists because of Decision D1 (`docs/decisions/photo-editor-backend.md`): the
previous backend, `/usr/bin/sips`, cannot express a tone curve, a blend mode, a
layer or a mask, so it could not be extended toward Photoshop parity.

- `sharp@0.34.5`, which embeds libvips 8.17.3.
- Platform packages for every installer the app ships, because one vendor tree
  is bundled for all of them:
  - macOS Apple Silicon: `@img/sharp-darwin-arm64`, `@img/sharp-libvips-darwin-arm64`
  - macOS Intel: `@img/sharp-darwin-x64`, `@img/sharp-libvips-darwin-x64`
  - Windows x64: `@img/sharp-win32-x64` (its libvips DLLs ship inside that package)

  The Intel and Windows payloads are installed with `--force` from whichever
  host is doing the pinning; their Mach-O / PE headers are asserted by
  `photo-next-backend-spike.test.ts`, and the Windows payload is executed on
  Windows. Windows ARM64 is not shipped (`release.yml` builds x86_64 only), so
  there is no `@img/sharp-win32-arm64`; add it here and to the spike test if a
  Windows ARM build ever lands.

## Digests

`digests.json` pins a `sha256` for every vendored file and records the registry
`sha512` integrity each package was installed from. Verify with:

```sh
node digests.cjs
```

That is what the spike test runs (with `PATH=/nonexistent`). Any missing, extra
or altered file fails it. Re-pin only after a deliberate upgrade:

```sh
node digests.cjs --write
```

## Reinstalling

```sh
cd apps/desktop-tauri/src-tauri/resources/extensions-builtin/com.minotauris.photonext/server/vendor
rm -rf node_modules package-lock.json digests.json
# --force installs the other platforms' payloads too; npm would otherwise skip
# anything whose os/cpu does not match the host.
npm install --omit=dev --no-audit --no-fund \
  --force @img/sharp-darwin-x64@0.34.5 @img/sharp-libvips-darwin-x64@1.2.4 \
  @img/sharp-win32-x64@0.34.5
node digests.cjs --write
```

`package.json` lists the non-host packages, so a plain `npm install` here fails
the platform check by design: this directory is pinned, and `--force` is the
statement that you meant to change it.

Then run the proof the milestone requires:

```sh
cd apps/desktop-tauri && npx jest --runInBand photo-next-backend-spike
```

The root `.gitignore` ignores `**/node_modules`; a negation rule keeps *this* one
tracked, because a builtin extension ships as ordinary files inside the app
bundle. Adding a second vendored dependency means adding it to that rule's
rationale and to the spike test, not just to `package.json`.
