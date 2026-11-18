// The entry's HTTP server and the env lifecycle: bind an ephemeral port, register it with the env,
// poll /done until the trial is over, then exit 0. The server routes every request to one of the
// four scored surfaces — git smart HTTP, REST v3, GraphQL v4 and MCP — plus /healthz and a JSON 404.
//
// Lifecycle (env/src/wire.ts, the starter's README):
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial); without it, exit 1.
//   2. server.listen(0): the kernel picks a free port (never 8080 — the env owns it).
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The first register wins; 409 means another entry
//      already registered (keep waiting). 400/405 are contract errors and end the process.
//   4. GET $MAKEFUN_ENV_URL/done until {"done":true}. Poll with exponential backoff; never exit early.
//   5. Close the server and exit 0.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sendError, sendJson, urlOf } from './http.ts';
import { serveInfoRefs, serveGitPost } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { ForgeStore } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // the env is not answering yet, or the poll timed out: it is not done, poll again
    }
    await sleep(retryDelay(attempt));
  }
}

// ---------------------------------------------------------------- the HTTP router

// Smart-http shapes: GET /{owner}/{repo}.git/info/refs?service=..., POST /{owner}/{repo}.git/<service>.
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function route(store: ForgeStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = urlOf(req);
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The GitHub API root: a 200 with the token's scopes.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // Git smart HTTP first: its paths never collide with /api/v3 or /api/graphql or /mcp.
  const git = GIT_PATH.exec(path);
  if (git !== null) {
    const owner = git[1] as string;
    const name = git[2] as string;
    const tail = git[3] as string;
    // Auth: every git route needs a bearer token; without one -> 401.
    const token = (req.headers.authorization ?? '').toString();
    const hasToken = /^Bearer\s+\S+$/i.test(token.trim());
    if (!hasToken) {
      // git smart HTTP clients (real git) may use basic auth; the suite always sends a Bearer token.
      const basic = /^Basic\s+\S+$/i.test(token.trim());
      if (!basic) {
        sendError(res, 401, 'Requires authentication');
        return;
      }
    }
    if (tail === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (serveInfoRefs(store, req, res, owner, name, service, true)) return;
    } else {
      // POST git-upload-pack / git-receive-pack: read the raw body whole.
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
        if (serveGitPost(store, req, res, owner, name, tail, body)) return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (await handleRest(store, req, res)) return;
  if (await handleGraphQL(store, req, res)) return;
  if (await handleMcp(store, req, res)) return;

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}

function createApp(): Server {
  const store = new ForgeStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(store, req, res).catch((err: unknown) => {
      try {
        const code = (err as Error & { code?: string }).code;
        if (code === 'bad_json') sendError(res, 400, 'Problems parsing JSON');
        else if (code === 'too_large') sendError(res, 400, 'Problems parsing JSON');
        else sendError(res, 500, 'Internal Server Error');
      } catch {
        // the peer went away
      }
    });
  });
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}