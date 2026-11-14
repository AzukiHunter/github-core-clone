// A small GraphQL executor covering exactly the v4 surface the suite drives:
// the viewer's login, repository fields, issue/pull-request connections with
// cursor pagination, the five mutations gh and github-mcp-server send, node(id:)
// lookups, minimal __type introspection, batched operations, and field errors
// reported the way GitHub reports them (HTTP 200 with an errors array).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_ID, VIEWER_LOGIN, globalId, parseGlobalId, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { diffFiles, issueJson, mergePull, pullJson, repoJson } from './app.ts';
import { getObject, mergeBase, peelToCommit } from './git.ts';

// ---------------------------------------------------------------- parsing

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; value: string }
  | { kind: 'list'; value: Value[] }
  | { kind: 'object'; value: Array<[string, Value]> }
  | { kind: 'null' };

interface FieldNode {
  name: string;
  alias?: string;
  args: Array<[string, Value]>;
  selections: FieldNode[];
  typeCondition?: string; // on inline fragments: the field list applies when matched
}

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selections: FieldNode[];
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:$!'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push(`"${src.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { out += src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^-?\d+(?:\.\d+)?/.exec(src.slice(i));
    if (m) { tokens.push(m[0]); i += m[0].length; continue; }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: string[]) {}
  peek(): string | undefined { return this.tokens[this.pos]; }
  next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    if (t === undefined) throw new Error('unexpected end of document');
    return t;
  }
  expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new Error(`expected ${t}, got ${got}`);
  }
  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) ops.push(this.parseOperation());
    return ops;
  }
  parseOperation(): Operation {
    const t = this.peek();
    if (t === '{') return { type: 'query', selections: this.parseSelectionSet() };
    const kind = this.next();
    if (kind !== 'query' && kind !== 'mutation') throw new Error(`unsupported operation ${kind}`);
    let name: string | undefined;
    if (this.peek() && /^[A-Za-z_]/.test(this.peek() as string) && this.peek() !== '(' && this.peek() !== '{') name = this.next();
    if (this.peek() === '(') this.skipParens(); // variable definitions
    if (this.peek() === '@') { this.next(); this.next(); } // a directive, if any
    return { type: kind, name, selections: this.parseSelectionSet() };
  }
  skipParens(): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t === '(') depth += 1;
      else if (t === ')') depth -= 1;
    } while (depth > 0);
  }
  parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') fields.push(this.parseField());
    this.expect('}');
    return fields;
  }
  parseField(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      const on = this.next();
      if (on !== 'on') throw new Error('named fragments are not supported');
      const type = this.next();
      const selections = this.parseSelectionSet();
      return { name: '__fragment', typeCondition: type, args: [], selections };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<[string, Value]> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push([argName, this.parseValue()]);
      }
      this.expect(')');
    }
    let selections: FieldNode[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { name, alias, args, selections };
  }
  parseValue(): Value {
    const t = this.next();
    if (t === '$') return { kind: 'var', value: this.next() };
    if (t === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', value: items };
    }
    if (t === '{') {
      const entries: Array<[string, Value]> = [];
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        entries.push([key, this.parseValue()]);
      }
      this.expect('}');
      return { kind: 'object', value: entries };
    }
    if (t.startsWith('"')) return { kind: 'string', value: t.slice(1, -1) };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?\d*\.\d+$/.test(t)) return { kind: 'float', value: Number(t) };
    if (t === 'true') return { kind: 'bool', value: true };
    if (t === 'false') return { kind: 'bool', value: false };
    if (t === 'null') return { kind: 'null' };
    return { kind: 'enum', value: t };
  }
}

function resolveValue(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'string': case 'int': case 'float': case 'bool': case 'enum': return v.value;
    case 'var': return vars[v.value];
    case 'list': return v.value.map((x) => resolveValue(x, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, x] of v.value) out[k] = resolveValue(x, vars);
      return out;
    }
    case 'null': return null;
  }
}

function argsOf(field: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of field.args) out[k] = resolveValue(v, vars);
  return out;
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Resolver = (source: unknown, field: FieldNode, ctx: Ctx) => unknown;

const ISSUE_TYPE_FIELDS = [
  'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments',
  'repository', 'createdAt', 'updatedAt', 'closedAt', 'url', 'viewerDidAuthor',
];
const PULL_TYPE_FIELDS = [
  'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'baseRefName', 'headRefName',
  'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'repository', 'createdAt', 'updatedAt', 'url',
];
const REPO_TYPE_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issues', 'issue', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULLREQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'];

interface RepoSource { repo: RepoRec }
interface IssueSource { repo: RepoRec; issue: IssueRec }
interface PullSource { repo: RepoRec; pull: PullRec }

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) + 1 : 0;
  } catch {
    return 0;
  }
}

function executeSelections(typeName: string, source: unknown, selections: FieldNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.name === '__fragment') {
      if (field.typeCondition === typeName) Object.assign(out, executeSelections(typeName, source, field.selections, ctx));
      continue;
    }
    const key = field.alias ?? field.name;
    const resolver = RESOLVERS[typeName]?.[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    out[key] = resolver(source, field, ctx);
  }
  return out;
}

function select(typeName: string, source: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (!field.selections.length) return source;
  return executeSelections(typeName, source, field.selections, ctx);
}

function findIssueByGlobalId(store: Store, id: unknown): IssueSource | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const hash = parsed.key.lastIndexOf('#');
  const repoKey = parsed.key.slice(0, hash);
  const number = Number(parsed.key.slice(hash + 1));
  const [owner, name] = repoKey.split('/');
  const repo = owner && name ? store.getRepo(owner, name) : undefined;
  const issue = repo?.issues.get(number);
  return repo && issue ? { repo, issue } : null;
}

function findPullByGlobalId(store: Store, id: unknown): PullSource | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const hash = parsed.key.lastIndexOf('#');
  const repoKey = parsed.key.slice(0, hash);
  const number = Number(parsed.key.slice(hash + 1));
  const [owner, name] = repoKey.split('/');
  const repo = owner && name ? store.getRepo(owner, name) : undefined;
  const pull = repo?.pulls.get(number);
  return repo && pull ? { repo, pull } : null;
}

function findRepoByGlobalId(store: Store, id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  for (const repo of store.repos.values()) if (repo.id === Number(parsed.key)) return repo;
  return null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_s, field, ctx) => select('User', { login: VIEWER_LOGIN }, field, ctx),
    repository: (_s, field, ctx) => {
      const args = argsOf(field, ctx.vars);
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      return select('Repository', { repo } satisfies RepoSource, field, ctx);
    },
    node: (_s, field, ctx) => {
      const args = argsOf(field, ctx.vars);
      const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoByGlobalId(ctx.store, args.id);
        return repo ? select('Repository', { repo } satisfies RepoSource, field, ctx) : null;
      }
      if (parsed.kind === 'Issue') {
        const found = findIssueByGlobalId(ctx.store, args.id);
        return found ? select('Issue', found, field, ctx) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const found = findPullByGlobalId(ctx.store, args.id);
        return found ? select('PullRequest', found, field, ctx) : null;
      }
      return null;
    },
    __type: (_s, field, ctx) => {
      const args = argsOf(field, ctx.vars);
      const name = String(args.name ?? '');
      const known: Record<string, { fields?: string[]; enumValues?: string[] }> = {
        Issue: { fields: ISSUE_TYPE_FIELDS },
        PullRequest: { fields: PULL_TYPE_FIELDS },
        Repository: { fields: REPO_TYPE_FIELDS },
        SearchType: { enumValues: SEARCH_TYPE_VALUES },
      };
      const spec = known[name];
      if (!spec) return null;
      return select('__Type', { name, ...spec }, field, ctx);
    },
  },
  User: {
    login: () => VIEWER_LOGIN,
    id: () => globalId('User', String(VIEWER_ID)),
  },
  __Type: {
    name: (s) => (s as { name: string }).name,
    fields: (s, field, ctx) => {
      const spec = s as { fields?: string[] };
      if (!spec.fields) return null;
      return spec.fields.map((name) => select('__Field', { name }, field, ctx));
    },
    enumValues: (s, field, ctx) => {
      const spec = s as { enumValues?: string[] };
      if (!spec.enumValues) return null;
      return spec.enumValues.map((name) => select('__EnumValue', { name }, field, ctx));
    },
  },
  __Field: { name: (s) => (s as { name: string }).name },
  __EnumValue: { name: (s) => (s as { name: string }).name },
  Repository: {
    id: (s) => globalId('Repository', String((s as RepoSource).repo.id)),
    databaseId: (s) => (s as RepoSource).repo.id,
    name: (s) => (s as RepoSource).repo.name,
    nameWithOwner: (s) => `${(s as RepoSource).repo.owner}/${(s as RepoSource).repo.name}`,
    description: (s) => (s as RepoSource).repo.description,
    isPrivate: (s) => (s as RepoSource).repo.isPrivate,
    owner: (s, field, ctx) => select('User', { login: (s as RepoSource).repo.owner }, field, ctx),
    defaultBranchRef: (s, field, ctx) => select('Ref', { name: (s as RepoSource).repo.defaultBranch }, field, ctx),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issues: (s, field, ctx) => {
      const { repo } = s as RepoSource;
      const args = argsOf(field, ctx.vars);
      let list = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (states?.length) {
        const wanted = states.map((x) => x.toLowerCase());
        list = list.filter((i) => wanted.includes(i.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      list.sort((a, b) => (orderBy?.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      const start = args.after ? indexFromCursor(args.after) : 0;
      const first = typeof args.first === 'number' ? args.first : list.length;
      const pageItems = list.slice(start, start + first);
      const hasNext = start + pageItems.length < list.length;
      return select('IssueConnection', {
        nodes: pageItems.map((issue) => ({ repo, issue })),
        pageInfo: { hasNextPage: hasNext, endCursor: pageItems.length ? cursorFor(start + pageItems.length - 1) : null },
      }, field, ctx);
    },
    issue: (s, field, ctx) => {
      const { repo } = s as RepoSource;
      const args = argsOf(field, ctx.vars);
      const issue = repo.issues.get(Number(args.number));
      return issue ? select('Issue', { repo, issue } satisfies IssueSource, field, ctx) : null;
    },
    pullRequests: (s, field, ctx) => {
      const { repo } = s as RepoSource;
      const args = argsOf(field, ctx.vars);
      const list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const pageItems = list.slice(0, first);
      return select('PullRequestConnection', {
        nodes: pageItems.map((pull) => ({ repo, pull })),
        pageInfo: { hasNextPage: list.length > pageItems.length, endCursor: pageItems.length ? cursorFor(pageItems.length - 1) : null },
      }, field, ctx);
    },
    pullRequest: (s, field, ctx) => {
      const { repo } = s as RepoSource;
      const args = argsOf(field, ctx.vars);
      const pull = repo.pulls.get(Number(args.number));
      return pull ? select('PullRequest', { repo, pull } satisfies PullSource, field, ctx) : null;
    },
  },
  Ref: { name: (s) => (s as { name: string }).name },
  IssueConnection: {
    nodes: (s, field, ctx) => (s as { nodes: IssueSource[] }).nodes.map((n) => select('Issue', n, field, ctx)),
    pageInfo: (s, field, ctx) => select('PageInfo', (s as { pageInfo: unknown }).pageInfo, field, ctx),
  },
  PullRequestConnection: {
    nodes: (s, field, ctx) => (s as { nodes: PullSource[] }).nodes.map((n) => select('PullRequest', n, field, ctx)),
    pageInfo: (s, field, ctx) => select('PageInfo', (s as { pageInfo: unknown }).pageInfo, field, ctx),
  },
  PageInfo: {
    hasNextPage: (s) => (s as { hasNextPage: boolean }).hasNextPage,
    endCursor: (s) => (s as { endCursor: string | null }).endCursor,
  },
  Issue: {
    id: (s) => globalId('Issue', `${(s as IssueSource).repo.owner}/${(s as IssueSource).repo.name}#${(s as IssueSource).issue.number}`),
    databaseId: (s) => (s as IssueSource).issue.id,
    number: (s) => (s as IssueSource).issue.number,
    title: (s) => (s as IssueSource).issue.title,
    body: (s) => (s as IssueSource).issue.body,
    state: (s) => ((s as IssueSource).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    repository: (s, field, ctx) => select('Repository', { repo: (s as IssueSource).repo } satisfies RepoSource, field, ctx),
  },
  PullRequest: {
    id: (s) => globalId('PullRequest', `${(s as PullSource).repo.owner}/${(s as PullSource).repo.name}#${(s as PullSource).pull.number}`),
    databaseId: (s) => (s as PullSource).pull.id,
    number: (s) => (s as PullSource).pull.number,
    title: (s) => (s as PullSource).pull.title,
    body: (s) => (s as PullSource).pull.body,
    state: (s) => {
      const p = (s as PullSource).pull;
      return p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (s) => (s as PullSource).pull.merged,
    headRefName: (s) => (s as PullSource).pull.headRef,
    baseRefName: (s) => (s as PullSource).pull.baseRef,
    mergeable: (s, _f, ctx) => {
      const { repo, pull } = s as PullSource;
      if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (!headSha || !baseSha) return 'UNKNOWN';
      const { threeWayMerge, filesAtHead } = mergeability;
      return threeWayMerge(repo, baseSha, headSha, filesAtHead) ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (s, field, ctx) => {
      const { repo, pull } = s as PullSource;
      const args = argsOf(field, ctx.vars);
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
      let paths: string[] = [];
      if (headSha && baseSha) {
        const baseCommit = peelToCommit(repo, baseSha);
        const headCommit = peelToCommit(repo, headSha);
        const base0 = mergeBase(repo, baseCommit, headCommit);
        paths = diffFiles(repo, filesOf(repo, base0 ?? undefined), filesOf(repo, headCommit)).map((f) => f.filename);
      }
      const first = typeof args.first === 'number' ? args.first : paths.length;
      const pagePaths = paths.slice(0, first);
      return select('PullRequestChangedFileConnection', {
        nodes: pagePaths.map((path) => ({ path })),
        pageInfo: { hasNextPage: paths.length > pagePaths.length, endCursor: pagePaths.length ? cursorFor(pagePaths.length - 1) : null },
      }, field, ctx);
    },
    repository: (s, field, ctx) => select('Repository', { repo: (s as PullSource).repo } satisfies RepoSource, field, ctx),
  },
  PullRequestChangedFileConnection: {
    nodes: (s, field, ctx) => (s as { nodes: Array<{ path: string }> }).nodes.map((n) => select('ChangedFile', n, field, ctx)),
    pageInfo: (s, field, ctx) => select('PageInfo', (s as { pageInfo: unknown }).pageInfo, field, ctx),
  },
  ChangedFile: { path: (s) => (s as { path: string }).path },
  Mutation: {
    createIssue: (_s, field, ctx) => {
      const args = argsOf(field, ctx.vars);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        return null;
      }
      const labels = Array.isArray(input.labelIds) ? [] : [];
      void labels;
      const issue: IssueRec = {
        id: ctx.store.newIssueId(),
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        seq: ctx.store.nextSeq(),
        closedSeq: null,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return select('CreateIssuePayload', { repo, issue } satisfies IssueSource, field, ctx);
    },
    closeIssue: (_s, field, ctx) => {
      const args = argsOf(field, ctx.vars);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(ctx.store, input.issueId);
      if (!found) {
        ctx.errors.push({ message: 'Issue not found' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.closedSeq = ctx.store.nextSeq();
      return select('CloseIssuePayload', found, field, ctx);
    },
    createPullRequest: (_s, field, ctx) => {
      const args = argsOf(field, ctx.vars);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        return null;
      }
      const pull: PullRec = {
        id: ctx.store.newIssueId(),
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        headRef: String(input.headRefName ?? ''),
        baseRef: String(input.baseRefName ?? repo.defaultBranch),
        seq: ctx.store.nextSeq(),
        merged: false,
        mergeCommitSha: null,
        mergedSeq: null,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return select('CreatePullRequestPayload', { repo, pull } satisfies PullSource, field, ctx);
    },
    mergePullRequest: (_s, field, ctx) => {
      const args = argsOf(field, ctx.vars);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullByGlobalId(ctx.store, input.pullRequestId);
      if (!found) {
        ctx.errors.push({ message: 'Pull request not found' });
        return null;
      }
      const sha = mergePull(found.repo, found.pull, 'squash');
      if (!sha) {
        ctx.errors.push({ message: 'Pull Request is not mergeable' });
        return null;
      }
      found.pull.merged = true;
      found.pull.state = 'closed';
      found.pull.mergeCommitSha = sha;
      found.pull.mergedSeq = ctx.store.nextSeq();
      return select('MergePullRequestPayload', found, field, ctx);
    },
    addComment: (_s, field, ctx) => {
      const args = argsOf(field, ctx.vars);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(ctx.store, input.subjectId);
      if (!found) {
        ctx.errors.push({ message: 'Subject not found' });
        return null;
      }
      const comment = { id: ctx.store.newCommentId(), body: String(input.body ?? ''), seq: ctx.store.nextSeq() };
      found.issue.comments.push(comment);
      return select('AddCommentPayload', { comment }, field, ctx);
    },
  },
  CreateIssuePayload: {
    issue: (s, field, ctx) => select('Issue', s, field, ctx),
  },
  CloseIssuePayload: {
    issue: (s, field, ctx) => select('Issue', s, field, ctx),
  },
  CreatePullRequestPayload: {
    pullRequest: (s, field, ctx) => select('PullRequest', s, field, ctx),
  },
  MergePullRequestPayload: {
    pullRequest: (s, field, ctx) => select('PullRequest', s, field, ctx),
  },
  AddCommentPayload: {
    commentEdge: (s, field, ctx) => select('CommentEdge', { node: (s as { comment: { id: number; body: string } }).comment }, field, ctx),
  },
  CommentEdge: {
    node: (s, field, ctx) => select('Comment', (s as { node: unknown }).node, field, ctx),
  },
  Comment: {
    id: (s) => globalId('IssueComment', String((s as { id: number }).id)),
    body: (s) => (s as { body: string }).body,
  },
};

// Helpers wired lazily to avoid a static import cycle with app.ts merge code.
import { threeWayMerge as twm } from './app.ts';
import { flattenTree, parseCommit } from './git.ts';

function filesOf(repo: RepoRec, commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
  if (!commitOid) return new Map();
  const obj = getObject(repo, peelToCommit(repo, commitOid));
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

const mergeability = {
  filesAtHead: true,
  threeWayMerge(repo: RepoRec, baseSha: string, headSha: string, _flag: boolean): boolean {
    const baseCommit = peelToCommit(repo, baseSha);
    const headCommit = peelToCommit(repo, headSha);
    const base0 = mergeBase(repo, baseCommit, headCommit);
    return twm(filesOf(repo, baseCommit), filesOf(repo, headCommit), base0 ? filesOf(repo, base0) : new Map()) !== null;
  },
};

// Keep the REST view helpers referenced so shared shapes stay consistent.
void repoJson;
void issueJson;
void pullJson;

// ---------------------------------------------------------------- HTTP

interface OperationBody {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function runOperation(store: Store, body: OperationBody): Record<string, unknown> {
  const query = String(body.query ?? '');
  const vars = (body.variables ?? {}) as Record<string, unknown>;
  let ops: Operation[];
  try {
    ops = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const op = body.operationName ? ops.find((o) => o.name === body.operationName) ?? ops[0] : ops[0];
  if (!op) return { data: null, errors: [{ message: 'No operation found' }] };
  const ctx: Ctx = { store, vars, errors: [] };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, null, op.selections, ctx);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length) out.errors = ctx.errors;
  return out;
}

export async function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  authed: boolean,
  readBody: (req: IncomingMessage) => Promise<Buffer>,
): Promise<void> {
  const send = (status: number, body: unknown): void => {
    const text = `${JSON.stringify(body)}\n`;
    store.requestCounter += 1;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': `FORGE-${store.requestCounter.toString(16).toUpperCase().padStart(6, '0')}`,
    });
    res.end(text);
  };
  if (!authed) {
    send(401, { message: 'Bad credentials' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    send(400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(parsed)) {
    send(200, parsed.map((op) => runOperation(store, (op ?? {}) as OperationBody)));
    return;
  }
  send(200, runOperation(store, (parsed ?? {}) as OperationBody));
}
