#!/usr/bin/env node
/**
 * Bundle the three Custom UI surfaces.
 *
 * Forge uploads whatever is under each `resources[].path`, so the bundles have to
 * be built before `forge deploy`. They are committed as well, so the app can be
 * linted and deployed on a machine with no node_modules.
 *
 *   npm run build:ui
 */

import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const surfaces = [
  { name: 'issue-panel', entry: 'ui/issue-panel/main.js' },
  { name: 'control-room', entry: 'ui/control-room/main.js' },
  { name: 'macro', entry: 'ui/macro/main.js' },
];

for (const surface of surfaces) {
  const outDir = resolve(projectRoot, 'static', surface.name);
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [resolve(projectRoot, surface.entry)],
    outfile: resolve(outDir, 'main.js'),
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    platform: 'browser',
    sourcemap: false,
    logLevel: 'warning',
  });
  await copyFile(resolve(projectRoot, 'ui/shared/styles.css'), resolve(outDir, 'styles.css'));
  console.log(`built ${surface.name}`);
}
