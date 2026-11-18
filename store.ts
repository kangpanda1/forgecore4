// The forge's in-memory store: repositories, git objects and refs, issues, labels, comments and pull
// requests — the single source of truth every surface (git HTTP, REST, GraphQL, MCP) reads and writes.
// Deterministic: ids and timestamps come from counters, never from Math.random or the wall clock.

import { buildCommit, buildTree, hashObject, parseCommit, parseTree, collectReachable, findTreePath, type GitObject, type GitObjectType, type TreeEntry } from './objects.ts';

/** The fixed epoch every generated timestamp derives from (no wall clock anywhere). */
export const EPOCH_SEC = 1_735_689_600;

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The one identity the trial's bearer token names (the seeded scenario's viewer). */
export const VIEWER: User = Object.freeze({ id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' });

export interface Comment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  user: User;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  labels: Label[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

export interface UserRepo {
  name: string;
  private: boolean;
  description: string;
  createdAt: string;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

/** A request's authenticated identity; every valid token maps to the one seeded viewer. */
export function userForToken(token: string | null): User | null {
  if (token === null || token.trim() === '') return null;
  return VIEWER;
}

export class ForgeStore {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 900000;
  private nextPullId = 700000;
  private nextLabelId = 300000;
  private nextCommentId = 9000000;
  private clock = 0;

  /** The next deterministic ISO timestamp (strictly increasing). */
  nowIso(): string {
    this.clock += 1;
    return new Date((EPOCH_SEC + this.clock) * 1000).toISOString();
  }

  /** The next deterministic epoch second (strictly increasing). */
  nowEpoch(): number {
    this.clock += 1;
    return EPOCH_SEC + this.clock;
  }

  findRepo(owner: string, name: string): Repo | null {
    return this.repos.get(repoKey(owner, name)) ?? null;
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    return out.sort((a, b) => a.id - b.id);
  }

  allRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repo {
    const existing = this.findRepo(owner, name);
    if (existing !== null) {
      const error = new Error('repository already exists') as Error & { code?: string };
      error.code = 'exists';
      throw error;
    }
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      labels: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Uint8Array): string {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const oid = hashObject(type, body);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: body });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The commit a ref points at, or null when the ref is absent / not a commit. */
  refCommit(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** All refs, sorted by name, with an unborn HEAD for an empty repository. */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return refs;
  }

  /** The commit's tree oid, or null. */
  treeOf(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** The blob oid at `path` in the commit's tree, or null. */
  fileAt(repo: Repo, commitOid: string, path: string): string | null {
    const tree = this.treeOf(repo, commitOid);
    if (tree === null) return null;
    return findTreePath((oid) => repo.objects.get(oid), tree, path.split('/'));
  }

  /** Read a blob's bytes, or null. */
  blobBytes(repo: Repo, oid: string): Buffer | null {
    const object = repo.objects.get(oid);
    return object && object.type === 'blob' ? object.data : null;
  }

  /** Replace (or insert) `path` in the tree, returning the new root tree oid. `blobOid` null deletes. */
  private setPath(repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string | null): string {
    const existing: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
    const head = segments[0] as string;
    const rest = segments.slice(1);
    const others = existing.filter((entry) => entry.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) others.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const dir = existing.find((entry) => entry.name === head && entry.mode === '40000');
      const child = this.setPath(repo, dir ? dir.oid : null, rest, blobOid);
      const childEntries = parseTree(repo.objects.get(child)?.data ?? Buffer.alloc(0));
      if (childEntries.length > 0) others.push({ mode: '40000', name: head, oid: child });
    }
    return this.putObject(repo, 'tree', buildTree(others));
  }

  /**
   * Commit a set of changes on `branch`. `changes` maps a repository path to its new text (delete with
   * null). Creates the branch's first commit when it does not exist yet.
   */
  commitChanges(
    repo: Repo,
    branch: string,
    changes: ReadonlyArray<{ path: string; content: string | null }>,
    message: string,
    author: User,
  ): string {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref) ?? null;
    let tree = parent === null ? null : this.treeOf(repo, parent);
    for (const change of changes) {
      const segments = change.path.split('/').filter((segment) => segment !== '');
      if (segments.length === 0) continue;
      const blobOid = change.content === null ? null : this.putObject(repo, 'blob', Buffer.from(change.content, 'utf8'));
      tree = this.setPath(repo, tree, segments, blobOid);
    }
    if (tree === null) tree = EMPTY_TREE;
    const stamp = this.nowEpoch();
    const identity = `${author.name} <${author.email}> ${stamp} +0000`;
    const data = buildCommit({
      tree,
      parents: parent === null ? [] : [parent],
      author: identity,
      committer: identity,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const commitOid = this.putObject(repo, 'commit', data);
    repo.refs.set(ref, commitOid);
    repo.updatedAt = this.nowIso();
    return commitOid;
  }

  /** Create a ref at an existing commit. */
  createRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.updatedAt = this.nowIso();
  }

  /** Commit ancestry from `oid` following first-parent order (newest first), bounded by `limit`. */
  history(repo: Repo, oid: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [oid];
    while (queue.length > 0 && out.length < limit) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') continue;
      out.push(current);
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** Whether `ancestor` is reachable from `descendant` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.history(repo, descendant).includes(ancestor);
  }

  /** Every object reachable from the given tips. */
  reachable(repo: Repo, tips: readonly string[]): Set<string> {
    return collectReachable(tips, (oid) => repo.objects.get(oid));
  }

  /** A commit's changed paths against its first parent, with line counts. */
  diffCommit(repo: Repo, commitOid: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return [];
    const commit = parseCommit(object.data);
    const parentTree = commit.parents.length > 0 ? this.treeOf(repo, commit.parents[0] as string) : null;
    return this.diffTrees(repo, parentTree, commit.tree);
  }

  /** Every path that differs between two trees, with line counts. */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> = [];
    for (const path of [...paths].sort()) {
      const before = base.get(path);
      const after = head.get(path);
      if (before === undefined && after === undefined) continue;
      if (before === after) continue;
      const oldText = before === undefined ? '' : (this.blobBytes(repo, before)?.toString('utf8') ?? '');
      const newText = after === undefined ? '' : (this.blobBytes(repo, after)?.toString('utf8') ?? '');
      const oldLines = oldText === '' ? [] : oldText.split('\n');
      const newLines = newText === '' ? [] : newText.split('\n');
      if (before === undefined) out.push({ path, status: 'added', additions: Math.max(1, newLines.length), deletions: 0 });
      else if (after === undefined) out.push({ path, status: 'removed', additions: 0, deletions: Math.max(1, oldLines.length) });
      else out.push({ path, status: 'modified', additions: Math.max(1, newLines.length), deletions: Math.max(1, oldLines.length) });
    }
    return out;
  }

  /** A tree flattened to path -> blob oid (directories descended). */
  flattenTree(repo: Repo, treeOid: string | null, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    if (treeOid === null) return out;
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [childPath, oid] of this.flattenTree(repo, entry.oid, path)) out.set(childPath, oid);
      } else if (entry.mode !== '160000') {
        out.set(path, entry.oid);
      }
    }
    return out;
  }

  /** A commit tree's direct entries at `path` (empty string for the root), for the contents listing. */
  treeEntriesAt(repo: Repo, commitOid: string, path: string): TreeEntry[] {
    const treeOid = this.treeOf(repo, commitOid);
    if (treeOid === null) return [];
    let current = treeOid;
    const segments = path.split('/').filter((segment) => segment !== '');
    for (const segment of segments) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return [];
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return [];
      current = entry.oid;
    }
    const object = repo.objects.get(current);
    return object && object.type === 'tree' ? parseTree(object.data) : [];
  }

  // ---------------------------------------------------------------- issues, labels, comments

  addLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const existing = repo.labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (existing !== undefined) return existing;
    const label: Label = { id: this.nextLabelId++, name, color: color.replace(/^#/, ''), description };
    repo.labels.push(label);
    return label;
  }

  hasLabel(repo: Repo, name: string): boolean {
    return repo.labels.some((label) => label.name.toLowerCase() === name.toLowerCase());
  }

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[], user: User): Issue {
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.find((issue) => issue.number === number) ?? null;
  }

  addComment(repo: Repo, issue: Issue, body: string, user: User): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, user, createdAt: this.nowIso() };
    issue.comments.push(comment);
    issue.updatedAt = this.nowIso();
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  /** Whether `head` can be squashed onto `base` (the base tip is an ancestor of the head tip). */
  mergeable(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (baseTip === undefined || headTip === undefined) return false;
    return this.isAncestor(repo, baseTip, headTip);
  }

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string }, user: User): Pull {
    const headSha = repo.refs.get(`refs/heads/${input.head}`);
    const baseSha = repo.refs.get(`refs/heads/${input.base}`);
    if (headSha === undefined) {
      const error = new Error(`head branch ${input.head} does not exist`) as Error & { code?: string };
      error.code = 'validation';
      throw error;
    }
    if (baseSha === undefined) {
      const error = new Error(`base branch ${input.base} does not exist`) as Error & { code?: string };
      error.code = 'validation';
      throw error;
    }
    const now = this.nowIso();
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextPullNumber++,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: input.head,
      base: input.base,
      headSha,
      baseSha,
      user,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo: Repo, number: number): Pull | null {
    return repo.pulls.find((pull) => pull.number === number) ?? null;
  }

  /** Squash-merge a pull request onto its base branch. Throws {code:'conflict'} when not mergeable. */
  mergePull(repo: Repo, pull: Pull, user: User): string {
    if (!this.mergeable(repo, pull)) {
      const error = new Error('Pull Request is not mergeable') as Error & { code?: string };
      error.code = 'conflict';
      throw error;
    }
    const headTip = repo.refs.get(`refs/heads/${pull.head}`) as string;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`) as string;
    const headTree = this.treeOf(repo, headTip);
    const stamp = this.nowEpoch();
    const identity = `${user.name} <${user.email}> ${stamp} +0000`;
    const data = buildCommit({
      tree: headTree ?? EMPTY_TREE,
      parents: [baseTip],
      author: identity,
      committer: identity,
      message: `${pull.title} (#${pull.number})\n`,
    });
    const sha = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    repo.updatedAt = pull.mergedAt;
    return sha;
  }
}
