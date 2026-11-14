// The git object model and packfile machinery, implemented from the protocol
// itself on node:crypto and node:zlib only: object hashing, trees and commits,
// pack reading (plain, OFS-delta and REF-delta objects, thin packs completed
// against the local store) and pack writing (plain objects, no deltas).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, RepoRec } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_NUM: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id an object with this type and content bytes hashes to. */
export function oidOf(type: GitObject['type'], data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object in the repo (idempotent) and return its id. */
export function storeObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: RepoRec, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse an "author" line "Name <email> 1700000000 +0000" into parts. */
export function parseIdent(line: string): { name: string; email: string; epochSec: number } {
  const m = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!m) return { name: line, email: '', epochSec: 0 };
  return { name: m[1] as string, email: m[2] as string, epochSec: Number(m[3]) };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // as stored: "100644", "100755", "120000", "40000" for dirs
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories compare as if their name ended in "/". */
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {oid, mode}; dirs are not entries. */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Build nested trees from a flat path -> blob map; returns the root tree oid. */
export function writeTreeFromFiles(repo: RepoRec, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, f] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] as string;
      if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(part) as Node;
    }
    node.files.set(parts[parts.length - 1] as string, f);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The blob oid at an exact path in a tree, or undefined. */
export function blobAtPath(repo: RepoRec, treeOid: string, path: string): { oid: string; mode: string } | undefined {
  return flattenTree(repo, treeOid).get(path);
}

// ---------------------------------------------------------------- reachability

/** All object ids reachable from the given tips (commits, trees, blobs, tags). */
export function closure(repo: RepoRec, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) stack.push(m[1] as string);
    }
  }
  return seen;
}

/** Is `ancestor` reachable from `descendant` following commit parents? */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** Peel tags until a non-tag object; returns the final oid (or the input). */
export function peelToCommit(repo: RepoRec, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!m) return cur;
    cur = m[1] as string;
  }
  return cur;
}

/** Merge base (best common ancestor) of two commits, or null. Histories here are small. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Set<string> => {
    const set = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (set.has(oid)) continue;
      set.add(oid);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
    }
    return set;
  };
  const fromA = ancestorsOf(a);
  // BFS from b so the first common commit is a nearest one.
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

// ---------------------------------------------------------------- pack write

/** Build a packfile of plain (undeltified) objects in the given order. */
export function buildPack(repo: RepoRec, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    const size = obj.data.length;
    const typeNum = TYPE_NUM[obj.type];
    const bytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes), deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pack read

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[i] as number;
      i += 1;
      v += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (i < delta.length) {
    const op = delta[i] as number;
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[i] as number; i += 1; }
      if (op & 0x02) { offset += (delta[i] as number) << 8; i += 1; }
      if (op & 0x04) { offset += (delta[i] as number) << 16; i += 1; }
      if (op & 0x08) { offset += (delta[i] as number) << 24; i += 1; }
      if (op & 0x10) { size = delta[i] as number; i += 1; }
      if (op & 0x20) { size += (delta[i] as number) << 8; i += 1; }
      if (op & 0x40) { size += (delta[i] as number) << 16; i += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || produced !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

interface PackEntry {
  type: GitObject['type'];
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
}

/**
 * Parse a packfile and store every object it carries into the repo, resolving
 * OFS/REF deltas against pack-local bases and the existing store (thin packs).
 * Returns the stored oids. Throws on any structural problem.
 */
export function receivePack(repo: RepoRec, pack: Buffer): string[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  const entries: PackEntry[] = [];
  const byOffset = new Map<number, number>();
  let pos = 12;
  for (let n = 0; n < count; n++) {
    const entryStart = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos] as number;
      pos += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) {
      // OFS_DELTA: negative offset varint
      byte = pack[pos] as number;
      pos += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStart - offset;
    } else if (typeNum === 7) {
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateSync(pack.subarray(pos));
    // inflateSync consumed exactly one stream: find its length by re-walking the
    // deflate stream end is not exposed, so use the zlib stream scan below.
    pos += deflateStreamLength(pack.subarray(pos));
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    const idx = entries.length;
    byOffset.set(entryStart, idx);
    if (typeNum === 6 || typeNum === 7) {
      entries.push({ type: 'blob', data: inflated, baseOid, baseOffset });
    } else {
      const type = NUM_TYPE[typeNum];
      if (!type) throw new Error(`unknown pack object type ${typeNum}`);
      entries.push({ type, data: inflated });
    }
  }

  const resolved: Array<{ type: GitObject['type']; data: Buffer } | null> = entries.map(() => null);
  const resolve = (idx: number): { type: GitObject['type']; data: Buffer } => {
    const hit = resolved[idx];
    if (hit) return hit;
    const entry = entries[idx] as PackEntry;
    let out: { type: GitObject['type']; data: Buffer };
    if (entry.baseOid !== undefined || entry.baseOffset !== undefined) {
      let base: { type: GitObject['type']; data: Buffer };
      if (entry.baseOid !== undefined) {
        const local = byOid(entries, resolved, entry.baseOid);
        if (local) base = local;
        else {
          const stored = repo.objects.get(entry.baseOid);
          if (!stored) throw new Error('thin pack base not in store');
          base = stored;
        }
      } else {
        const baseIdx = byOffset.get(entry.baseOffset as number);
        if (baseIdx === undefined) throw new Error('ofs-delta base offset unknown');
        base = resolve(baseIdx);
      }
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      out = { type: entry.type, data: entry.data };
    }
    resolved[idx] = out;
    return out;
  };
  const byOid = (
    list: PackEntry[],
    done: Array<{ type: GitObject['type']; data: Buffer } | null>,
    oid: string,
  ): { type: GitObject['type']; data: Buffer } | null => {
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as PackEntry;
      if (e.baseOid === undefined && e.baseOffset === undefined && oidOf(e.type, e.data) === oid) return resolve(i);
      if (done[i] && oidOf((done[i] as { type: GitObject['type'] }).type, (done[i] as { data: Buffer }).data) === oid) return done[i];
    }
    return null;
  };

  const stored: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const obj = resolve(i);
    stored.push(storeObject(repo, obj.type, obj.data));
  }
  return stored;
}

/** Length in bytes of the first complete zlib stream at the start of `buf`. */
function deflateStreamLength(buf: Buffer): number {
  // Binary-search the smallest prefix that inflateSync accepts as a full stream.
  let lo = 1;
  let hi = buf.length;
  const ok = (n: number): boolean => {
    try {
      inflateSync(buf.subarray(0, n));
      return true;
    } catch {
      return false;
    }
  };
  if (!ok(hi)) throw new Error('truncated deflate stream in pack');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
