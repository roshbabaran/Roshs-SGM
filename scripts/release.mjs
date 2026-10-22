#!/usr/bin/env node
/**
 * Uploads a finished build to the private releases repo on GitHub, where the
 * SGM API hands it to signed-in people on approved devices. Needs the GitHub
 * CLI, signed in once with "gh auth login".
 *
 *   npm run desk:release                       after npm run desk:dist
 *   npm run pocket:release -- <path to .apk>   after eas build
 *
 * The repo is NathBajamunde/SGM-Releases unless SGM_RELEASES_REPO names another.
 * Raise the version first: apps/desk/package.json for SGM Desk, and version
 * plus android.versionCode in apps/pocket/app.json for SGM Pocket.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.SGM_RELEASES_REPO ?? 'NathBajamunde/SGM-Releases';
const [app, apkPath] = process.argv.slice(2);

const readJson = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function upload(tag, title, files) {
  for (const file of files) if (!existsSync(file)) fail(`Missing ${path.relative(ROOT, file)}. Build it first.`);
  console.log(`Uploading ${title} to ${REPO}...`);
  const args = ['release', 'create', tag, '--repo', REPO, '--title', title, '--notes', title, ...files];
  const result = spawnSync('gh', args, { stdio: 'inherit' });
  if (result.error) fail(`Couldn't run the GitHub CLI (${result.error.message}). Install it with "winget install --id GitHub.cli", then run "gh auth login".`);
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`Done. Installed copies pick up ${title} the next time they check for updates.`);
}

if (app === 'desk') {
  const { version } = readJson('apps/desk/package.json');
  const dir = path.join(ROOT, 'apps', 'desk', 'release');
  const installer = `SGM-Desk-Setup-${version}.exe`;
  upload(`desk-v${version}`, `SGM Desk ${version}`, [installer, `${installer}.blockmap`, 'latest.yml'].map((f) => path.join(dir, f)));
} else if (app === 'pocket') {
  if (!apkPath) fail('Give the APK from eas build: npm run pocket:release -- <path to .apk>');
  const { version, android } = readJson('apps/pocket/app.json').expo;
  const versionCode = android?.versionCode;
  if (!Number.isInteger(versionCode)) fail('Set android.versionCode in apps/pocket/app.json.');
  const dir = path.join(ROOT, 'apps', 'pocket', 'release');
  const file = `SGM-Pocket-${version}.apk`;
  mkdirSync(dir, { recursive: true });
  // npm runs scripts from the repository folder; INIT_CWD is where the command was typed.
  copyFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), apkPath), path.join(dir, file));
  // What SGM Pocket reads to find a newer APK (apps/pocket/src/services/apk-updates.ts).
  writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify({ version, versionCode, file }, null, 2)}\n`);
  upload(`pocket-v${version}`, `SGM Pocket ${version}`, [file, 'latest.json'].map((f) => path.join(dir, f)));
} else {
  fail('Use: npm run desk:release, or npm run pocket:release -- <path to .apk>');
}
