// git smart HTTP: info/refs advertisements (upload-pack v2 + v0, receive-pack v0 only), v2 ls-refs and
// fetch (with shallow/deepen), v0 fetch, and receive-pack push with report-status inside side-band-64k.
// No git binary: the pack protocol is implemented here on node:zlib and node:crypto.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTag, parseTree, type GitObject, type GitObjectType } from './objects.ts';
import { readPack, writePack } from './pack.ts';
import { decodePktLines, encodePktLine, encodePktLines, pktLineFlush, PKT_LINE_MAX_PAYLOAD, type GitPacket } from './pktline.ts';
import { sendBuffer, sendError, urlOf } from './http.ts';
import type { ForgeStore, Repo } from './store.ts';

const UPLOAD_SERVICE = 'git-upload-pack';
const RECEIVE_SERVICE = 'git-receive-pack';
const ZERO = '0'.repeat(40);
const SERVER_AGENT = 'git-upload-pack/forge-1.0';

const UPLOAD_CAPS_V0 = ['multi_ack_detailed', 'no-done', 'side-band-64k', 'ofs-delta', 'shallow', 'deepen-since', 'deepen-not', 'deepen-relative', 'agent=forge-git/1.0'];
const RECEIVE_CAPS_V0 = ['report-status', 'delete-refs', 'quiet', 'side-band-64k', 'ofs-delta', 'atomic-push', 'push-options', 'agent=forge-git/1.0'];

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** The repository's refs for an advertisement: every ref plus a resolved (or unborn) HEAD. */
function advertisementRefs(store: ForgeStore, repo: Repo): RefLine[] {
  const refs = store.listRefs(repo);
  const out: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) out.push({ oid: headOid, name: 'HEAD', peeled: peel(store, repo, headOid) ?? undefined });
  else out.push({ oid: ZERO, name: 'HEAD' });
  for (const ref of refs) {
    const peeled = ref.name.startsWith('refs/tags/') ? peel(store, repo, ref.oid) : null;
    out.push({ oid: ref.oid, name: ref.name, peeled: peeled ?? undefined });
  }
  return out;
}

/** The commit an annotated tag peels to, or null for a non-tag. */
function peel(store: ForgeStore, repo: Repo, oid: string): string | null {
  const object = store.getObject(repo, oid);
  if (!object || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

/** GET /info/refs?service=...: the advertisement, v2 for upload-pack when the client asks for it. */
export function serveInfoRefs(store: ForgeStore, req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string, tokenOk: boolean): boolean {
  const repo = store.findRepo(owner, name);
  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const url = urlOf(req);
  if (url.searchParams.get('service') !== service) {
    sendBuffer(res, 200, Buffer.from(`001e# service=${service}\n${pktLineFlush().toString('ascii')}`, 'binary'), 'application/x-git-service-invalid');
    return true;
  }
  const wantsV2 = service === UPLOAD_SERVICE && /version=2/.test(String(req.headers['git-protocol'] ?? ''));
  const refs = advertisementRefs(store, repo);
  let body: Buffer;
  if (wantsV2) {
    body = encodePktLines([
      'version 2\n',
      'flush',
      `agent=${SERVER_AGENT}\n`,
      'object-format=sha1\n',
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done filter\n',
      'push=report-status delete-refs side-band-64k ofs-delta\n',
      'flush',
    ]);
  } else {
    const caps = service === UPLOAD_SERVICE ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
    const withSymref = service === UPLOAD_SERVICE ? [...caps, `symref=HEAD:${repo.defaultBranch === '' ? 'refs/heads/main' : `refs/heads/${repo.defaultBranch}`}`] : caps;
    const lines: Array<string | 'flush'> = [];
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\u0000${withSymref.join(' ')}` : '';
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      if (ref.peeled !== undefined && ref.peeled !== null) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
    lines.push('flush');
    body = encodePktLines(lines);
  }
  const preamble = encodePktLine(`# service=${service}\n`);
  sendBuffer(res, 200, Buffer.concat([preamble, pktLineFlush(), body]), `application/x-${service}-advertisement`, { 'cache-control': 'no-cache, no-store, max-age=0, must-revalidate', 'pragma': 'no-cache', 'expires': 'Fri, 01 Jan 1990 00:00:00 GMT' });
  return true;
}

// ---------------------------------------------------------------- pkt-line helpers over a request body

interface Command {
  name: string;
  args: string[];
  lines: string[];
}

/** Split a request body into the packets before the first flush (the command) and after (the arguments). */
function parseCommand(body: Buffer): { command: string; lines: string[]; trailing: Buffer } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let index = 0;
  for (; index < packets.length; index += 1) {
    const packet = packets[index] as GitPacket;
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const rest = packets.slice(index + 1);
  const trailing: Buffer[] = [];
  let sawFlush = false;
  for (const packet of rest) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      continue;
    }
    if (packet.kind === 'data') trailing.push(packet.raw);
  }
  void sawFlush;
  return { command: lines[0] ?? '', lines: lines.slice(1), trailing: Buffer.concat(trailing) };
}

// ---------------------------------------------------------------- object closure

/** Every object under a tree, descended. */
function treeClosure(store: ForgeStore, repo: Repo, treeOid: string, out: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = store.getObject(repo, oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    }
  }
}

/**
 * The closure of `roots`: commits' trees always, and a commit's parents only when the commit is not in
 * `cut` (a shallow boundary). Blobs and trees are never cut.
 */
function closureCut(store: ForgeStore, repo: Repo, roots: Iterable<string>, cut: Set<string> | null): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (out.has(oid)) continue;
    const object = store.getObject(repo, oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      treeClosure(store, repo, commit.tree, out);
      if (cut === null || !cut.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        if (!out.has(entry.oid)) queue.push(entry.oid);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefsResponse(store: ForgeStore, repo: Repo, args: readonly string[]): Buffer {
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const peelRequested = args.includes('peel');
  const symrefsRequested = args.includes('symrefs');
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (keep('HEAD')) {
    if (headOid === undefined) lines.push(`unborn HEAD${symrefsRequested ? ' symref-target:' + headTarget : ''}\n`);
    else lines.push(`${headOid} HEAD${symrefsRequested ? ' symref-target:' + headTarget : ''}\n`);
  }
  for (const ref of store.listRefs(repo)) {
    if (!keep(ref.name)) continue;
    const tokens: string[] = [];
    if (peelRequested && ref.name.startsWith('refs/tags/')) {
      const peeled = peel(store, repo, ref.oid);
      if (peeled !== null) tokens.push(`peeled:${peeled}`);
    }
    lines.push(`${ref.oid} ${ref.name}${tokens.length > 0 ? ' ' + tokens.join(' ') : ''}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- fetch

interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  ready: boolean;
}

function planFetch(store: ForgeStore, repo: Repo, args: readonly string[]): FetchPlan {
  const wants: string[] = [];
  const haves: string[] = [];
  const oldBoundaries = new Set<string>();
  let depth: number | null = null;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) oldBoundaries.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value > 0) depth = Math.trunc(value);
    }
  }
  const uniqueWants = [...new Set(wants)].filter((oid) => store.getObject(repo, oid) !== undefined);
  const shallowMode = depth !== null || oldBoundaries.size > 0;

  if (!shallowMode) {
    const send = closureCut(store, repo, uniqueWants, null);
    const held = haves.length > 0 ? closureCut(store, repo, haves, null) : new Set<string>();
    const objects = [...send].filter((oid) => !held.has(oid));
    return { objects, shallow: [], unshallow: [], ready: haves.length > 0 };
  }

  // Depth-limited walk from the wants: the commits this response holds.
  const commits = new Set<string>();
  const boundaries = new Set<string>();
  const queue: Array<{ oid: string; level: number }> = uniqueWants.map((oid) => ({ oid, level: 1 }));
  while (queue.length > 0) {
    const { oid, level } = queue.shift() as { oid: string; level: number };
    if (commits.has(oid)) continue;
    const object = store.getObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    commits.add(oid);
    const parents = parseCommit(object.data).parents;
    if (depth !== null && level >= depth) {
      boundaries.add(oid);
      continue;
    }
    if (parents.length === 0) boundaries.add(oid);
    for (const parent of parents) queue.push({ oid: parent, level: level + 1 });
  }
  const send = closureCut(store, repo, commits, boundaries);
  const held = closureCut(store, repo, [...haves, ...oldBoundaries], oldBoundaries.size > 0 ? oldBoundaries : null);
  const objects = [...send].filter((oid) => !held.has(oid));
  const unshallow = [...oldBoundaries].filter((oid) => commits.has(oid) && !boundaries.has(oid));
  const shallow = [...boundaries];
  return { objects, shallow, unshallow, ready: haves.length > 0 };
}

/** Order the objects to send so a delta base (when used) precedes its dependents: commits last, blobs first. */
function orderObjects(store: ForgeStore, repo: Repo, oids: readonly string[]): Array<{ type: GitObjectType; data: Buffer }> {
  const rank: Record<GitObjectType, number> = { blob: 0, tree: 1, tag: 2, commit: 3 };
  const list = oids.map((oid) => store.getObject(repo, oid)).filter((object): object is GitObject => object !== undefined);
  list.sort((a, b) => rank[a.type] - rank[b.type]);
  return list.map((object) => ({ type: object.type, data: object.data }));
}

/** Sideband-frame a pack: band 1 for the pack bytes, band 2 for a progress line. */
function sidebandFrames(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += PKT_LINE_MAX_PAYLOAD - 1) {
    const chunk = pack.subarray(offset, offset + PKT_LINE_MAX_PAYLOAD - 1);
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

function fetchV2Response(store: ForgeStore, repo: Repo, args: readonly string[]): Buffer {
  const plan = planFetch(store, repo, args);
  const control: Array<string | 'flush'> = [];
  control.push('acknowledgments\n');
  control.push(plan.ready ? 'ready\n' : 'NAK\n');
  control.push('flush');
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    control.push('shallow-info\n');
    for (const oid of plan.shallow) control.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) control.push(`unshallow ${oid}\n`);
    control.push('flush');
  }
  control.push('packfile\n');
  const pack = writePack(orderObjects(store, repo, plan.objects));
  // Control pkt-lines, then the pack's sideband frames verbatim, then a top-level flush.
  return Buffer.concat([encodePktLines(control), ...sidebandFrames(pack), pktLineFlush()]);
}

function fetchV0Response(store: ForgeStore, repo: Repo, args: readonly string[], firstLine: string): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const oldBoundaries = new Set<string>();
  let depth: number | null = null;
  const head = firstLine.split(' ')[0] === 'want' ? firstLine.slice(5).trim().split(' ')[0] : '';
  if (head !== '') wants.push(head);
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) oldBoundaries.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value > 0) depth = Math.trunc(value);
    }
  }
  const uniqueWants = [...new Set(wants)].filter((oid) => store.getObject(repo, oid) !== undefined);
  let commits: Set<string>;
  let boundaries: Set<string> | null = null;
  if (depth !== null || oldBoundaries.size > 0) {
    commits = new Set();
    boundaries = new Set();
    const queue: Array<{ oid: string; level: number }> = uniqueWants.map((oid) => ({ oid, level: 1 }));
    while (queue.length > 0) {
      const { oid, level } = queue.shift() as { oid: string; level: number };
      if (commits.has(oid)) continue;
      const object = store.getObject(repo, oid);
      if (!object || object.type !== 'commit') continue;
      commits.add(oid);
      const parents = parseCommit(object.data).parents;
      if (depth !== null && level >= depth) {
        boundaries.add(oid);
        continue;
      }
      for (const parent of parents) queue.push({ oid: parent, level: level + 1 });
    }
  } else {
    commits = new Set(uniqueWants);
  }
  const send = closureCut(store, repo, commits, boundaries);
  const held = closureCut(store, repo, [...haves, ...oldBoundaries], oldBoundaries.size > 0 ? oldBoundaries : null);
  const objects = [...send].filter((oid) => !held.has(oid));
  const pack = writePack(orderObjects(store, repo, objects));
  const control: Array<string | 'flush'> = [];
  for (const oid of boundaries ?? []) control.push(`shallow ${oid}\n`);
  control.push('NAK\n');
  control.push('flush');
  // Control pkt-lines, then the pack's sideband frames verbatim, then a top-level flush.
  return Buffer.concat([encodePktLines(control), ...sidebandFrames(pack), pktLineFlush()]);
}

// ---------------------------------------------------------------- receive-pack

interface ReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Peel an object to its commit: a commit is itself, an annotated tag peels into its target. */
function peelToCommit(store: ForgeStore, repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = store.getObject(repo, current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Fast-forward check: `oldOid` must be an ancestor of `newOid` (or the ref must be absent/zero). */
function updateAllowed(store: ForgeStore, repo: Repo, ref: string, oldOid: string, newOid: string): string | null {
  const current = repo.refs.get(ref);
  if (newOid === ZERO) {
    if (current === undefined) return null;
    if (current !== oldOid) return 'incorrect old value provided';
    return null;
  }
  const object = store.getObject(repo, newOid);
  if (object === undefined) return 'missing new commit';
  // Only branch refs are fast-forward-checked; tags and other refs may point at any object.
  if (!ref.startsWith('refs/heads/')) {
    if (current === undefined) return oldOid === ZERO ? null : 'incorrect old value provided';
    return current === oldOid ? null : 'incorrect old value provided';
  }
  const commitOid = peelToCommit(store, repo, newOid);
  if (commitOid === null) return 'missing new commit';
  if (current === undefined) return oldOid === ZERO ? null : 'incorrect old value provided';
  if (current !== oldOid) return 'incorrect old value provided';
  const currentCommit = peelToCommit(store, repo, current) ?? current;
  if (currentCommit !== commitOid && !store.isAncestor(repo, currentCommit, commitOid)) return 'non-fast-forward';
  return null;
}

function receivePack(store: ForgeStore, repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  interface Command { oldOid: string; newOid: string; ref: string; options: string[] }
  const commands: Command[] = [];
  const packChunks: Buffer[] = [];
  let inCommands = true;
  let unpackOk = true;
  let unpackDetail = 'ok';
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      inCommands = false;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (inCommands) {
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\u0000');
      const clean = nul >= 0 ? text.slice(0, nul) : text;
      const parts = clean.split(' ');
      if (parts.length < 3) continue;
      const options = nul >= 0 ? text.slice(nul + 1).split(' ').filter(Boolean) : [];
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' '), options });
    } else {
      packChunks.push(packet.raw);
    }
  }
  // The pack follows the flushed command list as raw bytes; recover it from the body's tail.
  if (packChunks.length === 0) {
    const raw = body;
    let offset = 0;
    while (offset + 4 <= raw.length) {
      const header = raw.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        break;
      }
      if (length < 4 || offset + length > raw.length) break;
      offset += length;
    }
    if (offset > 0 && offset < raw.length) packChunks.push(raw.subarray(offset));
  }
  const packBytes = Buffer.concat(packChunks);
  const sentObjects = new Map<string, GitObject>();
  if (packBytes.length >= 32) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => sentObjects.get(oid) ?? store.getObject(repo, oid) });
      if (!read.checksumOk) {
        unpackOk = false;
        unpackDetail = 'pack checksum mismatch';
      } else {
        for (const [oid, object] of read.objects) sentObjects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (packBytes.length > 0) {
    unpackOk = false;
    unpackDetail = 'short packfile';
  }
  if (unpackOk && sentObjects.size > 0) {
    for (const [oid, object] of sentObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: Buffer.from(object.data) });
    }
  }
  const reports: ReportLine[] = [];
  if (!unpackOk) {
    for (const command of commands) reports.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const command of commands) {
      const problem = updateAllowed(store, repo, command.ref, command.oldOid, command.newOid);
      if (problem !== null) {
        reports.push({ ref: command.ref, ok: false, reason: problem });
        continue;
      }
      if (command.newOid === ZERO) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      repo.updatedAt = store.nowIso();
      reports.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  const reportLines: Array<string | 'flush'> = ['unpack ' + unpackDetail + '\n'];
  for (const report of reports) reportLines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  reportLines.push('flush');
  const report = encodePktLines(reportLines);
  // Wrap the pkt-lined report stream in band-1 sideband frames, then end with a top-level flush.
  const framed: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += PKT_LINE_MAX_PAYLOAD - 1) {
    const chunk = report.subarray(offset, offset + PKT_LINE_MAX_PAYLOAD - 1);
    framed.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat([Buffer.concat(framed), pktLineFlush()]);
}

// ---------------------------------------------------------------- the dispatcher

/** Handle POST /{owner}/{repo}.git/<service>. Returns true when it answered. */
export function serveGitPost(store: ForgeStore, req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string, body: Buffer): boolean {
  const repo = store.findRepo(owner, name);
  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (service === RECEIVE_SERVICE) {
    const report = receivePack(store, repo, body);
    sendBuffer(res, 200, report, `application/x-${RECEIVE_SERVICE}-result`, { 'cache-control': 'no-cache, no-store, max-age=0, must-revalidate' });
    return true;
  }
  if (service !== UPLOAD_SERVICE) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const parsed = parseCommand(body);
  const wantsV2 = /version=2/.test(String(req.headers['git-protocol'] ?? '')) || parsed.command.startsWith('command=');
  let response: Buffer;
  if (wantsV2) {
    if (parsed.command === 'command=ls-refs') response = lsRefsResponse(store, repo, parsed.lines);
    else if (parsed.command === 'command=fetch') response = fetchV2Response(store, repo, parsed.lines);
    else {
      sendError(res, 200, `unknown command ${JSON.stringify(parsed.command)}`);
      return true;
    }
  } else {
    response = fetchV0Response(store, repo, parsed.lines, parsed.command);
  }
  sendBuffer(res, 200, response, `application/x-${UPLOAD_SERVICE}-result`, { 'cache-control': 'no-cache, no-store, max-age=0, must-revalidate' });
  return true;
}
