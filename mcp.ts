// The forge's Model Context Protocol surface at /mcp: JSON-RPC 2.0 over streamable HTTP, speaking both
// protocol eras the suite accepts. The modern 2026-07-28 revision is served through `server/discover` (a
// DiscoverResult with supportedVersions, capabilities and serverInfo in one answer; no handshake, no
// session); the legacy handshake (`initialize` + `notifications/initialized`) is also answered for the
// pre-discover fallback a conformant client may take. Seven tools (the six required canonical names plus
// one plain echo) act on the same ForgeStore the REST surface uses, so a repository or issue created over
// MCP is the same object over REST with stable ids.
//
// Contract highlights (see NOTES.md and the sealed checks-mcp.ts):
//   - every /mcp POST needs Authorization: Bearer <token>; absent -> HTTP 401 {message}
//   - a body that is not JSON -> HTTP 400 with JSON-RPC -32700
//   - an unknown tool name -> JSON-RPC -32601 (never an HTTP 500)
//   - tools/call with missing required arguments -> JSON-RPC -32602
//   - tools/list: at least six tools, all six required ones by name; every tool has a non-empty
//     description and an inputSchema of type object; byte-identical across repeated calls

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken, readBody, sendJson } from './http.ts';
import { type ForgeStore, type Issue, type Pull, type Repo, type User, userForToken } from './store.ts';

const JSONRPC_VERSION = '2.0';
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_INFO: Readonly<{ name: string; version: string }> = Object.freeze({ name: 'github-core-clone-forge', version: '1.0.0' });

const ERR_PARSE = -32700;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- small JSON helpers

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------- object shapes (MCP flavor)

function repoJson(repo: Repo, owner: string): Json {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(issue: Issue): Json {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    user: { login: issue.user.login },
  };
}

function pullJson(pull: Pull): Json {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: pull.head,
    base: pull.base,
    head_sha: pull.headSha,
    base_sha: pull.baseSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** One tool's result as the transport wants it: text blocks plus the structured value. */
function toolResult(value: unknown): Json {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

// ---------------------------------------------------------------- the required-argument guard

class ToolError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function requiredArgs(args: Json, fields: readonly string[]): void {
  const missing = fields.filter((field) => {
    const value = args[field];
    return !(typeof value === 'string' && value.trim() !== '') && !(typeof value === 'number');
  });
  if (missing.length > 0) throw new ToolError(ERR_INVALID_PARAMS, `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
}

// ---------------------------------------------------------------- tool implementations

interface ToolContext {
  store: ForgeStore;
  user: User;
}

function findRepoOrThrow(ctx: ToolContext, owner: unknown, repo: unknown): Repo {
  const ownerName = str(owner);
  const repoName = str(repo);
  if (ownerName === '' || repoName === '') throw new ToolError(ERR_INVALID_PARAMS, 'owner and repo are required');
  const found = ctx.store.findRepo(ownerName, repoName);
  if (found === null) throw new ToolError(ERR_INVALID_PARAMS, `repository ${ownerName}/${repoName} not found`);
  return found;
}

function toolCreateRepo(ctx: ToolContext, args: Json): Json {
  const name = str(args.name);
  if (name === '') throw new ToolError(ERR_INVALID_PARAMS, 'name is required');
  const owner = str(args.owner) === '' ? ctx.user.login : str(args.owner);
  try {
    const repo = ctx.store.createRepo(owner, name, { description: str(args.description), private: args.private === true });
    return repoJson(repo, owner);
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === 'exists') throw new ToolError(ERR_INVALID_PARAMS, `repository ${owner}/${name} already exists`);
    throw err;
  }
}

function toolGetRepo(ctx: ToolContext, args: Json): Json {
  requiredArgs(args, ['owner', 'repo']);
  const repo = findRepoOrThrow(ctx, args.owner, args.repo);
  return repoJson(repo, str(args.owner));
}

function toolCreateIssue(ctx: ToolContext, args: Json): Json {
  requiredArgs(args, ['owner', 'repo', 'title']);
  const repo = findRepoOrThrow(ctx, args.owner, args.repo);
  const issue = ctx.store.createIssue(repo, str(args.title), str(args.body), [], ctx.user);
  return issueJson(issue);
}

function toolListIssues(ctx: ToolContext, args: Json): unknown {
  requiredArgs(args, ['owner', 'repo']);
  const repo = findRepoOrThrow(ctx, args.owner, args.repo);
  const state = str(args.state);
  const wanted = state === '' || state === 'all' ? null : state.toLowerCase();
  const issues = repo.issues.filter((issue) => (wanted === null ? true : issue.state === wanted));
  return issues.map(issueJson);
}

function toolCreatePull(ctx: ToolContext, args: Json): Json {
  requiredArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
  const repo = findRepoOrThrow(ctx, args.owner, args.repo);
  try {
    const pull = ctx.store.createPull(repo, { title: str(args.title), body: str(args.body), head: str(args.head), base: str(args.base) }, ctx.user);
    return pullJson(pull);
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === 'validation') throw new ToolError(ERR_INVALID_PARAMS, (err as Error).message);
    throw err;
  }
}

function toolMergePull(ctx: ToolContext, args: Json): Json {
  requiredArgs(args, ['owner', 'repo', 'pull_number']);
  const repo = findRepoOrThrow(ctx, args.owner, args.repo);
  const number = typeof args.pull_number === 'number' ? args.pull_number : Number(str(args.pull_number));
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) throw new ToolError(ERR_INVALID_PARAMS, `pull request #${number} not found`);
  try {
    ctx.store.mergePull(repo, pull, ctx.user);
  } catch (err) {
    throw new ToolError(ERR_INVALID_PARAMS, 'Pull request is not mergeable');
  }
  return pullJson(pull);
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Json;
  run: (ctx: ToolContext, args: Json) => unknown;
}

/** The tools, static so `tools/list` is byte-identical on every call (idempotent tools/list check). */
const TOOLS: readonly ToolSpec[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user on the forge.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The repository owner login (the authenticated user by default).' },
      },
      required: ['name'],
    },
    run: toolCreateRepo,
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: toolGetRepo,
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: toolCreateIssue,
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all (default all).' },
      },
      required: ['owner', 'repo'],
    },
    run: toolListIssues,
  },
  {
    name: 'create_pull_request',
    description: 'Open a new pull request from one branch onto another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: toolCreatePull,
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: toolMergePull,
  },
]);

function toolListPayload(): Json {
  return {
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  };
}

// ---------------------------------------------------------------- method dispatch

function discoverResult(): Json {
  return {
    resultType: 'discover',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    instructions: 'github-core-clone-01 forge MCP server: repositories, issues and pull requests.',
    serverInfo: SERVER_INFO,
    _meta: {
      protocolVersion: PREFERRED_REVISION,
      'io.modelcontextprotocol/serverInfo': SERVER_INFO,
    },
  };
}

function initializeResult(params: unknown): Json {
  const requested = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : PREFERRED_REVISION;
  const version = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PREFERRED_REVISION;
  return {
    resultType: 'initialize',
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    _meta: {
      protocolVersion: version,
      'io.modelcontextprotocol/serverInfo': SERVER_INFO,
    },
  };
}

/** Handle one JSON-RPC message: a {jsonrpc,id,method,params} object or a notification (no id). */
function dispatch(store: ForgeStore, user: User, message: Json): Json | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const params = isRecord(message.params) ? message.params : {};

  if (method === 'server/discover') return { jsonrpc: JSONRPC_VERSION, id: message.id ?? null, result: discoverResult() };
  if (method === 'initialize') return { jsonrpc: JSONRPC_VERSION, id: message.id ?? null, result: initializeResult(params) };
  if (method === 'notifications/initialized') return null; // notification: no response
  if (method === 'tools/list') return { jsonrpc: JSONRPC_VERSION, id: message.id ?? null, result: toolListPayload() };
  if (method === 'tools/call') {
    const id = message.id ?? null;
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return { jsonrpc: JSONRPC_VERSION, id, error: { code: ERR_METHOD_NOT_FOUND, message: `Unknown tool: ${name}` } };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      const value = tool.run({ store, user }, args);
      return { jsonrpc: JSONRPC_VERSION, id, result: toolResult(value) };
    } catch (err) {
      if (err instanceof ToolError) return { jsonrpc: JSONRPC_VERSION, id, error: { code: err.code, message: err.message } };
      const message = err instanceof Error ? err.message : String(err);
      return { jsonrpc: JSONRPC_VERSION, id, error: { code: ERR_INVALID_PARAMS, message } };
    }
  }
  // Unknown method -> JSON-RPC method not found (a notification gets no body).
  if (message.id === undefined) return null;
  return { jsonrpc: JSONRPC_VERSION, id: message.id, error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
}

// ---------------------------------------------------------------- the HTTP handler

export async function handleMcp(store: ForgeStore, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  if (url.pathname !== '/mcp') return false;

  const method = (req.method ?? 'GET').toUpperCase();

  // A legacy session close (best-effort): nothing to tear down, answer 204.
  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  const token = bearerToken(req);
  const user = userForToken(token);
  if (user === null) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  const body = await readBody(req, 8 * 1024 * 1024);
  const text = body === null ? '' : body.toString('utf8').trim();
  if (text === '') {
    sendJson(res, 400, { jsonrpc: JSONRPC_VERSION, id: null, error: { code: ERR_PARSE, message: 'Parse error' } });
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { jsonrpc: JSONRPC_VERSION, id: null, error: { code: ERR_PARSE, message: 'Parse error' } });
    return true;
  }

  // JSON-RPC batch: an array of messages answered as an array of responses (notifications omitted).
  if (Array.isArray(parsed)) {
    const responses: Json[] = [];
    let anyNotification = false;
    for (const item of parsed) {
      if (!isRecord(item)) {
        responses.push({ jsonrpc: JSONRPC_VERSION, id: null, error: { code: ERR_INVALID_PARAMS, message: 'Invalid Request' } });
        continue;
      }
      const out = dispatch(store, user, item);
      if (out === null) anyNotification = true;
      else responses.push(out);
    }
    if (responses.length === 0 && anyNotification) {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end();
      return true;
    }
    sendJson(res, 200, responses);
    return true;
  }

  if (!isRecord(parsed)) {
    sendJson(res, 200, { jsonrpc: JSONRPC_VERSION, id: null, error: { code: ERR_INVALID_PARAMS, message: 'Invalid Request' } });
    return true;
  }

  const out = dispatch(store, user, parsed);
  if (out === null) {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end();
    return true;
  }
  sendJson(res, 200, out);
  return true;
}