/*
 * A fresh process sees the current font directory.
 *
 * fontconfig is initialised once per process, so a font downloaded while the
 * long-lived MCP server is running is invisible to that server's already-loaded
 * libvips. Drawing with a downloaded family therefore asks this small child to
 * rasterise the SVG. It builds its fontconfig view from the directory on disk,
 * so the font is present even though it was installed seconds ago.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const dataDir = process.env.MINOTAURIS_EXTENSION_DATA;
if (!dataDir) {
  process.stderr.write('font-render: MINOTAURIS_EXTENSION_DATA is not set\n');
  process.exit(1);
}
process.env.FONTCONFIG_FILE = path.join(dataDir, 'fonts', 'fontconfig.conf');
process.env.PANGOCAIRO_BACKEND = 'fontconfig';

const sharp = require(path.join(__dirname, 'vendor', 'node_modules', 'sharp'));

async function main() {
  const svgPath = process.argv[2];
  const rawPath = process.argv[3];
  const width = Number(process.argv[4]);
  const height = Number(process.argv[5]);
  if (!svgPath || !rawPath || !(width > 0) || !(height > 0)) {
    throw new Error('font-render needs svgPath, rawPath, width and height');
  }
  const svg = fs.readFileSync(svgPath);
  const { data, info } = await sharp(svg, { density: 72, failOn: 'none' })
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || data.length !== width * height * 4) {
    throw new Error('font-render produced an unexpected raster size');
  }
  fs.writeFileSync(rawPath, data);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exit(1);
});
