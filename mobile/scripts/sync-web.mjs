import { copyFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const repoRoot = path.resolve(mobileRoot, '..');
const webDir = path.join(mobileRoot, 'www');

const requiredFiles = ['index.html', 'favicon.svg'];
await mkdir(webDir, { recursive: true });

for (const file of requiredFiles) {
  const source = path.join(repoRoot, file);
  await access(source);
  await copyFile(source, path.join(webDir, file));
}

console.log('TheSparkle web assets copied into mobile/www.');
console.log('No production website, Supabase function, or payment file was modified.');
