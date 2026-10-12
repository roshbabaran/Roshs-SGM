// Development mode: starts the Expo dev server and opens the SGM Desk window on it.
// Screen changes appear as soon as you save. Changes in electron/ need a restart
// (close the window, then run this again).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SGM_DEV_PORT ?? 8081);
const url = `http://localhost:${port}`;

const built = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-electron.mjs'), '--dev'], { cwd: root, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);

const expo = spawn(process.execPath, [require.resolve('expo/bin/cli'), 'start', '--port', String(port)], {
  cwd: root,
  stdio: 'inherit',
});
const stop = () => {
  if (!expo.killed) expo.kill();
};
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});
expo.on('exit', (code) => process.exit(code ?? 0));

console.log(`Waiting for the Expo dev server at ${url} ...`);
for (let attempt = 0; ; attempt++) {
  try {
    const response = await fetch(url);
    if (response.ok) break;
  } catch {
    // Not up yet.
  }
  if (attempt > 240) {
    console.error(`The Expo dev server didn't start at ${url}.`);
    stop();
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const electron = spawn(require('electron'), [path.join(root, 'build', 'app')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SGM_DEV_SERVER_URL: url },
});
electron.on('exit', (code) => {
  stop();
  process.exit(code ?? 0);
});
