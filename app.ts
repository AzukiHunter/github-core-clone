// The forge's HTTP surface: GitHub REST v3, the API root, git smart HTTP
// routing, and the mounts for GraphQL (/api/graphql) and MCP (/mcp).
//
// Discipline the suite checks: every REST reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are always {"message": string}; a missing or
// wrong bearer token is 401; a repository under another owner is 404, never
// 403; unknown routes are a JSON 404; malformed JSON bodies are 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import {
  blobAtPath, buildCommit, flattenTree, getObject, isAncestor, mergeBase, parseCommit, parseIdent,
  parseTree, peelToCommit, storeObject, writeTreeFromFiles, ZERO_OID,
} from './git.ts';
import { advertiseRefs, receivePackHandler, uploadPackV0, uploadPackV2 } from './gitproto.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
export const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
export const store = new Store();

// ---------------------------------------------------------------- replies

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  store.requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `FORGE-${store.requestCounter.toString(16).toUpperCase().padStart(6, '0')}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

// ---------------------------------------------------------------- auth

function authed(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

// ---------------------------------------------------------------- body

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<{ value: Record<string, unknown> } | { error: true }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { value: {} };
    return { value: value as Record<string, unknown> };
  } catch {
    return { error: true };
  }
}

// ---------------------------------------------------------------- JSON views

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: new Date(1_735_689_600_000).toISOString(),
    updated_at: new Date(1_735_689_600_000).toISOString(),
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.owner}/${repo.name}#${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: 1, name, color: label?.color ?? 'ededed', default: false, description: null };
    }),
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: new Date((1_735_689_600 + issue.seq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + issue.seq) * 1000).toISOString(),
    closed_at: issue.closedSeq === null ? null : new Date((1_735_689_600 + issue.closedSeq) * 1000).toISOString(),
    pull_request: undefined,
  };
}

function branchTip(repo: RepoRec, refName: string): string | undefined {
  return repo.refs.get(refName);
}

function headBaseOf(repo: RepoRec, pull: PullRec): { headSha: string; baseSha: string } {
  const headSha = branchTip(repo, `refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = branchTip(repo, `refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return { headSha, baseSha };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const { headSha, baseSha } = headBaseOf(repo, pull);
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.owner}/${repo.name}#${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : new Date((1_735_689_600 + pull.mergedSeq) * 1000).toISOString(),
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    created_at: new Date((1_735_689_600 + pull.seq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + pull.seq) * 1000).toISOString(),
  };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'commit') return { sha: oid };
  const c = parseCommit(obj.data);
  const author = parseIdent(c.author);
  const committer = parseIdent(c.committer);
  const iso = (sec: number): string => new Date(sec * 1000).toISOString();
  return {
    sha: oid,
    commit: {
      tree: { sha: c.tree },
      message: c.message.replace(/\n$/, ''),
      author: { name: author.name, email: author.email, date: iso(author.epochSec) },
      committer: { name: committer.name, email: committer.email, date: iso(committer.epochSec) },
    },
    parents: c.parents.map((p) => ({ sha: p })),
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
  };
}

// ---------------------------------------------------------------- git helpers over the store

const ident = (): string => `${VIEWER_NAME} <${VIEWER_LOGIN}@example.invalid> ${store.nowGitStamp()}`;

/** Commit a full file map onto a branch; creates the branch when missing. Returns the commit oid. */
function commitFiles(repo: RepoRec, branch: string, files: Map<string, { oid: string; mode: string }>, message: string, extraParent?: string): string {
  const tree = writeTreeFromFiles(repo, files);
  const ref = `refs/heads/${branch}`;
  const parents: string[] = [];
  const tip = repo.refs.get(ref);
  if (tip) parents.push(peelToCommit(repo, tip));
  if (extraParent) parents.push(extraParent);
  const stamp = ident();
  const oid = storeObject(repo, 'commit', buildCommit(tree, parents, stamp, stamp, message.endsWith('\n') ? message : `${message}\n`));
  repo.refs.set(ref, oid);
  return oid;
}

/** The flattened file map at a branch tip (empty for an unborn branch). */
function filesAt(repo: RepoRec, commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
  if (!commitOid) return new Map();
  const obj = getObject(repo, peelToCommit(repo, commitOid));
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

/** First-parent + full history walk from a tip, newest first (suite histories are linear). */
function historyFrom(repo: RepoRec, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i] as string);
  }
  return out;
}

/** Three-way tree merge; null on conflict. Returns the merged file map. */
export function threeWayMerge(
  base: Map<string, { oid: string; mode: string }>,
  head: Map<string, { oid: string; mode: string }>,
  ancestor: Map<string, { oid: string; mode: string }>,
): Map<string, { oid: string; mode: string }> | null {
  const out = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...head.keys(), ...ancestor.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const a = ancestor.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
    if (same(h, b)) {
      if (b) out.set(path, b);
    } else if (same(b, a)) {
      if (h) out.set(path, h);
    } else if (same(h, a)) {
      if (b) out.set(path, b);
    } else {
      return null;
    }
  }
  return out;
}

/** Changed files between two file maps, with line-level counts. */
export function diffFiles(
  repo: RepoRec,
  base: Map<string, { oid: string; mode: string }>,
  head: Map<string, { oid: string; mode: string }>,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }> {
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b?.oid === h?.oid) continue;
    const lines = (f?: { oid: string }): string[] => {
      if (!f) return [];
      const obj = getObject(repo, f.oid);
      return obj ? obj.data.toString('utf8').split('\n') : [];
    };
    const oldLines = lines(b);
    const newLines = lines(h);
    const counts = (arr: string[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const l of arr) m.set(l, (m.get(l) ?? 0) + 1);
      return m;
    };
    const oldCount = counts(oldLines);
    const newCount = counts(newLines);
    let additions = 0;
    let deletions = 0;
    for (const [l, n] of newCount) additions += Math.max(0, n - (oldCount.get(l) ?? 0));
    for (const [l, n] of oldCount) deletions += Math.max(0, n - (newCount.get(l) ?? 0));
    out.push({
      filename: path,
      status: !b ? 'added' : !h ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: h?.oid ?? b?.oid ?? ZERO_OID,
    });
  }
  return out;
}

/** Merge (or squash) a pull request; returns the merge commit oid, or null on conflict. */
export function mergePull(repo: RepoRec, pull: PullRec, method: string): string | null {
  const { headSha, baseSha } = headBaseOf(repo, pull);
  if (headSha === ZERO_OID || baseSha === ZERO_OID) return null;
  const headCommit = peelToCommit(repo, headSha);
  const baseCommit = peelToCommit(repo, baseSha);
  const base0 = mergeBase(repo, baseCommit, headCommit);
  const mergedFiles = threeWayMerge(filesAt(repo, baseCommit), filesAt(repo, headCommit), base0 ? filesAt(repo, base0) : new Map());
  if (!mergedFiles) return null;
  if (method === 'merge') {
    const tree = writeTreeFromFiles(repo, mergedFiles);
    const stamp = ident();
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n`;
    const oid = storeObject(repo, 'commit', buildCommit(tree, [baseCommit, headCommit], stamp, stamp, message));
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    return oid;
  }
  // squash: one commit on top of the base tip carrying the head branch's changes
  return commitFiles(repo, pull.baseRef, mergedFiles, `${pull.title} (#${pull.number})`);
}

// ---------------------------------------------------------------- pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(url: URL): Page {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { perPage, page };
}

function paginate<T>(res: ServerResponse, req: IncomingMessage, url: URL, items: T[], page: Page): T[] {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const base = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
  const withPage = (p: number): string => {
    const q = new URLSearchParams(url.searchParams);
    q.set('page', String(p));
    q.set('per_page', String(page.perPage));
    return `${base}?${q.toString()}`;
  };
  const links: string[] = [];
  if (page.page < totalPages) links.push(`<${withPage(page.page + 1)}>; rel="next"`, `<${withPage(totalPages)}>; rel="last"`);
  if (page.page > 1) links.push(`<${withPage(page.page - 1)}>; rel="prev"`, `<${withPage(1)}>; rel="first"`);
  if (links.length) res.setHeader('link', links.join(', '));
  return items.slice((page.page - 1) * page.perPage, page.page * page.perPage);
}

// ---------------------------------------------------------------- REST routing

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const seg = path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  // seg[0] = 'api', seg[1] = 'v3', rest follows.

  if (!authed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (method === 'GET' && seg.length === 2) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues?q={query}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (method === 'GET' && seg.length === 3 && seg[2] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }

  if (method === 'GET' && seg.length === 3 && seg[2] === 'user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: `${VIEWER_LOGIN}@example.invalid` });
    return;
  }

  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'POST') {
      const body = await readJson(req);
      if ('error' in body) return badRequest(res, 'Problems parsing JSON');
      const name = String(body.value.name ?? '');
      if (!name) return unprocessable(res, 'Repository creation failed.');
      if (store.getRepo(VIEWER_LOGIN, name)) {
        return sendJson(res, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
      }
      const repo = store.createRepo(VIEWER_LOGIN, name, String(body.value.description ?? ''), Boolean(body.value.private ?? false));
      if (body.value.auto_init === true) {
        const tree = writeTreeFromFiles(repo, new Map());
        const stamp = ident();
        const oid = storeObject(repo, 'commit', buildCommit(tree, [], stamp, stamp, 'Initial commit\n'));
        repo.refs.set(`refs/heads/${repo.defaultBranch}`, oid);
      }
      return sendJson(res, 201, repoJson(repo));
    }
    if (method === 'GET') {
      const page = pageOf(url);
      const slice = paginate(res, req, url, store.reposOf(VIEWER_LOGIN).map(repoJson), page);
      return sendJson(res, 200, slice);
    }
    return notFound(res);
  }

  if (seg.length >= 5 && seg[2] === 'repos') {
    const owner = seg[3] as string;
    const name = seg[4] as string;
    const repo = store.getRepo(owner, name);
    const rest = seg.slice(5);

    if (rest.length === 0) {
      if (!repo) return notFound(res);
      if (method === 'GET') return sendJson(res, 200, repoJson(repo));
      if (method === 'PATCH') {
        const body = await readJson(req);
        if ('error' in body) return badRequest(res, 'Problems parsing JSON');
        if (typeof body.value.description === 'string') repo.description = body.value.description;
        if (typeof body.value.private === 'boolean') repo.isPrivate = body.value.private;
        if (typeof body.value.name === 'string' && body.value.name) repo.name = body.value.name;
        if (typeof body.value.default_branch === 'string' && body.value.default_branch) repo.defaultBranch = body.value.default_branch;
        return sendJson(res, 200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': `FORGE-${(++store.requestCounter).toString(16).toUpperCase()}` });
        res.end();
        return;
      }
      return notFound(res);
    }
    if (!repo) return notFound(res);
    return handleRepoScoped(req, res, url, repo, rest);
  }

  return notFound(res);
}

async function handleRepoScoped(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, rest: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  const [head, ...tail] = rest;

  // ----- branches & git refs
  if (head === 'branches' && method === 'GET') {
    if (tail.length === 0) {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({
          name: r.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(r) as string },
          protected: false,
        }));
      return sendJson(res, 200, branches);
    }
    const branch = tail.join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return notFound(res);
    return sendJson(res, 200, { name: branch, commit: commitJson(repo, sha), protected: false });
  }

  if (head === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const body = await readJson(req);
      if ('error' in body) return badRequest(res, 'Problems parsing JSON');
      const ref = String(body.value.ref ?? '');
      const sha = String(body.value.sha ?? '');
      if (!ref.startsWith('refs/') || !getObject(repo, sha)) return unprocessable(res, 'Invalid ref or sha.');
      if (repo.refs.has(ref)) return unprocessable(res, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, node_id: '', object: { sha, type: getObject(repo, sha)?.type ?? 'commit' } });
    }
    if (method === 'GET') {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound(res);
      return sendJson(res, 200, { ref, node_id: '', object: { sha, type: getObject(repo, sha)?.type ?? 'commit' } });
    }
    return notFound(res);
  }

  if (head === 'git' && tail[0] === 'trees' && method === 'GET') {
    const obj = getObject(repo, tail[1] ?? '');
    if (!obj || obj.type !== 'tree') return notFound(res);
    return sendJson(res, 200, {
      sha: tail[1],
      tree: parseTree(obj.data).map((e) => ({ path: e.name, mode: e.mode, type: e.mode === '40000' ? 'tree' : 'blob', sha: e.oid })),
    });
  }

  // ----- commits
  if (head === 'commits' && method === 'GET') {
    if (tail.length === 1) {
      const oid = tail[0] as string;
      if (!getObject(repo, oid)) return notFound(res);
      return sendJson(res, 200, commitJson(repo, oid));
    }
    const shaParam = url.searchParams.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (getObject(repo, shaParam) ? shaParam : undefined);
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (!tip) return sendJson(res, 200, []);
    const page = pageOf(url);
    const all = historyFrom(repo, peelToCommit(repo, tip)).map((oid) => commitJson(repo, oid));
    return sendJson(res, 200, paginate(res, req, url, all, page));
  }

  // ----- contents
  if (head === 'contents') {
    const path = tail.join('/');
    const branchParam = url.searchParams.get('ref') ?? undefined;
    if (method === 'GET') {
      const branch = branchParam ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip) return notFound(res);
      const files = filesAt(repo, tip);
      const entry = files.get(path);
      if (entry) {
        const obj = getObject(repo, entry.oid);
        return sendJson(res, 200, {
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: entry.oid,
          size: obj?.data.length ?? 0,
          content: obj ? obj.data.toString('base64') : '',
          encoding: 'base64',
        });
      }
      // Directory listing.
      const prefix = path ? `${path}/` : '';
      const dirEntries = new Map<string, { type: 'file' | 'dir'; sha: string }>();
      for (const [p, f] of files) {
        if (!p.startsWith(prefix)) continue;
        const remainder = p.slice(prefix.length);
        const slash = remainder.indexOf('/');
        if (slash < 0) dirEntries.set(remainder, { type: 'file', sha: f.oid });
        else {
          const dir = remainder.slice(0, slash);
          if (!dirEntries.has(dir)) {
            const dirTree = treeOidAt(repo, tip, prefix + dir);
            dirEntries.set(dir, { type: 'dir', sha: dirTree ?? ZERO_OID });
          }
        }
      }
      if (dirEntries.size === 0 && path !== '') return notFound(res);
      const listing = [...dirEntries.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([entryName, e]) => ({ type: e.type, name: entryName, path: prefix + entryName, sha: e.sha }));
      return sendJson(res, 200, listing);
    }
    if (method === 'PUT' || method === 'DELETE') {
      const body = await readJson(req);
      if ('error' in body) return badRequest(res, 'Problems parsing JSON');
      const message = String(body.value.message ?? (method === 'PUT' ? 'Create file' : 'Delete file'));
      const branch = String(body.value.branch ?? branchParam ?? repo.defaultBranch);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      let files = filesAt(repo, tip);
      if (!tip && branch !== repo.defaultBranch) files = filesAt(repo, repo.refs.get(`refs/heads/${repo.defaultBranch}`));
      const existing = files.get(path);
      const givenSha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
      if (method === 'PUT') {
        if (existing && givenSha !== existing.oid) return sendJson(res, 409, { message: 'Conflict: sha does not match' });
        const content = Buffer.from(String(body.value.content ?? ''), 'base64');
        const blob = storeObject(repo, 'blob', content);
        files.set(path, { oid: blob, mode: '100644' });
        const commit = commitFiles(repo, branch, files, message);
        return sendJson(res, existing ? 200 : 201, {
          content: { type: 'file', name: path.split('/').pop(), path, sha: blob, size: content.length, encoding: 'base64' },
          commit: { sha: commit, message },
        });
      }
      // DELETE
      if (!existing) return notFound(res);
      if (givenSha !== undefined && givenSha !== existing.oid) return sendJson(res, 409, { message: 'Conflict: sha does not match' });
      files.delete(path);
      const commit = commitFiles(repo, branch, files, message);
      return sendJson(res, 200, { content: null, commit: { sha: commit, message } });
    }
    return notFound(res);
  }

  // ----- labels
  if (head === 'labels') {
    if (method === 'POST' && tail.length === 0) {
      const body = await readJson(req);
      if ('error' in body) return badRequest(res, 'Problems parsing JSON');
      const labelName = String(body.value.name ?? '');
      if (!labelName) return unprocessable(res, 'Validation Failed: name is required');
      if (repo.labels.has(labelName)) return unprocessable(res, 'Validation Failed: label already exists');
      const color = String(body.value.color ?? 'ededed');
      repo.labels.set(labelName, { name: labelName, color });
      return sendJson(res, 201, { id: 1, name: labelName, color, default: false, description: null });
    }
    if (method === 'GET' && tail.length === 0) {
      return sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: 1, name: l.name, color: l.color, default: false, description: null })));
    }
    return notFound(res);
  }

  // ----- issues & their comments
  if (head === 'issues') {
    if (tail.length === 0) {
      if (method === 'POST') {
        const body = await readJson(req);
        if ('error' in body) return badRequest(res, 'Problems parsing JSON');
        const labels = Array.isArray(body.value.labels) ? body.value.labels.map(String) : [];
        for (const l of labels) {
          if (!repo.labels.has(l)) return unprocessable(res, `Validation Failed: label "${l}" does not exist`);
        }
        const issue: IssueRec = {
          id: store.newIssueId(),
          number: repo.nextNumber,
          title: String(body.value.title ?? ''),
          body: String(body.value.body ?? ''),
          state: 'open',
          labels,
          seq: store.nextSeq(),
          closedSeq: null,
          comments: [],
        };
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        return sendJson(res, 201, issueJson(repo, issue));
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        const direction = url.searchParams.get('direction') ?? 'desc';
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const page = pageOf(url);
        return sendJson(res, 200, paginate(res, req, url, list.map((i) => issueJson(repo, i)), page));
      }
      return notFound(res);
    }
    const number = Number(tail[0]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (tail.length === 1) {
      if (!issue) return notFound(res);
      if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const body = await readJson(req);
        if ('error' in body) return badRequest(res, 'Problems parsing JSON');
        if (typeof body.value.title === 'string') issue.title = body.value.title;
        if (typeof body.value.body === 'string') issue.body = body.value.body;
        if (body.value.state === 'closed' || body.value.state === 'open') {
          issue.state = body.value.state;
          issue.closedSeq = body.value.state === 'closed' ? store.nextSeq() : null;
        }
        if (Array.isArray(body.value.labels)) {
          const labels = body.value.labels.map(String);
          for (const l of labels) if (!repo.labels.has(l)) return unprocessable(res, `Validation Failed: label "${l}" does not exist`);
          issue.labels = labels;
        }
        return sendJson(res, 200, issueJson(repo, issue));
      }
      return notFound(res);
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      if (!issue) return notFound(res);
      if (method === 'POST') {
        const body = await readJson(req);
        if ('error' in body) return badRequest(res, 'Problems parsing JSON');
        const comment = { id: store.newCommentId(), body: String(body.value.body ?? ''), seq: store.nextSeq() };
        issue.comments.push(comment);
        return sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: new Date((1_735_689_600 + comment.seq) * 1000).toISOString() });
      }
      if (method === 'GET') {
        return sendJson(res, 200, issue.comments.map((c) => ({
          id: c.id,
          body: c.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID },
          created_at: new Date((1_735_689_600 + c.seq) * 1000).toISOString(),
        })));
      }
      return notFound(res);
    }
    return notFound(res);
  }

  // ----- pulls
  if (head === 'pulls') {
    if (tail.length === 0) {
      if (method === 'POST') {
        const body = await readJson(req);
        if ('error' in body) return badRequest(res, 'Problems parsing JSON');
        const headRef = String(body.value.head ?? '');
        const baseRef = String(body.value.base ?? repo.defaultBranch);
        if (!repo.refs.has(`refs/heads/${headRef}`)) return unprocessable(res, `Validation Failed: head branch "${headRef}" does not exist`);
        if (!repo.refs.has(`refs/heads/${baseRef}`)) return unprocessable(res, `Validation Failed: base branch "${baseRef}" does not exist`);
        const pull: PullRec = {
          id: store.newIssueId(),
          number: repo.nextNumber,
          title: String(body.value.title ?? ''),
          body: String(body.value.body ?? ''),
          state: 'open',
          headRef,
          baseRef,
          seq: store.nextSeq(),
          merged: false,
          mergeCommitSha: null,
          mergedSeq: null,
        };
        repo.nextNumber += 1;
        repo.pulls.set(pull.number, pull);
        return sendJson(res, 201, pullJson(repo, pull));
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        const direction = url.searchParams.get('direction') ?? 'desc';
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const page = pageOf(url);
        return sendJson(res, 200, paginate(res, req, url, list.map((p) => pullJson(repo, p)), page));
      }
      return notFound(res);
    }
    const number = Number(tail[0]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 1) {
      if (!pull) return notFound(res);
      if (method === 'GET') return sendJson(res, 200, pullJson(repo, pull));
      if (method === 'PATCH') {
        const body = await readJson(req);
        if ('error' in body) return badRequest(res, 'Problems parsing JSON');
        if (typeof body.value.title === 'string') pull.title = body.value.title;
        if (typeof body.value.body === 'string') pull.body = body.value.body;
        if (body.value.state === 'closed' || body.value.state === 'open') pull.state = body.value.state;
        return sendJson(res, 200, pullJson(repo, pull));
      }
      return notFound(res);
    }
    if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
      if (!pull) return notFound(res);
      const { headSha, baseSha } = headBaseOf(repo, pull);
      const baseCommit = baseSha === ZERO_OID ? ZERO_OID : peelToCommit(repo, baseSha);
      const headCommit = headSha === ZERO_OID ? ZERO_OID : peelToCommit(repo, headSha);
      const base0 = baseCommit !== ZERO_OID && headCommit !== ZERO_OID ? mergeBase(repo, baseCommit, headCommit) : null;
      const files = diffFiles(repo, base0 ? filesAt(repo, base0) : new Map(), filesAt(repo, headCommit === ZERO_OID ? undefined : headCommit));
      const page = pageOf(url);
      return sendJson(res, 200, paginate(res, req, url, files, page));
    }
    if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
      if (!pull) return notFound(res);
      const body = await readJson(req);
      if ('error' in body) return badRequest(res, 'Problems parsing JSON');
      if (pull.merged) return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      if (pull.state !== 'open') return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      const mergeMethod = typeof body.value.merge_method === 'string' ? body.value.merge_method : 'squash';
      if (!isAncestor(repo, peelToCommit(repo, headBaseOf(repo, pull).baseSha), peelToCommit(repo, headBaseOf(repo, pull).headSha)) || true) {
        // fallthrough to the real merge attempt below
      }
      const sha = mergePull(repo, pull, mergeMethod === 'merge' ? 'merge' : 'squash');
      if (!sha) return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = sha;
      pull.mergedSeq = store.nextSeq();
      return sendJson(res, 200, { merged: true, sha, message: 'Pull Request successfully merged' });
    }
    return notFound(res);
  }

  return notFound(res);
}

/** The tree oid at a directory path inside a commit's tree (for dir listings). */
function treeOidAt(repo: RepoRec, tip: string, dirPath: string): string | undefined {
  const obj = getObject(repo, peelToCommit(repo, tip));
  if (!obj || obj.type !== 'commit') return undefined;
  let treeOid = parseCommit(obj.data).tree;
  if (!dirPath) return treeOid;
  for (const part of dirPath.split('/')) {
    const tree = getObject(repo, treeOid);
    if (!tree || tree.type !== 'tree') return undefined;
    const entry = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return undefined;
    treeOid = entry.oid;
  }
  return treeOid;
}

// ---------------------------------------------------------------- git routing

function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const method = req.method ?? 'GET';
  const m = /^\/(.+?)\/(.+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!m) return false;
  const owner = decodeURIComponent(m[1] as string);
  const name = decodeURIComponent(m[2] as string);
  const service = m[3] as string;
  const repo = store.getRepo(owner, name);

  if (service === 'info/refs') {
    if (!repo) {
      notFound(res);
      return true;
    }
    const svc = url.searchParams.get('service');
    if (svc !== 'git-upload-pack' && svc !== 'git-receive-pack') {
      notFound(res);
      return true;
    }
    const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    sendRaw(res, 200, advertiseRefs(repo, svc, v2), `application/x-${svc}-advertisement`);
    return true;
  }

  if (!repo) {
    notFound(res);
    return true;
  }
  return true; // POST bodies are handled by the async caller below
}

async function handleGitPost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = /^\/(.+?)\/(.+?)\.git\/(git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!m) return false;
  const owner = decodeURIComponent(m[1] as string);
  const name = decodeURIComponent(m[2] as string);
  const service = m[3] as string;
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(res);
    return true;
  }
  const body = await readBody(req);
  const repoKey = `${owner}/${name}`;
  try {
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, receivePackHandler(repo, body), 'application/x-git-receive-pack-result');
    } else if ((req.headers['git-protocol'] ?? '').includes('version=2')) {
      sendRaw(res, 200, uploadPackV2(repo, repoKey, body), 'application/x-git-upload-pack-result');
    } else {
      sendRaw(res, 200, uploadPackV0(repo, repoKey, body), 'application/x-git-upload-pack-result');
    }
  } catch {
    // A malformed body must never kill the server: answer 400 and stay up.
    if (!res.headersSent) sendJson(res, 400, { message: 'Bad Request' });
  }
  return true;
}

// ---------------------------------------------------------------- server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/graphql' && method === 'POST') {
          await handleGraphql(req, res, store, authed(req), readBody);
          return;
        }
        if (path === '/mcp' && method === 'POST') {
          await handleMcp(req, res, store, authed(req), readBody);
          return;
        }
        if (path.startsWith('/api/v3')) {
          await handleRest(req, res, url);
          return;
        }
        if (path.endsWith('.git/info/refs') || path.includes('.git/')) {
          if (method === 'GET' && handleGit(req, res, url)) return;
          if (method === 'POST' && (await handleGitPost(req, res, url))) return;
        }
        notFound(res);
      } catch {
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { message: 'Internal Server Error' });
          } catch { /* socket gone */ }
        }
      }
    })();
  });
}
