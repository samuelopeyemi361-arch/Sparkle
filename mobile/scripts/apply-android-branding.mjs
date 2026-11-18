import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const repoRoot = path.resolve(mobileRoot, '..');
const resources = path.join(mobileRoot, 'android', 'app', 'src', 'main', 'res');

const favicon = await readFile(path.join(repoRoot, 'favicon.svg'), 'utf8');
const svgOpenEnd = favicon.indexOf('>');
const svgCloseStart = favicon.lastIndexOf('</svg>');
if (svgOpenEnd < 0 || svgCloseStart <= svgOpenEnd) {
  throw new Error('The root favicon.svg is not a valid SVG document.');
}

const innerSvg = favicon.slice(svgOpenEnd + 1, svgCloseStart)
  .replace(/<rect\b[^>]*\/>/i, '');
const fullSvg = Buffer.from(favicon);
const foregroundSvg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432" viewBox="0 0 96 96">' +
  '<g transform="translate(8.5 17.2) scale(0.76)">' +
  innerSvg +
  '</g></svg>'
);

const densities = [
  { name: 'mdpi', launcher: 48, foreground: 108 },
  { name: 'hdpi', launcher: 72, foreground: 162 },
  { name: 'xhdpi', launcher: 96, foreground: 216 },
  { name: 'xxhdpi', launcher: 144, foreground: 324 },
  { name: 'xxxhdpi', launcher: 192, foreground: 432 }
];

for (const density of densities) {
  const folder = path.join(resources, `mipmap-${density.name}`);
  await mkdir(folder, { recursive: true });

  const launcher = await sharp(fullSvg, { density: 600 })
    .resize(density.launcher, density.launcher, { fit: 'contain' })
    .png()
    .toBuffer();
  await writeFile(path.join(folder, 'ic_launcher.png'), launcher);
  await writeFile(path.join(folder, 'ic_launcher_round.png'), launcher);

  const foreground = await sharp(foregroundSvg, { density: 600 })
    .resize(density.foreground, density.foreground, { fit: 'contain' })
    .png()
    .toBuffer();
  await writeFile(path.join(folder, 'ic_launcher_foreground.png'), foreground);
}

const valuesDir = path.join(resources, 'values');
const adaptiveDir = path.join(resources, 'mipmap-anydpi-v26');
await mkdir(valuesDir, { recursive: true });
await mkdir(adaptiveDir, { recursive: true });

await writeFile(
  path.join(valuesDir, 'thesparkle_launcher.xml'),
  '<resources><color name="ic_launcher_background">#071B4D</color></resources>\n'
);

const adaptiveIcon = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
await writeFile(path.join(adaptiveDir, 'ic_launcher.xml'), adaptiveIcon);
await writeFile(path.join(adaptiveDir, 'ic_launcher_round.xml'), adaptiveIcon);

// The standard Android 12+ splash screen uses the app icon; this keeps it branded.
console.log('Applied TheSparkle favicon to Android launcher and adaptive icons.');
