// The forge's GitHub REST v3 surface: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, served under /api/v3. Built on the shared store, the object model and
// the http helpers. Every reply is JSON with the required X-GitHub-Request-Id header.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken, decodeSegments, fromBase64, globalId, queryInt, queryParam, readJson, sendEmpty, sendError, sendJson, toBase64, urlOf } from './http.ts';
import { parseCommit } from './objects.ts';
import { type Comment, type ForgeStore, type Issue, type Pull, type Repo, type User, userForToken, VIEWER } from './store.ts';

// ---------------------------------------------------------------- helpers

function repoOf(store: ForgeStore, owner: string, name: string): Repo | null {
  return store.findRepo(owner, name);
}

function toRepoJson(repo: Repo, owner: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    has_issues: true,
  };
}

function toUserJson(user: User): Record<string, unknown> {
  return { login: user.login, id: user.id, type: 'User' };
}

function toLabelJson(label: { id: number; name: string; color: string; description: string }): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

function toIssueJson(repo: Repo, issue: Issue, owner: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'open' ? null : 'completed',
    labels: issue.labels
      .map((name) => {
        const label = repo.labels.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
        return label !== undefined ? toLabelJson(label) : { id: 0, name, color: '000000', description: '' };
      }),
    user: toUserJson(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
  };
}

function toCommentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('Comment', comment.id),
    body: comment.body,
    user: toUserJson(comment.user),
    created_at: comment.createdAt,
  };
}

function toPullJson(pull: Pull, owner: string): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, repo: null },
    base: { ref: pull.base, sha: pull.baseSha, repo: null },
    user: toUserJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function shaShape(sha: string): Record<string, unknown> {
  return { sha };
}

// ---------------------------------------------------------------- routing

// ---------------------------------------------------------------- repository handlers

function handleCreateRepo(store: ForgeStore, res: ServerResponse, body: unknown, owner: string): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendError(res, 422, 'Validation Failed');
    return;
  }
  const record = body as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== 'string' || name.trim() === '') {
    sendError(res, 422, 'Validation Failed');
    return;
  }
  try {
    const repo = store.createRepo(owner, name, {
      description: typeof record.description === 'string' ? record.description : '',
      private: record.private === true,
      defaultBranch: typeof record.default_branch === 'string' && record.default_branch !== '' ? record.default_branch : 'main',
    });
    sendJson(res, 201, toRepoJson(repo, owner));
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === 'exists') sendError(res, 422, 'Repository already exists.');
    else sendError(res, 422, 'Validation Failed');
  }
}

function branchCommits(repo: Repo, branch: string): string[] {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  return oid === undefined ? [] : [oid];
}

// A commit entry for the /commits listing: the tip commit object.
function commitJson(store: ForgeStore, repo: Repo, oid: string): Record<string, unknown> | null {
  const object = store.getObject(repo, oid);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      message: commit.message.replace(/\n$/, ''),
      author: { name: commit.author, email: '', date: '' },
      committer: { name: commit.committer, email: '', date: '' },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------- the REST router

export async function handleRest(store: ForgeStore, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = urlOf(req);
  const path = url.pathname;
  if (!path.startsWith('/api/v3')) return false;

  // Auth is enforced for every /api/v3 route.
  const token = bearerToken(req);
  const user: User | null = userForToken(token);
  if (user === null) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const relative = path.slice('/api/v3'.length);
  const segments = decodeSegments(relative);

  // GET /
  if (relative === '/' || relative === '') {
    if (method !== 'GET') return reply405(res);
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issues_url: '/api/v3/issues',
    }, { 'x-oauth-scopes': 'repo' });
    return true;
  }

  // GET /meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return reply405(res);
    sendJson(res, 200, { installed_version: 'forge-1.0.0' });
    return true;
  }

  // GET /user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return reply405(res);
    sendJson(res, 200, toUserJson(user));
    return true;
  }

  // POST /user/repos, GET /user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const body = await readJson(req);
      if (body === undefined) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      handleCreateRepo(store, res, body, user.login);
      return true;
    }
    if (method === 'GET') {
      const perPage = queryInt(url, 'per_page', 30);
      const page = queryInt(url, 'page', 1);
      const all = store.listRepos(user.login);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const next = `${url.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const last = `${url.origin}/api/v3/user/repos?per_page=${perPage}&page=${Math.max(1, Math.ceil(all.length / perPage))}`;
        headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
      }
      sendJson(res, 200, slice.map((repo) => toRepoJson(repo, user.login)), headers);
      return true;
    }
    return reply405(res);
  }

  // /repos/{owner}/{repo}...
  if (segments.length >= 2 && segments[0] === 'repos') {
    return handleRepos(store, req, res, segments.slice(1), user, url, method);
  }

  // Unknown /api/v3 route -> JSON 404.
  sendError(res, 404, 'Not Found');
  return true;
}

function reply405(res: ServerResponse): boolean {
  sendError(res, 405, 'Method Not Allowed');
  return true;
}

// ---------------------------------------------------------------- /repos/{owner}/{repo}/...

async function handleRepos(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  user: User,
  url: URL,
  method: string,
): Promise<boolean> {
  const owner = segments[0] ?? '';
  const name = segments[1] ?? '';
  const repo = repoOf(store, owner, name);
  const rest = segments.slice(2);

  // Missing repo: 404 for any sub-path (GET /repos/{o}/{r} and every deeper route).
  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, toRepoJson(repo, owner));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (body !== undefined && typeof body === 'object' && body !== null && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        if (typeof record.description === 'string') repo.description = record.description;
        if (typeof record.name === 'string' && record.name !== '') repo.name = record.name;
        repo.updatedAt = store.nowIso();
      }
      sendJson(res, 200, toRepoJson(repo, owner));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      sendEmpty(res, 204);
      return true;
    }
    return reply405(res);
  }

  // POST /repos/{o}/{r}/git/refs
  if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
    const body = await readJson(req);
    if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendError(res, 422, 'Validation Failed');
      return true;
    }
    const record = body as Record<string, unknown>;
    const ref = record.ref;
    const sha = record.sha;
    if (typeof ref !== 'string' || typeof sha !== 'string') {
      sendError(res, 422, 'Validation Failed');
      return true;
    }
    store.createRef(repo, ref, sha);
    sendJson(res, 201, { ref, node_id: '', url: '', object: { type: 'commit', sha } });
    return true;
  }

  // GET/HEAD /repos/{o}/{r}/git/refs/heads/{branch}
  if (rest.length >= 4 && rest[0] === 'git' && rest[1] === 'refs') {
    if (rest[2] === 'heads' && rest.length === 4 && method === 'GET') {
      const branch = rest[3] ?? '';
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: oid } });
      return true;
    }
  }

  // GET /repos/{o}/{r}/branches
  if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
    const branches: Record<string, unknown>[] = [];
    for (const [refName, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!refName.startsWith('refs/heads/')) continue;
      branches.push({ name: refName.slice('refs/heads/'.length), commit: { sha: oid } });
    }
    sendJson(res, 200, branches);
    return true;
  }

  // GET /repos/{o}/{r}/branches/{branch}
  if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
    const branch = rest[1] ?? '';
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { name: branch, commit: { sha: oid } });
    return true;
  }

  // GET /repos/{o}/{r}/commits
  if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
    const sha = queryParam(url, 'sha');
    const ref = sha ?? repo.defaultBranch;
    const oid = repo.refs.get(`refs/heads/${ref}`) ?? (repo.refs.has(ref) ? (repo.refs.get(ref) as string) : undefined);
    if (oid === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const history = store.history(repo, oid, queryInt(url, 'per_page', 30));
    const commits = history.map((c) => commitJson(store, repo, c)).filter((c): c is Record<string, unknown> => c !== null);
    sendJson(res, 200, commits);
    return true;
  }

  // Contents API: /repos/{o}/{r}/contents/{path}
  if (rest[0] === 'contents') {
    return handleContents(store, req, res, repo, owner, rest.slice(1), method, url);
  }

  // Labels: POST/GET /repos/{o}/{r}/labels
  if (rest.length === 1 && rest[0] === 'labels') {
    if (method === 'POST') {
      const body = await readJson(req);
      if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      const record = body as Record<string, unknown>;
      const labelName = record.name;
      if (typeof labelName !== 'string' || labelName === '') {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      const label = store.addLabel(repo, labelName, typeof record.color === 'string' ? record.color : 'ededed', typeof record.description === 'string' ? record.description : '');
      sendJson(res, 201, toLabelJson(label));
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, repo.labels.map(toLabelJson));
      return true;
    }
    return reply405(res);
  }

  // Issues: POST/GET /repos/{o}/{r}/issues
  if (rest.length === 1 && rest[0] === 'issues') {
    if (method === 'POST') {
      const body = await readJson(req);
      if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      const record = body as Record<string, unknown>;
      const title = record.title;
      if (typeof title !== 'string' || title === '') {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      const labels: string[] = Array.isArray(record.labels) ? (record.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      const bad = labels.find((label) => !store.hasLabel(repo, label));
      if (bad !== undefined) {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      const issue = store.createIssue(repo, title, typeof record.body === 'string' ? record.body : '', labels, user);
      sendJson(res, 201, toIssueJson(repo, issue, owner));
      return true;
    }
    if (method === 'GET') {
      const state = queryParam(url, 'state') ?? 'open';
      const sort = queryParam(url, 'sort') ?? 'created';
      const direction = queryParam(url, 'direction') ?? 'desc';
      const perPage = queryInt(url, 'per_page', 30);
      let issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      if (sort === 'created') {
        issues = [...issues].sort((a, b) => (direction === 'asc' ? a.id - b.id : b.id - a.id));
      }
      sendJson(res, 200, issues.slice(0, perPage).map((issue) => toIssueJson(repo, issue, owner)));
      return true;
    }
    return reply405(res);
  }

  // Issues: /repos/{o}/{r}/issues/{n}[/comments]
  if (rest.length >= 2 && rest[0] === 'issues' && /^\d+$/.test(rest[1] ?? '')) {
    const number = Number(rest[1]);
    const issue = store.findIssue(repo, number);
    if (issue === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 2) {
      if (method === 'GET') {
        sendJson(res, 200, toIssueJson(repo, issue, owner));
        return true;
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        if (body !== undefined && typeof body === 'object' && body !== null && !Array.isArray(body)) {
          const record = body as Record<string, unknown>;
          if (typeof record.state === 'string') {
            const state = record.state === 'closed' ? 'closed' : 'open';
            if (issue.state !== state) {
              issue.state = state;
              issue.closedAt = state === 'closed' ? store.nowIso() : null;
              issue.updatedAt = store.nowIso();
            }
          }
          if (typeof record.title === 'string') issue.title = record.title;
          if (typeof record.body === 'string') issue.body = record.body;
        }
        sendJson(res, 200, toIssueJson(repo, issue, owner));
        return true;
      }
      return reply405(res);
    }
    // /issues/{n}/comments
    if (rest[2] === 'comments') {
      if (method === 'POST') {
        const body = await readJson(req);
        if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
          sendError(res, 422, 'Validation Failed');
          return true;
        }
        const commentBody = (body as Record<string, unknown>).body;
        if (typeof commentBody !== 'string' || commentBody === '') {
          sendError(res, 422, 'Validation Failed');
          return true;
        }
        const comment = store.addComment(repo, issue, commentBody, user);
        sendJson(res, 201, toCommentJson(comment));
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map(toCommentJson));
        return true;
      }
      return reply405(res);
    }
  }

  // Pulls: POST/GET /repos/{o}/{r}/pulls
  if (rest.length === 1 && rest[0] === 'pulls' && method === 'POST') {
    const body = await readJson(req);
    if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendError(res, 422, 'Validation Failed');
      return true;
    }
    const record = body as Record<string, unknown>;
    const title = record.title;
    const head = record.head;
    const base = record.base;
    if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
      sendError(res, 422, 'Validation Failed');
      return true;
    }
    try {
      const pull = store.createPull(repo, { title, body: typeof record.body === 'string' ? record.body : '', head, base }, user);
      sendJson(res, 201, toPullJson(pull, owner));
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'validation') sendError(res, 422, 'Validation Failed');
      else sendError(res, 422, 'Validation Failed');
    }
    return true;
  }

  if (rest.length === 1 && rest[0] === 'pulls' && method === 'GET') {
    const state = queryParam(url, 'state') ?? 'open';
    const perPage = queryInt(url, 'per_page', 30);
    let pulls = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
    pulls = [...pulls].sort((a, b) => a.id - b.id);
    sendJson(res, 200, pulls.slice(0, perPage).map((pull) => toPullJson(pull, owner)));
    return true;
  }

  // Pulls: /repos/{o}/{r}/pulls/{n}[/files|/merge]
  if (rest[0] === 'pulls' && rest.length >= 2 && /^\d+$/.test(rest[1] ?? '')) {
    const number = Number(rest[1]);
    const pull = store.findPull(repo, number);
    if (pull === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, 200, toPullJson(pull, owner));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const baseTree = store.treeOf(repo, pull.baseSha);
      const headTree = store.treeOf(repo, pull.headSha);
      const files = store.diffTrees(repo, baseTree, headTree);
      sendJson(res, 200, files.map((file) => ({
        filename: file.path,
        status: file.status === 'added' ? 'added' : file.status === 'removed' ? 'removed' : 'modified',
        additions: file.additions,
        deletions: file.deletions,
        changes: file.additions + file.deletions,
      })));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      try {
        const mergeSha = store.mergePull(repo, pull, user);
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code === 'conflict') sendError(res, 405, 'Pull Request is not mergeable');
        else sendError(res, 405, 'Pull Request is not mergeable');
      }
      return true;
    }
  }

  // Unknown sub-route under an existing repo: JSON 404.
  sendError(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------- contents

async function handleContents(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  owner: string,
  pathSegments: string[],
  method: string,
  url: URL,
): Promise<boolean> {
  const path = pathSegments.join('/');
  const ref = queryParam(url, 'ref') ?? repo.defaultBranch;
  const refOid = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);

  if (method === 'GET') {
    if (refOid === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    // Directory or file?
    const blobOid = store.fileAt(repo, refOid, path);
    if (blobOid !== null) {
      const bytes = store.blobBytes(repo, blobOid);
      const content = bytes === null ? '' : bytes.toString('utf8');
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: Buffer.byteLength(content, 'utf8'),
        name: path.split('/').pop() ?? '',
        path,
        content: toBase64(content),
        sha: blobOid,
      });
      return true;
    }
    // Try directory listing.
    const entries = store.treeEntriesAt(repo, refOid, path);
    if (entries.length > 0 || store.fileAt(repo, refOid, path) !== null) {
      sendJson(res, 200, entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : store.blobBytes(repo, entry.oid)?.length ?? 0,
      })));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (method === 'PUT') {
    const body = await readJson(req);
    if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendError(res, 422, 'Validation Failed');
      return true;
    }
    const record = body as Record<string, unknown>;
    const message = record.message;
    const contentB64 = record.content;
    if (typeof message !== 'string' || typeof contentB64 !== 'string') {
      sendError(res, 422, 'Validation Failed');
      return true;
    }
    const branch = typeof record.branch === 'string' && record.branch !== '' ? record.branch : ref;
    const content = fromBase64(contentB64).toString('utf8');

    // Stale sha check: if a sha is provided it must be the current blob sha.
    const branchRef = `refs/heads/${branch}`;
    const branchOid = repo.refs.get(branchRef);
    if (branchOid !== undefined && record.sha !== undefined) {
      const current = store.fileAt(repo, branchOid, path);
      if (current !== record.sha) {
        sendError(res, 409, 'sha does not match');
        return true;
      }
    }

    const commitOid = store.commitChanges(repo, branch, [{ path, content }], message, VIEWER);
    const blobOid = store.fileAt(repo, commitOid, path) ?? '';
    const isNew = branchOid === undefined || store.fileAt(repo, branchOid, path) === null;
    sendJson(res, isNew ? 201 : 200, {
      content: { name: path.split('/').pop() ?? '', path, sha: blobOid, size: Buffer.byteLength(content, 'utf8'), type: 'file', encoding: 'base64' },
      commit: { sha: commitOid, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = await readJson(req);
    if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendError(res, 422, 'Validation Failed');
      return true;
    }
    const record = body as Record<string, unknown>;
    const message = record.message;
    if (typeof message !== 'string') {
      sendError(res, 422, 'Validation Failed');
      return true;
    }
    const branchRef = `refs/heads/${ref}`;
    const branchOid = repo.refs.get(branchRef);
    if (branchOid === undefined || store.fileAt(repo, branchOid, path) === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const commitOid = store.commitChanges(repo, ref, [{ path, content: null }], message, VIEWER);
    sendJson(res, 200, { commit: { sha: commitOid, message }, content: null });
    return true;
  }

  return reply405(res);
}