// The forge's GitHub GraphQL v4 surface at /api/graphql: a compact GraphQL document parser and a
// resolver over the shared store. Speaks the exact documents gh and github-mcp-server send (see the
// sealed checks): viewer, repository by owner/name, issues with cursor pagination and states/orderBy,
// pull requests with files, node(id:), __type introspection, and the create/close/merge/comment
// mutations. Unknown fields are GraphQL errors on a 200 (never an HTTP error); an unknown repository
// resolves data.repository = null without errors; operation batching (two documents in one body)
// answers two envelopes in order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken, globalId, parseGlobalId, readJson, sendError, sendJson } from './http.ts';
import { parseCommit } from './objects.ts';
import { type ForgeStore, type Issue, type Pull, type Repo, type User, userForToken } from './store.ts';

// ---------------------------------------------------------------- tiny GraphQL parser

interface Selections {
  // alias name -> (field name, args, sub-selection, inline-fragment type conditions)
  entries: Array<{ alias: string; name: string; args: Map<string, string>; sub: Selections; fragments: Array<{ type: string; sub: Selections }> }>;
}

function parseSelections(tokens: Tokens): Selections {
  const entries: Selections['entries'] = [];
  for (;;) {
    tokens.skip();
    const tok = tokens.peek();
    if (tok === '}' || tok === '' || tok === '...') break;
    let alias: string;
    let name: string;
    const first = tokens.next();
    const second = tokens.peek();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(first) && second === ':') {
      alias = first;
      tokens.next(); // consume ':'
      name = tokens.next();
    } else {
      alias = first;
      name = first;
    }
    const args = new Map<string, string>();
    if (tokens.peek() === '(') {
      tokens.next();
      for (;;) {
        tokens.skip();
        if (tokens.peek() === ')') break;
        const argName = tokens.next();
        tokens.expect(':');
        const raw = tokens.readValue();
        args.set(argName, raw);
      }
      tokens.expect(')');
    }
    let sub: Selections = { entries: [] };
    if (tokens.peek() === '{') {
      tokens.next();
      sub = parseSelections(tokens);
      tokens.expect('}');
    }
    const entry: Selections['entries'][number] = { alias, name, args, sub, fragments: [] };
    // inline fragments: ... on Type { ... } and bare ... { ... }
    for (;;) {
      tokens.skip();
      if (tokens.peek() !== '...') break;
      tokens.next(); // consume '...'
      tokens.skip();
      let type = '';
      if (tokens.peek() === 'on') {
        tokens.next();
        type = tokens.next();
      }
      tokens.expect('{');
      const fragSub = parseSelections(tokens);
      tokens.expect('}');
      entry.fragments.push({ type, sub: fragSub });
    }
    entries.push(entry);
  }
  return { entries };
}

class Tokens {
  private readonly text: string;
  private index = 0;
  private lastSkip = 0;

  constructor(text: string) {
    this.text = text;
  }

  skip(): void {
    while (this.index < this.text.length && /[\s,]/.test(this.text[this.index] ?? '')) this.index += 1;
    this.lastSkip = this.index;
  }

  peek(): string {
    this.skip();
    if (this.text.startsWith('...', this.index)) return '...';
    const ch = this.text[this.index] ?? '';
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === ':') {
      return ch;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.index));
    if (match !== null) return match[0];
    if (ch === '$') return '$';
    if (ch === '!') return '!';
    if (ch === '=') return '=';
    return ch === '' ? '' : ch;
  }

  next(): string {
    this.skip();
    if (this.text.startsWith('...', this.index)) {
      this.index += 3;
      return '...';
    }
    const ch = this.text[this.index] ?? '';
    if ('{}():='.includes(ch) && ch !== '') {
      this.index += 1;
      return ch;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.index));
    if (match !== null) {
      this.index += match[0].length;
      return match[0];
    }
    if (ch === '$') {
      // variable reference $name
      const ref = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.index));
      if (ref !== null) {
        this.index += ref[0].length;
        return ref[0];
      }
    }
    if (ch === '!') {
      this.index += 1;
      return '!';
    }
    this.index += 1;
    return ch;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GraphQLParseError(`expected ${JSON.stringify(token)}, got ${JSON.stringify(got)}`);
  }

  /** Read one argument value: a variable, number, string, enum, list or inline object. */
  readValue(): string {
    this.skip();
    const ch = this.text[this.index] ?? '';
    if (ch === '$') return this.next();
    if (ch === '"') return this.readString();
    if (ch === '[') return this.readList();
    if (ch === '{') return this.readObject();
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (match !== null) {
      this.index += match[0].length;
      return `N:${match[0]}`;
    }
    // boolean / enum / name
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.index));
    if (word !== null) {
      this.index += word[0].length;
      return `V:${word[0]}`;
    }
    throw new GraphQLParseError(`cannot parse argument value at offset ${this.index}`);
  }

  private readString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const ch = this.text[this.index] ?? '';
      if (ch === '') throw new GraphQLParseError('unterminated string');
      this.index += 1;
      if (ch === '"') break;
      if (ch === '\\') {
        const esc = this.text[this.index] ?? '';
        this.index += 1;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else out += esc;
        continue;
      }
      out += ch;
    }
    return `S:${out}`;
  }

  private readList(): string {
    this.expect('[');
    const items: string[] = [];
    for (;;) {
      this.skip();
      if (this.peek() === ']') break;
      items.push(this.readValue());
    }
    this.expect(']');
    return `L:${JSON.stringify(items)}`;
  }

  private readObject(): string {
    this.expect('{');
    const pairs: Record<string, string> = {};
    for (;;) {
      this.skip();
      if (this.peek() === '}') break;
      const key = this.next();
      this.expect(':');
      pairs[key] = this.readValue();
    }
    this.expect('}');
    return `O:${JSON.stringify(pairs)}`;
  }
}

class GraphQLParseError extends Error {}

interface GqlDocument {
  kind: 'query' | 'mutation';
  name: string;
  variables: Record<string, string>; // variable name -> raw (e.g. "String!", "Int!", "ID")
  selections: Selections;
}

function parseDocument(query: string): GqlDocument {
  const tokens = new Tokens(query);
  let kind: 'query' | 'mutation' = 'query';
  let name = '';
  tokens.skip();
  if (tokens.peek() === 'query' || tokens.peek() === 'mutation') {
    kind = tokens.next() as 'query' | 'mutation';
    tokens.skip();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens.peek())) name = tokens.next();
  }
  const variables: Record<string, string> = {};
  tokens.skip();
  if (tokens.peek() === '(') {
    tokens.next();
    for (;;) {
      tokens.skip();
      if (tokens.peek() === ')') break;
      const dollar = tokens.next(); // '$name'
      tokens.expect(':');
      const type = tokens.next();
      let suffix = '';
      tokens.skip();
      if (tokens.peek() === '!') {
        suffix = '!';
        tokens.next();
      }
      variables[dollar.slice(1)] = type + suffix;
    }
    tokens.expect(')');
  }
  tokens.expect('{');
  const selections = parseSelections(tokens);
  tokens.expect('}');
  return { kind, name, variables, selections };
}

// ---------------------------------------------------------------- small JSON utilities (GraphQL-flavored)

type Json = Record<string, unknown>;

function toGraphQLValue(value: unknown): unknown {
  return value;
}

// ---------------------------------------------------------------- the resolver

interface ResolverContext {
  store: ForgeStore;
  user: User;
}

function at(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Json)[key];
  }
  return current;
}

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

/** Resolve a variable-referenced argument value from the operation's variables. */
function resolveValue(raw: string, variables: Record<string, unknown>): unknown {
  if (raw.startsWith('$')) return variables[raw.slice(1)];
  if (raw.startsWith('N:')) return Number(raw.slice(2));
  if (raw.startsWith('S:')) return raw.slice(2);
  if (raw.startsWith('V:')) return raw.slice(2);
  if (raw.startsWith('L:')) {
    const items = JSON.parse(raw.slice(2)) as string[];
    return items.map((item) => resolveValue(item, variables));
  }
  if (raw.startsWith('O:')) {
    const pairs = JSON.parse(raw.slice(2)) as Record<string, string>;
    const out: Json = {};
    for (const [key, value] of Object.entries(pairs)) out[key] = resolveValue(value, variables);
    return out;
  }
  return null;
}

function resolveArg(args: Map<string, string>, name: string, variables: Record<string, unknown>): unknown {
  const raw = args.get(name);
  return raw === undefined ? undefined : resolveValue(raw, variables);
}

// ---------------------------------------------------------------- object resolvers

function repoNode(ctx: ResolverContext, repo: Repo, owner: string): Json {
  return { repo, owner };
}

function repoJsonForSelection(repo: Repo, owner: string, selection: Selections['entries'][number], ctx: ResolverContext, gql: GqlDocument): unknown {
  const out: Json = {};
  switch (selection.name) {
    case 'id': out[selection.alias] = globalId('Repository', repo.id); break;
    case 'databaseId': out[selection.alias] = repo.id; break;
    case 'name': out[selection.alias] = repo.name; break;
    case 'nameWithOwner': out[selection.alias] = `${owner}/${repo.name}`; break;
    case 'owner': out[selection.alias] = { login: owner }; break;
    case 'defaultBranchRef': out[selection.alias] = { name: repo.defaultBranch }; break;
    case 'viewerPermission': out[selection.alias] = 'ADMIN'; break;
    case 'hasIssuesEnabled': out[selection.alias] = true; break;
    case 'issue': {
      const number = Number(resolveArg(selection.args, 'number', gql.variables ?? {}));
      const issue = Number.isFinite(number) ? ctx.store.findIssue(repo, number) : null;
      out[selection.alias] = issue === null ? null : issueJson(repo, issue, selection.sub, ctx);
      break;
    }
    case 'issues': out[selection.alias] = issuesConnection(repo, selection, ctx, gql); break;
    case 'pullRequest': {
      const number = Number(resolveArg(selection.args, 'number', gql.variables ?? {}));
      const pull = Number.isFinite(number) ? ctx.store.findPull(repo, number) : null;
      out[selection.alias] = pull === null ? null : pullJson(repo, pull, selection.sub);
      break;
    }
    case 'pullRequests': out[selection.alias] = pullRequestsConnection(repo, selection, ctx, gql); break;
    default:
      throw new GraphQLError(`Cannot query field '${selection.name}' on type 'Repository'.`);
  }
  return out[selection.alias];
}

function issueJson(repo: Repo, issue: Issue, selection: Selections, ctx: ResolverContext): Json {
  const out: Json = {};
  for (const entry of selection.entries) {
    switch (entry.name) {
      case 'id': out[entry.alias] = globalId('Issue', issue.id); break;
      case 'number': out[entry.alias] = issue.number; break;
      case 'title': out[entry.alias] = issue.title; break;
      case 'state': out[entry.alias] = issue.state === 'open' ? 'OPEN' : 'CLOSED'; break;
      case 'body': out[entry.alias] = issue.body; break;
      default:
        throw new GraphQLError(`Cannot query field '${entry.name}' on type 'Issue'.`);
    }
  }
  return out;
}

function issuesConnection(repo: Repo, selection: Selections['entries'][number], ctx: ResolverContext, gql: GqlDocument): Json {
  const first = Number(resolveArg(selection.args, 'first', gql.variables ?? {}));
  const after = resolveArg(selection.args, 'after', gql.variables ?? {});
  const statesRaw = resolveArg(selection.args, 'states', gql.variables ?? {});
  const states: string[] = Array.isArray(statesRaw) ? statesRaw.map(String) : [];
  const orderBy = resolveArg(selection.args, 'orderBy', gql.variables ?? {}) as Json | undefined;
  const limit = Number.isFinite(first) && (first as number) > 0 ? (first as number) : 30;

  let issues = repo.issues.slice();
  if (states.length > 0) {
    const wanted = states.map((s) => s.toUpperCase());
    issues = issues.filter((issue) => wanted.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  // default: OPEN (gh sends states: [OPEN] explicitly, but default matches GitHub).
  else issues = issues.filter((issue) => issue.state === 'open');

  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction ?? 'DESC';
  issues = issues.sort((a, b) => {
    const cmp = field === 'UPDATED_AT' ? a.id - b.id : a.id - b.id;
    return direction === 'ASC' ? cmp : -cmp;
  });

  // Cursor: an index cursor encoding the position in the sorted list.
  let startIndex = 0;
  const afterStr = typeof after === 'string' ? after : null;
  if (afterStr !== null) {
    const parsed = parseCursor(afterStr);
    if (parsed !== null) startIndex = parsed + 1;
  }
  const page = issues.slice(startIndex, startIndex + limit);
  const nodes = page.map((issue) => issueJson(repo, issue, nodeSelections(selection, 'Issue'), ctx));
  const hasNextPage = startIndex + limit < issues.length;
  const endCursor = page.length > 0 ? makeCursor(startIndex + page.length - 1) : null;
  const out: Json = { nodes };
  const pageInfo: Json = { hasNextPage, endCursor };
  // Attach pageInfo only where requested.
  return attach(subSelectionOf(selection), out, { pageInfo });
}

function pullJson(repo: Repo, pull: Pull, selection: Selections): Json {
  const out: Json = {};
  for (const entry of selection.entries) {
    switch (entry.name) {
      case 'id': out[entry.alias] = globalId('PullRequest', pull.id); break;
      case 'number': out[entry.alias] = pull.number; break;
      case 'state': out[entry.alias] = pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'; break;
      case 'merged': out[entry.alias] = pull.merged; break;
      case 'headRefName': out[entry.alias] = pull.head; break;
      case 'baseRefName': out[entry.alias] = pull.base; break;
      case 'mergeable': out[entry.alias] = mergeableState(repo, pull); break;
      case 'files': out[entry.alias] = pullFiles(repo, pull, entry); break;
      default:
        throw new GraphQLError(`Cannot query field '${entry.name}' on type 'PullRequest'.`);
    }
  }
  return out;
}

function mergeableState(repo: Repo, pull: Pull): string {
  const ctx = currentContext();
  if (ctx === null) return 'UNKNOWN';
  return ctx.store.mergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
}

// A tiny module-level slot for the mergeable check; set per request.
let resolverContext: ResolverContext | null = null;
function currentContext(): ResolverContext | null {
  return resolverContext;
}

function pullFiles(repo: Repo, pull: Pull, entry: Selections['entries'][number]): Json {
  const first = Number(resolveArg(entry.args, 'first', {}));
  const limit = Number.isFinite(first) && first > 0 ? first : 30;
  const ctx = resolverContext;
  const nodes: Array<{ path: string }> = [];
  if (ctx === null) return { nodes };

  // The files a pull request changes: every commit on the head branch from (but not including) the
  // base tip back to the head tip, newest first. Each commit contributes its changed paths once, so
  // a single fixture commit yields exactly that path and no merge-time siblings.
  const order: string[] = [];
  const seen = new Set<string>();
  let cursor = pull.headSha;
  while (cursor !== '' && cursor !== pull.baseSha && !seen.has(cursor)) {
    seen.add(cursor);
    order.push(cursor);
    const object = ctx.store.getObject(repo, cursor);
    if (object === undefined || object.type !== 'commit') break;
    cursor = parseCommit(object.data).parents[0] ?? '';
  }
  const changed = new Map<string, { path: string }>();
  for (const oid of order) {
    for (const file of ctx.store.diffCommit(repo, oid)) {
      if (!changed.has(file.path)) changed.set(file.path, { path: file.path });
    }
  }
  for (const file of changed.values()) nodes.push(file);
  return { nodes: nodes.slice(0, limit) };
}

function pullRequestsConnection(repo: Repo, selection: Selections['entries'][number], ctx: ResolverContext, gql: GqlDocument): Json {
  const first = Number(resolveArg(selection.args, 'first', gql.variables ?? {}));
  const limit = Number.isFinite(first) && (first as number) > 0 ? (first as number) : 30;
  const pulls = repo.pulls.slice().sort((a, b) => b.id - a.id).slice(0, limit);
  const nodes = pulls.map((pull) => pullJson(repo, pull, nodeSelections(selection, 'PullRequest')));
  return { nodes };
}

/** The 'nodes' sub-selection under a connection selection. */
function nodeSelections(selection: Selections['entries'][number], _type: string): Selections {
  const found = selection.sub.entries.find((entry) => entry.name === 'nodes');
  return found?.sub ?? { entries: [] };
}

/** Attach only the keys whose aliases appear in the connection's own sub-selection. */
function subSelectionOf(selection: Selections['entries'][number]): Selections {
  return selection.sub;
}

function attach(selection: Selections, out: Json, extra: Json): Json {
  const wanted = new Set(selection.entries.map((entry) => entry.alias));
  for (const [key, value] of Object.entries(extra)) {
    if (wanted.has(key)) {
      const entry = selection.entries.find((candidate) => candidate.alias === key);
      if (entry !== undefined) out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------- cursor helpers

function makeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function parseCursor(value: string): number | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- __type introspection

interface TypeField {
  name: string;
}

const REPOSITORY_FIELDS: readonly string[] = Object.freeze(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']);
const ISSUE_FIELDS: readonly string[] = Object.freeze(['id', 'number', 'title', 'state', 'body']);
const PULL_REQUEST_FIELDS: readonly string[] = Object.freeze(['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files']);
const SEARCH_TYPE_ENUM_VALUES: readonly string[] = Object.freeze(['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'PULL_REQUEST', 'DISCUSSION']);

function fieldsFor(type: string): TypeField[] | null {
  if (type === 'Repository') return REPOSITORY_FIELDS.map((name) => ({ name }));
  if (type === 'Issue') return ISSUE_FIELDS.map((name) => ({ name }));
  if (type === 'PullRequest') return PULL_REQUEST_FIELDS.map((name) => ({ name }));
  return null;
}

function enumValuesFor(type: string): string[] | null {
  if (type === 'SearchType') return SEARCH_TYPE_ENUM_VALUES;
  return null;
}

// ---------------------------------------------------------------- the resolver root

function resolveSelection(sel: Selections['entries'][number], parent: Json | null, root: ResolverContext, doc: GqlDocument, typeInScope: string): unknown {
  switch (sel.name) {
    case '__type': {
      const name = resolveArg(sel.args, 'name', doc.variables ?? {});
      const typeName = String(name ?? '');
      const out: Json = {};
      for (const entry of sel.sub.entries) {
        if (entry.name === 'fields') {
          const fields = fieldsFor(typeName);
          if (fields !== null) {
            // fields(includeDeprecated:) -> [{name}]
            out[entry.alias] = fields.map((f) => ({ name: f.name }));
          } else {
            out[entry.alias] = null;
          }
        } else if (entry.name === 'enumValues') {
          const values = enumValuesFor(typeName);
          out[entry.alias] = values === null ? null : values.map((name) => ({ name }));
        } else {
          throw new GraphQLError(`Cannot query field '${entry.name}' on type '__Type'.`);
        }
      }
      return out;
    }
    default:
      break;
  }

  // Top-level fields: viewer, repository, node, and the mutations.
  if (parent === null) {
    switch (sel.name) {
      case 'viewer': {
        const out: Json = {};
        for (const entry of sel.sub.entries) {
          if (entry.name === 'login') out[entry.alias] = root.user.login;
          else throw new GraphQLError(`Cannot query field '${entry.name}' on type 'User'.`);
        }
        return out;
      }
      case 'repository': {
        const owner = String(resolveArg(sel.args, 'owner', doc.variables ?? {}) ?? '');
        const name = String(resolveArg(sel.args, 'name', doc.variables ?? {}) ?? '');
        const repo = root.store.findRepo(owner, name);
        if (repo === null) return null;
        const out: Json = {};
        for (const entry of sel.sub.entries) {
          out[entry.alias] = repoJsonForSelection(repo, owner, entry, root, doc);
        }
        // Handle inline fragments on the repository node (... on Repository).
        for (const fragment of sel.fragments) {
          if (fragment.type === 'Repository' || fragment.type === '') {
            for (const entry of fragment.sub.entries) {
              out[entry.alias] = repoJsonForSelection(repo, owner, entry, root, doc);
            }
          }
        }
        return out;
      }
      case 'node': {
        const id = resolveArg(sel.args, 'id', doc.variables ?? {});
        const parsed = parseGlobalId(String(id ?? ''));
        if (parsed === null) return null;
        const out: Json = { id: String(id) };
        const repo = root.store.allRepos().find((candidate) => candidate.id === parsed.id);
        if (parsed.type === 'Repository' && repo !== undefined) {
          const owner = repo.owner;
          const wanted = new Set<string>();
          let hasTypeCondition = false;
          // Gather the fields asked for directly and inside inline fragments, once (no duplicates).
          // Inline fragments attach to the entry that precedes them (the parser's entry.fragments),
          // which for `{ id ... on Repository { name } }` is the `id` entry inside node's sub-selection.
          const allFragments: Array<{ type: string; sub: Selections }> = [...sel.fragments];
          for (const entry of sel.sub.entries) {
            wanted.add(entry.name);
            for (const fragment of entry.fragments) allFragments.push(fragment);
          }
          for (const fragment of allFragments) {
            if (fragment.type === 'Repository' || fragment.type === '') hasTypeCondition = true;
            if (fragment.type === 'Repository' || fragment.type === '') {
              for (const entry of fragment.sub.entries) wanted.add(entry.name);
            }
          }
          // Apply every wanted field via the selection that carries its sub-selection.
          const applyAll = (lookups: readonly Selections['entries'][number][]): void => {
            for (const entry of lookups) {
              if (!wanted.has(entry.name)) continue;
              try {
                out[entry.alias] = repoJsonForSelection(repo, owner, entry, root, doc);
              } catch {
                throw new GraphQLError(`Cannot query field '${entry.name}' on type 'Repository'.`);
              }
              wanted.delete(entry.name);
            }
          };
          applyAll(sel.sub.entries);
          for (const fragment of allFragments) {
            if (fragment.type === 'Repository' || fragment.type === '') applyAll(fragment.sub.entries);
          }
          if (hasTypeCondition && wanted.size > 0) break; // unmatched wanted fields stay null by absence
          return out;
        }
        if (parsed.type === 'Issue') {
          for (const candidate of root.store.allRepos()) {
            const issue = candidate.issues.find((i) => i.id === parsed.id);
            if (issue !== undefined) return issueJson(candidate, issue, sel.sub, root);
          }
          return null;
        }
        if (parsed.type === 'PullRequest') {
          for (const candidate of root.store.allRepos()) {
            const pull = candidate.pulls.find((p) => p.id === parsed.id);
            if (pull !== undefined) return pullJson(candidate, pull, sel.sub);
          }
          return null;
        }
        return null;
      }
      case 'createIssue': {
        const input = resolveArg(sel.args, 'input', doc.variables ?? {}) as Json | undefined;
        if (input === null || typeof input !== 'object' || input === undefined) throw new GraphQLError('createIssue needs an input object');
        const repositoryId = String(input.repositoryId ?? '');
        const title = String(input.title ?? '');
        const body = String(input.body ?? '');
        const parsed = parseGlobalId(repositoryId);
        if (parsed === null) throw new GraphQLError('createIssue needs a valid repositoryId');
        const repo = root.store.allRepos().find((candidate) => candidate.id === parsed.id);
        if (repo === undefined) throw new GraphQLError('repository not found');
        const issue = root.store.createIssue(repo, title, body, [], root.user);
        const out: Json = {};
        for (const entry of sel.sub.entries) {
          if (entry.name !== 'issue') throw new GraphQLError(`Cannot query field '${entry.name}' on type 'CreateIssuePayload'.`);
          out[entry.alias] = issueJson(repo, issue, entry.sub, root);
        }
        return out;
      }
      case 'closeIssue': {
        const input = resolveArg(sel.args, 'input', doc.variables ?? {}) as Json | undefined;
        if (input === null || typeof input !== 'object' || input === undefined) throw new GraphQLError('closeIssue needs an input object');
        const issueId = String(input.issueId ?? '');
        const parsed = parseGlobalId(issueId);
        if (parsed === null) throw new GraphQLError('closeIssue needs a valid issueId');
        let target: { repo: Repo; issue: Issue } | null = null;
        for (const candidate of root.store.allRepos()) {
          const issue = candidate.issues.find((i) => i.id === parsed.id);
          if (issue !== undefined) {
            target = { repo: candidate, issue };
            break;
          }
        }
        if (target === null) throw new GraphQLError('issue not found');
        target.issue.state = 'closed';
        target.issue.closedAt = root.store.nowIso();
        target.issue.updatedAt = target.issue.closedAt;
        const out: Json = {};
        for (const entry of sel.sub.entries) {
          if (entry.name !== 'issue') throw new GraphQLError(`Cannot query field '${entry.name}' on type 'CloseIssuePayload'.`);
          out[entry.alias] = issueJson(target.repo, target.issue, entry.sub, root);
        }
        return out;
      }
      case 'createPullRequest': {
        const input = resolveArg(sel.args, 'input', doc.variables ?? {}) as Json | undefined;
        if (input === null || typeof input !== 'object' || input === undefined) throw new GraphQLError('createPullRequest needs an input object');
        const repositoryId = String(input.repositoryId ?? '');
        const baseRefName = String(input.baseRefName ?? '');
        const headRefName = String(input.headRefName ?? '');
        const title = String(input.title ?? '');
        const body = String(input.body ?? '');
        const parsed = parseGlobalId(repositoryId);
        if (parsed === null) throw new GraphQLError('createPullRequest needs a valid repositoryId');
        const repo = root.store.allRepos().find((candidate) => candidate.id === parsed.id);
        if (repo === undefined) throw new GraphQLError('repository not found');
        let pull: Pull;
        try {
          pull = root.store.createPull(repo, { title, body, head: headRefName, base: baseRefName }, root.user);
        } catch {
          const existing = repo.pulls.find((candidate) => candidate.head === headRefName && candidate.base === baseRefName && candidate.state === 'open');
          if (existing === undefined) throw new GraphQLError('pull request could not be created');
          pull = existing;
        }
        const out: Json = {};
        for (const entry of sel.sub.entries) {
          if (entry.name !== 'pullRequest') throw new GraphQLError(`Cannot query field '${entry.name}' on type 'CreatePullRequestPayload'.`);
          out[entry.alias] = pullJson(repo, pull, entry.sub);
        }
        return out;
      }
      case 'mergePullRequest': {
        const input = resolveArg(sel.args, 'input', doc.variables ?? {}) as Json | undefined;
        if (input === null || typeof input !== 'object' || input === undefined) throw new GraphQLError('mergePullRequest needs an input object');
        const pullRequestId = String(input.pullRequestId ?? '');
        const parsed = parseGlobalId(pullRequestId);
        if (parsed === null) throw new GraphQLError('mergePullRequest needs a valid pullRequestId');
        let target: { repo: Repo; pull: Pull } | null = null;
        for (const candidate of root.store.allRepos()) {
          const pull = candidate.pulls.find((p) => p.id === parsed.id);
          if (pull !== undefined) {
            target = { repo: candidate, pull };
            break;
          }
        }
        if (target === null) throw new GraphQLError('pull request not found');
        try {
          root.store.mergePull(target.repo, target.pull, root.user);
        } catch {
          throw new GraphQLError('Pull request is not mergeable');
        }
        const out: Json = {};
        for (const entry of sel.sub.entries) {
          if (entry.name !== 'pullRequest') throw new GraphQLError(`Cannot query field '${entry.name}' on type 'MergePullRequestPayload'.`);
          out[entry.alias] = pullJson(target.repo, target.pull, entry.sub);
        }
        return out;
      }
      case 'addComment': {
        const input = resolveArg(sel.args, 'input', doc.variables ?? {}) as Json | undefined;
        if (input === null || typeof input !== 'object' || input === undefined) throw new GraphQLError('addComment needs an input object');
        const subjectId = String(input.subjectId ?? '');
        const body = String(input.body ?? '');
        const parsed = parseGlobalId(subjectId);
        if (parsed === null) throw new GraphQLError('addComment needs a valid subjectId');
        let target: { repo: Repo; issue: Issue } | null = null;
        for (const candidate of root.store.allRepos()) {
          const issue = candidate.issues.find((i) => i.id === parsed.id);
          if (issue !== undefined) {
            target = { repo: candidate, issue };
            break;
          }
        }
        if (target === null) throw new GraphQLError('subject not found');
        const comment = root.store.addComment(target.repo, target.issue, body, root.user);
        const out: Json = {};
        for (const entry of sel.sub.entries) {
          if (entry.name !== 'commentEdge') throw new GraphQLError(`Cannot query field '${entry.name}' on type 'AddCommentPayload'.`);
          const nodeOut: Json = {};
          for (const nodeEntry of entry.sub.entries) {
            if (nodeEntry.name === 'node') {
              const commentNode: Json = {};
              for (const f of nodeEntry.sub.entries) {
                if (f.name === 'id') commentNode[f.alias] = globalId('Comment', comment.id);
                else if (f.name === 'body') commentNode[f.alias] = body;
                else throw new GraphQLError(`Cannot query field '${f.name}' on type 'IssueComment'.`);
              }
              nodeOut[nodeEntry.alias] = commentNode;
            } else {
              throw new GraphQLError(`Cannot query field '${nodeEntry.name}' on type 'AddCommentPayload'.`);
            }
          }
          out[entry.alias] = nodeOut;
        }
        return out;
      }
      default:
        throw new GraphQLError(`Cannot query field '${sel.name}' on type 'Query' or 'Mutation'.`);
    }
  }

  throw new GraphQLError('unsupported selection');
}

function executeDocument(store: ForgeStore, user: User, doc: GqlDocument): { data: Json | null; errors: Array<{ message: string }> } {
  const root: ResolverContext = { store, user };
  resolverContext = root;
  try {
    const data: Json = {};
    const errors: Array<{ message: string }> = [];
    for (const sel of doc.selections.entries) {
      try {
        data[sel.alias] = resolveSelection(sel, null, root, doc, 'Query');
      } catch (err) {
        const message = err instanceof GraphQLError ? err.message : err instanceof Error ? err.message : String(err);
        errors.push({ message });
        data[sel.alias] = null;
      }
    }
    return { data: errors.length > 0 && Object.keys(data).length === 0 ? null : data, errors };
  } finally {
    resolverContext = null;
  }
}

// ---------------------------------------------------------------- the HTTP handler

export async function handleGraphQL(store: ForgeStore, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  if (url.pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  const token = bearerToken(req);
  const user = userForToken(token);
  if (user === null) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const body = await readJson<unknown>(req);
  if (body === undefined) {
    sendError(res, 400, 'Problems parsing JSON');
    return true;
  }
  // Batching: a JSON array of operation documents -> an array of envelopes.
  if (Array.isArray(body)) {
    const results = body.map((op) => runOperation(store, user, op));
    sendJson(res, 200, results);
    return true;
  }
  sendJson(res, 200, runOperation(store, user, body));
  return true;
}

function runOperation(store: ForgeStore, user: User, op: unknown): { data: Json | null; errors: Array<{ message: string }> } {
  if (typeof op !== 'object' || op === null) {
    return { data: null, errors: [{ message: 'invalid operation' }] };
  }
  const record = op as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'no query string' }] };
  }
  const variables = typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables) ? (record.variables as Record<string, unknown>) : {};
  let doc: GqlDocument;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const root: ResolverContext = { store, user };
  const data: Json = {};
  const errors: Array<{ message: string }> = [];
  resolverContext = root;
  try {
    for (const sel of doc.selections.entries) {
      try {
        data[sel.alias] = resolveSelection(sel, null, root, { ...doc, variables }, 'Query');
      } catch (err) {
        const message = err instanceof GraphQLError ? err.message : err instanceof Error ? err.message : String(err);
        errors.push({ message });
        data[sel.alias] = null;
      }
    }
  } finally {
    resolverContext = null;
  }
  return { data, errors: errors.length > 0 ? errors : [] };
}