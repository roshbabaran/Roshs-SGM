/**
 * Serves SGM Desk's screens (the Expo web export) from app://sgm/ instead of
 * file://. A real origin keeps the export's absolute paths (/_expo/static/...)
 * working and lets every page carry a strict Content-Security-Policy.
 */
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'sgm';
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/**
 * Screens may only load their own files and talk to the SGM API server.
 * react-native-web adds its styles at runtime, hence 'unsafe-inline' for styles only.
 */
export function contentSecurityPolicy(apiUrl: string): string {
  let api = '';
  try {
    if (apiUrl) api = ` ${new URL(apiUrl).origin}`;
  } catch {
    // Not a valid URL: the app shows a connection error instead.
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${api}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Answers app://sgm/ requests with files from `rootDir`. Unknown page paths get index.html (the app's router handles them). */
export function serveApp(rootDir: string, csp: string): void {
  const root = path.resolve(rootDir);

  const respond = async (file: string): Promise<Response> => {
    const body = await readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers: Record<string, string> = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' };
    if (type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = csp;
      headers['Cache-Control'] = 'no-cache';
    }
    return new Response(body, { headers });
  };

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });

    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const file = path.resolve(root, `.${relative}`);
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });

    try {
      return await respond(file);
    } catch {
      // A missing file with an extension is a missing asset; anything else is a page of the app.
      if (path.extname(relative)) return new Response('Not found', { status: 404 });
      return respond(path.join(root, 'index.html'));
    }
  });
}
