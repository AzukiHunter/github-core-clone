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

// Parsed commits are immutable (stored object bytes never change), so parse
// once per repo and reuse: history walks and fetch planning re-read the same
// commits many times.
const commitInfoCache = new WeakMap<RepoRec, Map<string, CommitInfo>>();

/** The parsed commit for an oid in this repo (cached), or undefined. */
export function getCommitInfo(repo: RepoRec, oid: string): CommitInfo | undefined {
  let cache = commitInfoCache.get(repo);
  if (cache) {
    const hit = cache.get(oid);
    if (hit) return hit;
  }
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return undefined;
  const info = parseCommit(obj.data);
  if (!cache) {
    cache = new Map();
    commitInfoCache.set(repo, cache);
  }
  cache.set(oid, info);
  return info;
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
      const c = getCommitInfo(repo, oid) as CommitInfo;
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
    const info = getCommitInfo(repo, oid);
    if (info) stack.push(...info.parents);
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
      const info = getCommitInfo(repo, oid);
      if (info) stack.push(...info.parents);
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
    const info = getCommitInfo(repo, oid);
    if (info) queue.push(...info.parents);
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
    let size = obj.data.length;
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
    const stream = inflateFirstStream(pack.subarray(pos), size);
    const inflated = stream.data;
    pos += stream.bytes;
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

/**
 * Inflate the first zlib stream in `buf` and report how many bytes it spans.
 *
 * Node's zlib does not expose a sync stream's consumed length, and locating
 * the end by probing prefixes costs a full inflate per probe (~13 per object
 * in the old binary search). Instead, a bit-level scan of the deflate stream
 * (below) predicts the length; the prediction is only trusted once proven
 * exact: the slice of that length must inflate, and one byte less must not
 * (inflateSync tolerates trailing bytes, so an overshooting candidate would
 * inflate from the shorter slice too). Any doubt falls back to probing.
 */
function inflateFirstStream(buf: Buffer, expectedSize: number): { data: Buffer; bytes: number } {
  const scanned = scanZlibStreamLength(buf, expectedSize);
  if (scanned !== null && scanned >= 8 && scanned <= buf.length) {
    try {
      const data = inflateSync(buf.subarray(0, scanned));
      if (data.length === expectedSize && !inflatesFully(buf.subarray(0, scanned - 1))) {
        return { data, bytes: scanned };
      }
    } catch {
      // fall through to the probing path
    }
  }
  const data = inflateSync(buf);
  return { data, bytes: deflateStreamLength(buf) };
}

/**
 * Whether `buf` inflates as one complete stream. Used to prove a scanned
 * length minimal; the expected answer is "no", delivered as an exception —
 * so stack capture is switched off for the duration of the (synchronous)
 * probe, which is where most of a throw's cost sits.
 */
function inflatesFully(buf: Buffer): boolean {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    inflateSync(buf);
    return true;
  } catch {
    return false;
  } finally {
    Error.stackTraceLimit = limit;
  }
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

// ---------------------------------------------------------------- deflate scan
//
// A bit-level reader over a deflate stream that decodes Huffman symbols only
// to find where the stream ends (the produced data itself is discarded; the
// caller inflates with zlib). It throws on anything unexpected, and its one
// caller treats a throw as "no prediction" — never as pack corruption.

class BitReader {
  pos = 0;
  private bit = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.buf.length) throw new Error('deflate scan overran the buffer');
      const byte = this.buf[this.pos] as number;
      v |= ((byte >> this.bit) & 1) << i;
      this.bit += 1;
      if (this.bit === 8) {
        this.bit = 0;
        this.pos += 1;
      }
    }
    return v;
  }

  alignToByte(): void {
    if (this.bit !== 0) {
      this.bit = 0;
      this.pos += 1;
    }
  }

  /** Bytes the consumed bits occupy (a partial byte counts whole). */
  get byteLength(): number {
    return this.pos + (this.bit > 0 ? 1 : 0);
  }

  byteAt(index: number): number {
    const byte = this.buf[index];
    if (byte === undefined) throw new Error('deflate scan overran the buffer');
    return byte;
  }
}

interface HuffTable {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildHuff(lengths: Uint8Array): HuffTable {
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l] = (counts[l] as number) + 1;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = (offs[i - 1] as number) + (counts[i - 1] as number);
  const symbols = new Uint16Array(lengths.length);
  lengths.forEach((l, sym) => {
    if (l !== 0) {
      symbols[offs[l] as number] = sym;
      offs[l] = (offs[l] as number) + 1;
    }
  });
  return { counts, symbols };
}

function huffDecode(bits: BitReader, h: HuffTable): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len < 16; len++) {
    code |= bits.read(1);
    const count = h.counts[len] as number;
    if (code - first < count) return h.symbols[index + (code - first)] as number;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('deflate scan met an invalid huffman code');
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const FIXED_LIT_LENGTHS = new Uint8Array(288);
for (let i = 0; i < 288; i++) FIXED_LIT_LENGTHS[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
const FIXED_LIT_HUFF = buildHuff(FIXED_LIT_LENGTHS);
const FIXED_DIST_HUFF = buildHuff(new Uint8Array(30).fill(5));

/** Walk one compressed block, counting produced bytes; throws past `budget`. */
function scanCompressedBlock(bits: BitReader, lit: HuffTable, dist: HuffTable, budget: number): number {
  let produced = 0;
  for (let symbols = 0; ; symbols++) {
    // Every symbol but end-of-block produces at least one byte.
    if (symbols > budget + 1) throw new Error('deflate scan produced beyond the expected size');
    const sym = huffDecode(bits, lit);
    if (sym < 256) {
      produced += 1;
      continue;
    }
    if (sym === 256) return produced;
    const li = sym - 257;
    if (li >= LENGTH_BASE.length) throw new Error('deflate scan met a bad length symbol');
    produced += (LENGTH_BASE[li] as number) + bits.read(LENGTH_EXTRA[li] as number);
    if (produced > budget) throw new Error('deflate scan produced beyond the expected size');
    const dsym = huffDecode(bits, dist);
    if (dsym >= DIST_EXTRA.length) throw new Error('deflate scan met a bad distance symbol');
    bits.read(DIST_EXTRA[dsym] as number);
  }
}

/** The exact byte length of the zlib stream at the start of `buf`. */
function scanZlibStream(buf: Buffer, expectedSize: number): number {
  if (buf.length < 2) throw new Error('deflate scan needs a header');
  const cmf = buf[0] as number;
  const flg = buf[1] as number;
  if ((cmf & 0x0f) !== 8) throw new Error('not a deflate stream');
  if (((cmf << 8) + flg) % 31 !== 0) throw new Error('bad zlib header check');
  if (flg & 0x20) throw new Error('preset dictionary streams are not scanned');
  const bits = new BitReader(buf);
  bits.read(16);
  let produced = 0;
  let finished = false;
  for (let block = 0; block <= buf.length && !finished; block++) {
    const bfinal = bits.read(1);
    const btype = bits.read(2);
    if (btype === 0) {
      bits.alignToByte();
      const len = bits.byteAt(bits.pos) | (bits.byteAt(bits.pos + 1) << 8);
      const nlen = bits.byteAt(bits.pos + 2) | (bits.byteAt(bits.pos + 3) << 8);
      if (len !== (~nlen & 0xffff)) throw new Error('stored block length check failed');
      bits.pos += 4 + len;
      if (bits.pos > buf.length) throw new Error('deflate scan overran the buffer');
      produced += len;
    } else if (btype === 1) {
      produced += scanCompressedBlock(bits, FIXED_LIT_HUFF, FIXED_DIST_HUFF, expectedSize - produced);
    } else if (btype === 2) {
      const hlit = bits.read(5) + 257;
      const hdist = bits.read(5) + 1;
      const hclen = bits.read(4) + 4;
      const clLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i] as number] = bits.read(3);
      const clHuff = buildHuff(clLengths);
      const total = hlit + hdist;
      const lengths = new Uint8Array(total);
      let i = 0;
      while (i < total) {
        const sym = huffDecode(bits, clHuff);
        if (sym < 16) {
          lengths[i] = sym;
          i += 1;
        } else if (sym === 16) {
          if (i === 0) throw new Error('code length repeat with nothing before it');
          const prev = lengths[i - 1] as number;
          let rep = 3 + bits.read(2);
          while (rep > 0) {
            if (i >= total) throw new Error('code lengths overrun');
            lengths[i] = prev;
            i += 1;
            rep -= 1;
          }
        } else if (sym === 17) {
          i += 3 + bits.read(3);
        } else if (sym === 18) {
          i += 11 + bits.read(7);
        } else {
          throw new Error('bad code length symbol');
        }
      }
      if (i !== total) throw new Error('code lengths overrun');
      const litHuff = buildHuff(lengths.subarray(0, hlit));
      const distHuff = buildHuff(lengths.subarray(hlit));
      produced += scanCompressedBlock(bits, litHuff, distHuff, expectedSize - produced);
    } else {
      throw new Error('bad deflate block type');
    }
    if (produced > expectedSize) throw new Error('deflate scan produced beyond the expected size');
    if (bfinal === 1) finished = true;
  }
  if (!finished) throw new Error('deflate scan never met the final block');
  if (produced !== expectedSize) throw new Error('deflate scan size mismatch');
  return bits.byteLength + 4; // trailing adler32
}

/** scanZlibStream, as a prediction: null whenever anything is in doubt. */
function scanZlibStreamLength(buf: Buffer, expectedSize: number): number | null {
  try {
    return scanZlibStream(buf, expectedSize);
  } catch {
    return null;
  }
}
