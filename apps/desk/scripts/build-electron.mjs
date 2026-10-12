// Builds SGM Desk's Electron part into build/app/:
//   main.js, preload.js  the Electron code from electron/, bundled with esbuild
//   renderer/            the screens, copied from the Expo web export in dist/
//   package.json         the app's name and version, read by Electron and electron-builder
//
// Usage: node scripts/build-electron.mjs [--dev]
//   --dev skips the screens (scripts/dev.mjs serves them from the Expo dev server)
import { loadProjectEnv } from '@expo/env';
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'app');
const dev = process.argv.includes('--dev');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// Read .env files the same way "expo export" does, so the window and the screens agree on the server address.
loadProjectEnv(root, { mode: dev ? 'development' : 'production', silent: true });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
  outdir: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  define: {
    // The installed app talks to the same server the screens were built for.
    'process.env.EXPO_PUBLIC_API_URL': JSON.stringify(process.env.EXPO_PUBLIC_API_URL ?? ''),
  },
  logLevel: 'warning',
});

if (!dev) {
  const dist = path.join(root, 'dist');
  if (!existsSync(path.join(dist, 'index.html'))) {
    console.error('No web export found in dist/. Run "npm run build:web" first.');
    process.exit(1);
  }
  cpSync(dist, path.join(out, 'renderer'), { recursive: true });
}

writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'sgm-desk',
      productName: 'SGM Desk',
      version: pkg.version,
      description: pkg.description,
      author: pkg.author,
      main: 'main.js',
      private: true,
    },
    null,
    2,
  ),
);

console.log(`SGM Desk ${pkg.version} built in ${path.relative(process.cwd(), out) || out}${dev ? ' (development)' : ''}`);
