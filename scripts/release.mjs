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
 * Before uploading, it checks that the build talks to the real SGM server
 * (API_URL below) and refuses one that would run on the built-in demo server.
 * Raise the version first: apps/desk/package.json for SGM Desk, and version
 * plus android.versionCode in apps/pocket/app.json for SGM Pocket.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.SGM_RELEASES_REPO ?? 'NathBajamunde/SGM-Releases';
const [app, apkPath] = process.argv.slice(2);
/** The server every release must use (apps/desk/.env.production, apps/pocket/.env.production and eas.json). */
const API_URL = 'https://cmpyttciealvhgkpuhoq.supabase.co/functions/v1/api';

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

/**
 * SGM Desk: the installer is packed from release/win-unpacked, so check that copy is this version and that both
 * the window (main.js) and the screens (renderer JS) were built with the real server address.
 */
function checkDeskBuild(dir, installer, version) {
  const asarFile = path.join(dir, 'win-unpacked', 'resources', 'app.asar');
  if (!existsSync(asarFile)) fail(`Missing ${path.relative(ROOT, asarFile)}. Build it with "npm run desk:dist".`);
  const asar = createRequire(import.meta.url)('@electron/asar');
  const built = JSON.parse(asar.extractFile(asarFile, 'package.json').toString('utf8')).version;
  if (built !== version) fail(`The packed app is ${built}, not ${version}. Run "npm run desk:dist" again.`);
  if (existsSync(installer) && statSync(installer).mtimeMs < statSync(asarFile).mtimeMs) {
    fail('The installer is older than the packed app. Run "npm run desk:dist" again.');
  }
  // listPackage gives paths with the platform's separator, which extractFile also expects.
  const files = asar.listPackage(asarFile).map((f) => f.replace(/^[\\/]/, ''));
  const uses = (file) => asar.extractFile(asarFile, file).toString('utf8').includes(API_URL);
  const screens = files.filter((f) => /^renderer[\\/].*\.js$/.test(f));
  if (!uses('main.js') || !screens.some(uses)) {
    fail(`SGM Desk ${version} isn't built for ${API_URL}, so it would run on the demo server. Not uploading.`);
  }
  console.log(`Checked: SGM Desk ${version} uses ${API_URL}.`);
}

/** One file from a zip (an APK), found through the zip's central directory. */
function readZipEntry(zip, name) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) return null;
  const count = zip.readUInt16LE(end + 10);
  for (let i = 0, at = zip.readUInt32LE(end + 16); i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      const local = zip.readUInt32LE(at + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    }
    at += 46 + skip;
  }
  return null;
}

/** SGM Pocket: the JavaScript inside the APK must have the real server address baked in. */
function checkPocketApk(apk, version) {
  if (!existsSync(apk)) fail(`Missing ${apk}.`);
  const bundle = readZipEntry(readFileSync(apk), 'assets/index.android.bundle');
  if (!bundle) fail(`${apk} has no assets/index.android.bundle. Is it a release APK from "eas build"?`);
  if (!bundle.includes(API_URL)) {
    fail(`This APK isn't built for ${API_URL}, so it would run on the demo server. Not uploading.`);
  }
  console.log(`Checked: SGM Pocket ${version} APK uses ${API_URL}.`);
}

if (app === 'desk') {
  const { version } = readJson('apps/desk/package.json');
  const dir = path.join(ROOT, 'apps', 'desk', 'release');
  const installer = `SGM-Desk-Setup-${version}.exe`;
  checkDeskBuild(dir, path.join(dir, installer), version);
  upload(`desk-v${version}`, `SGM Desk ${version}`, [installer, `${installer}.blockmap`, 'latest.yml'].map((f) => path.join(dir, f)));
} else if (app === 'pocket') {
  if (!apkPath) fail('Give the APK from eas build: npm run pocket:release -- <path to .apk>');
  const { version, android } = readJson('apps/pocket/app.json').expo;
  const versionCode = android?.versionCode;
  if (!Number.isInteger(versionCode)) fail('Set android.versionCode in apps/pocket/app.json.');
  const dir = path.join(ROOT, 'apps', 'pocket', 'release');
  const file = `SGM-Pocket-${version}.apk`;
  const source = path.resolve(process.env.INIT_CWD ?? process.cwd(), apkPath);
  checkPocketApk(source, version);
  mkdirSync(dir, { recursive: true });
  // npm runs scripts from the repository folder; INIT_CWD is where the command was typed.
  copyFileSync(source, path.join(dir, file));
  // What SGM Pocket reads to find a newer APK (apps/pocket/src/services/apk-updates.ts).
  writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify({ version, versionCode, file }, null, 2)}\n`);
  upload(`pocket-v${version}`, `SGM Pocket ${version}`, [file, 'latest.json'].map((f) => path.join(dir, f)));
} else {
  fail('Use: npm run desk:release, or npm run pocket:release -- <path to .apk>');
}
