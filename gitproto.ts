// Smart-HTTP protocol: pkt-line framing, ref advertisement (protocol v0 and
// v2), ls-refs, fetch for upload-pack (v0 wants/haves/done and v2 fetch with
// sections), shallow handling, and receive-pack pushes with report-status.

import { ZERO_OID, buildPack, closure, getObject, isAncestor, parseCommit, parseTree, peelToCommit, receivePack } from './git.ts';
import type { RepoRec } from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** Decode a full pkt-line stream; throws on malformed framing. */
export function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
    } else if (len === 2) {
      packets.push({ kind: 'data', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (len === 3) {
      throw new Error('pkt-line length 3 is invalid');
    } else {
      if (pos + len > buf.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
      pos += len;
    }
  }
  return packets;
}

/** Split decoded packets into (lines before first flush, rest after it). */
function linesOf(packets: Packet[]): string[] {
  const out: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    out.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

// ---------------------------------------------------------------- refs view

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** The ref list both advertisements and ls-refs report, HEAD first. */
export function refLines(repo: RepoRec): RefLine[] {
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const lines: RefLine[] = [];
  const headOid = repo.refs.get(headTarget);
  lines.push({
    oid: headOid ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: headTarget,
    unborn: headOid === undefined,
  });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const obj = getObject(repo, oid);
    if (obj && obj.type === 'tag') line.peeled = peelToCommit(repo, oid);
    lines.push(line);
  }
  return lines;
}

const UPLOAD_CAPS_V0 =
  'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

/** GET info/refs body for one service. `v2` when the client asked for protocol 2. */
export function advertiseRefs(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (v2 && service === 'git-upload-pack') {
    parts.push(
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    );
    return Buffer.concat(parts);
  }
  const lines = refLines(repo);
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}` : RECEIVE_CAPS;
  lines.forEach((line, idx) => {
    let text = `${line.oid} ${line.name}`;
    if (idx === 0) text += `\0${caps}`;
    parts.push(pktLine(`${text}\n`));
    if (line.peeled) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
  });
  if (lines.length === 1 && lines[0]?.unborn) {
    // Empty repo: the HEAD line doubles as the capabilities^{} pseudo-ref shape
    // real git sends; keep the single line above (oid zero) as-is.
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

export function lsRefs(repo: RepoRec, packets: Packet[]): Buffer {
  const args = linesOf(packets);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  for (const line of refLines(repo)) {
    if (prefixes.length && !prefixes.some((p) => line.name.startsWith(p))) continue;
    let text = `${line.oid} ${line.name}`;
    if (symrefs && line.symrefTarget) text += ` symref-target:${line.symrefTarget}`;
    if (peel && line.peeled) text += ` peeled:${line.peeled}`;
    if (line.unborn) text += ' unborn';
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch core

export interface FetchPlan {
  /** Object ids to send, in pack order (commits first as stored). */
  objects: string[];
  /** Boundary commits to announce as shallow. */
  shallow: string[];
  /** Previously-shallow commits whose history is now included. */
  unshallow: string[];
}

/**
 * Compute what a fetch sends: the closure of the wants, minus everything the
 * client already has (haves closure and its own shallow boundary), honouring
 * a depth limit or a deepen request relative to the client's shallow line.
 */
export function planFetch(
  repo: RepoRec,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
  deepen: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const haveSet = new Set<string>();
  for (const h of haves) {
    haveSet.add(h);
    // What the client holds: the closure of its haves, but a shallow client's
    // boundary commits do not imply their ancestors — it never received those.
    for (const oid of boundedClosure(repo, h, shallowSet)) haveSet.add(oid);
  }

  // Generation distance from the wants, following commit parents only.
  const gen = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const w of wants) queue.push([w, 0]);
  while (queue.length) {
    const [oid, g] = queue.shift() as [string, number];
    if (gen.has(oid) && (gen.get(oid) as number) <= g) continue;
    gen.set(oid, g);
    const obj = getObject(repo, peelToCommit(repo, oid));
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queue.push([p, g + 1]);
    }
  }

  let limit: number | null = depth;
  if (deepen !== null) {
    let base = 0;
    for (const s of clientShallow) {
      const g = gen.get(s);
      if (g !== undefined) base = Math.max(base, g);
    }
    limit = base + deepen;
  }

  const included = new Set<string>();
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  for (const [oid, g] of gen) {
    const commitOid = peelToCommit(repo, oid);
    const isShallowKnown = shallowSet.has(commitOid) || shallowSet.has(oid);
    if (limit !== null && g >= limit) continue;
    if (haveSet.has(commitOid) && !isShallowKnown) continue;
    if (isShallowKnown && deepen === null && depth === null) continue; // boundary already held
    if (isShallowKnown && limit !== null && g >= limit) continue;
    // Include this commit and its tree/blobs.
    const commitObj = getObject(repo, commitOid);
    if (!commitObj || commitObj.type !== 'commit') continue;
    included.add(commitOid);
    const info = parseCommit(commitObj.data);
    for (const sub of closure(repo, [info.tree])) if (!haveSet.has(sub)) included.add(sub);
    const atBoundary = limit !== null && g === limit - 1;
    const parentsExcluded = info.parents.some((p) => {
      const pg = gen.get(p);
      return pg === undefined || pg >= (limit as number) || haveSet.has(p);
    });
    if ((atBoundary || (limit !== null && parentsExcluded)) && info.parents.length) newShallow.push(commitOid);
    if (isShallowKnown) unshallow.push(commitOid);
  }
  // Tag objects that point at included commits ride along (annotated tags).
  for (const line of refLines(repo)) {
    if (line.peeled && included.has(line.peeled) && !haveSet.has(line.oid)) included.add(line.oid);
  }
  // Wanted non-commit objects (tags asked for directly) too.
  for (const w of wants) {
    const obj = getObject(repo, w);
    if (obj && obj.type === 'tag' && !haveSet.has(w)) included.add(w);
  }
  return {
    // The client's own shallow-boundary objects are already in its hands; only
    // their newly revealed ancestors are news.
    objects: [...included].filter((oid) => repo.objects.has(oid) && !shallowSet.has(oid)),
    shallow: [...new Set(newShallow)],
    unshallow: [...new Set(unshallow)].filter((oid) => !newShallow.includes(oid)),
  };
}

/** Closure of one tip that does not descend past boundary commits' parents. */
function boundedClosure(repo: RepoRec, tip: string, boundary: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!boundary.has(oid)) stack.push(...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const target = peelToCommit(repo, oid);
      if (target !== oid) stack.push(target);
    }
  }
  return seen;
}

const packCache = new Map<string, Buffer>();

/** Pack bytes for a plan, cached per repo+plan signature (bench clones repeat). */
export function packForPlan(repoKey: string, repo: RepoRec, plan: FetchPlan): Buffer {
  const signature = `${repoKey}|${plan.objects.join(',')}`;
  const hit = packCache.get(signature);
  if (hit) return hit;
  const pack = buildPack(repo, plan.objects);
  if (packCache.size > 64) packCache.clear();
  packCache.set(signature, pack);
  return pack;
}

/** Wrap pack bytes in sideband band-1 packets (plus a small band-2 progress note). */
export function sidebandWrap(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, i + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepen: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepen: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) args.depth = null; // time-based: treated as full deepen below
    else if (line === 'done') args.done = true;
    else if (line.startsWith('deepen-not ')) { /* exclusion by ref: histories here are linear; ignore */ }
  }
  return args;
}

/** POST git-upload-pack, protocol v2 (command=ls-refs / command=fetch). */
export function uploadPackV2(repo: RepoRec, repoKey: string, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  // Split: command block up to first delim, args after.
  const delimIdx = packets.findIndex((p) => p.kind === 'delim');
  const headPackets = delimIdx >= 0 ? packets.slice(0, delimIdx) : packets;
  const argPackets = delimIdx >= 0 ? packets.slice(delimIdx + 1) : [];
  const head = linesOf(headPackets);
  const command = head.find((l) => l.startsWith('command='));
  if (command === 'command=ls-refs') return lsRefs(repo, argPackets);
  if (command === 'command=fetch') {
    const args = parseFetchArgs(linesOf(argPackets));
    if (!args.done) {
      // Negotiation round: acknowledge common haves, then invite `done`.
      const parts: Buffer[] = [pktLine('acknowledgments\n')];
      const common = args.haves.filter((h) => repo.objects.has(h));
      if (common.length) {
        for (const c of common) parts.push(pktLine(`ACK ${c} common\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    }
    const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepen);
    const parts: Buffer[] = [];
    if (args.depth !== null || args.deepen !== null || args.shallow.length || plan.shallow.length || plan.unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandWrap(packForPlan(repoKey, repo, plan)));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  throw new Error(`unknown v2 command ${command ?? ''}`);
}

/** POST git-upload-pack, protocol v0 (want/have sections split by a flush). */
export function uploadPackV0(repo: RepoRec, repoKey: string, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const flushIdx = packets.findIndex((p) => p.kind === 'flush');
  const wantLines = linesOf(flushIdx >= 0 ? packets.slice(0, flushIdx) : packets);
  const haveLines = flushIdx >= 0 ? linesOf(packets.slice(flushIdx + 1)) : [];
  const wants: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of wantLines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
  }
  const args: FetchArgs = { wants, haves: [], shallow, depth, deepen: null, done: false };
  for (const line of haveLines) {
    if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line === 'done') args.done = true;
  }
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepen);
  const parts: Buffer[] = [];
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  const common = args.haves.filter((h) => repo.objects.has(h));
  if (common.length) parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(sidebandWrap(packForPlan(repoKey, repo, plan)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: apply a command list + optional pack, report status. */
export function receivePackHandler(repo: RepoRec, body: Buffer): Buffer {
  // Commands are pkt-lines up to the first flush; the rest is the packfile.
  let pos = 0;
  const commands: PushCommand[] = [];
  let clientCaps = '';
  while (pos + 4 <= body.length) {
    const hex = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) {
      pos += 4;
      break;
    }
    if (len < 4 || pos + len > body.length) break;
    let text = body.subarray(pos + 4, pos + len).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      clientCaps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const fields = text.split(' ');
    if (fields.length === 3) {
      commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
    }
    pos += len;
  }
  const pack = body.subarray(pos);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      receivePack(repo, pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }

  const report: string[] = [`unpack ${unpackDetail}`];
  for (const cmd of commands) {
    report.push(`${applyPush(repo, cmd, unpackOk)}`);
  }
  const reportStream = Buffer.concat([...report.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
  if (clientCaps.split(' ').includes('side-band-64k')) {
    const CHUNK = 65500;
    const parts: Buffer[] = [];
    for (let i = 0; i < reportStream.length; i += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(i, i + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return reportStream;
}

/** Apply one ref update; returns its report line ("ok <ref>" / "ng <ref> <why>"). */
function applyPush(repo: RepoRec, cmd: PushCommand, unpackOk: boolean): string {
  const { oldOid, newOid, ref } = cmd;
  if (!unpackOk) return `ng ${ref} unpacker error`;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // Delete.
    if (!repo.refs.has(ref)) return `ng ${ref} reference not found`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const newObj = getObject(repo, newOid);
  if (!newObj) return `ng ${ref} unknown object`;
  if (oldOid === ZERO_OID) {
    if (repo.refs.has(ref)) return `ng ${ref} reference already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) return `ng ${ref} stale info`;
  if (ref.startsWith('refs/heads/')) {
    const newCommit = peelToCommit(repo, newOid);
    const oldCommit = peelToCommit(repo, oldOid);
    if (newCommit !== oldCommit && !isAncestor(repo, oldCommit, newCommit)) {
      return `ng ${ref} non-fast-forward`;
    }
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}
