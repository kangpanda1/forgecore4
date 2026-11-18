// Small HTTP helpers shared by every surface: JSON replies with the required X-GitHub-Request-Id header,
// JSON error bodies, body reading with a size cap, and query parsing.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** A monotonically increasing request id: deterministic, no randomness, no clock. */
let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  try {
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': String(Buffer.byteLength(text)),
      'x-github-request-id': nextRequestId(),
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(text);
  } catch {
    // the peer went away
  }
}

export function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  try {
    res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
  } catch {
    // the peer went away
  }
}

/** A JSON error body: GitHub's `{message, documentation_url?}` shape. */
export function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest', ...extra });
}

export function sendText(res: ServerResponse, status: number, text: string, contentType: string, headers: Record<string, string> = {}): void {
  try {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(Buffer.byteLength(text)),
      'x-github-request-id': nextRequestId(),
      ...headers,
    });
    res.end(text);
  } catch {
    // the peer went away
  }
}

export function sendBuffer(res: ServerResponse, status: number, buffer: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  try {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(buffer.length),
      'x-github-request-id': nextRequestId(),
      ...headers,
    });
    res.end(buffer);
  } catch {
    // the peer went away
  }
}

/** Read a request body whole, up to a cap; null when it is past the cap. */
export async function readBody(req: IncomingMessage, cap = 32 * 1024 * 1024): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > cap) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Read a JSON body; `undefined` when the body is empty, throws {code:'bad_json'} when it does not parse. */
export async function readJson<T = unknown>(req: IncomingMessage, cap = 8 * 1024 * 1024): Promise<T | undefined> {
  const raw = await readBody(req, cap);
  if (raw === null) {
    const error = new Error('request body is too large') as Error & { code?: string };
    error.code = 'too_large';
    throw error;
  }
  const text = raw.toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    const error = new Error('Problems parsing JSON') as Error & { code?: string };
    error.code = 'bad_json';
    throw error;
  }
}

/** The bearer token a request carries, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.trim() === '') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  const token = (match[1] ?? '').trim();
  return token === '' ? null : token;
}

/** The parsed URL of a request (path + query), tolerant of a broken url. Honours the Host header so
 *  `url.origin` is the origin the client dialled (Link headers must stay on it). */
export function urlOf(req: IncomingMessage): URL {
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'forge.local';
  try {
    return new URL(req.url ?? '/', `http://${host}`);
  } catch {
    return new URL('/', 'http://forge.local');
  }
}

/** A query parameter as a string, or null. */
export function queryParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value === null ? null : value;
}

/** A query parameter as a bounded positive integer. */
export function queryInt(url: URL, name: string, fallback: number, max = 100): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.trunc(value));
}

export function decodeSegments(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** A base64 (standard alphabet) string, no wrapping. */
export function toBase64(text: string | Buffer): string {
  return (typeof text === 'string' ? Buffer.from(text, 'utf8') : text).toString('base64');
}

export function fromBase64(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** A deterministic opaque global id: base64 of `<type>:<n>`, distinct from the bare database id.
 *  A negative n (an inverted run-local id) still passes through `<type>` and `:n` so ids stay
 *  stable and reversible; the sign is an implementation detail the surface never exposes. */
export function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

export function parseGlobalId(value: string): { type: string; id: number } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(-?\d+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1] as string, id: Number(match[2]) };
  } catch {
    return null;
  }
}
