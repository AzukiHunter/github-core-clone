// The MCP endpoint: streamable HTTP JSON-RPC with both protocol eras the
// suite speaks — modern server/discover (2026-07-28) and legacy initialize
// (2025-11-25 down to 2024-11-05). Six tools mirror the REST surface, and every
// effect lands in the same store the REST view reads. Auth is decided before
// any tool dispatch: no bearer token is HTTP 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN, type RepoRec } from './store.ts';
import { issueJson, mergePull, pullJson, repoJson } from './app.ts';
import type { IssueRec, PullRec } from './store.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

function needString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new Error(`missing required argument: ${key}`);
  return v;
}

function repoOf(store: Store, args: Record<string, unknown>): RepoRec {
  const owner = needString(args, 'owner');
  const name = needString(args, 'repo');
  const repo = store.getRepo(owner, name);
  if (!repo) throw new Error(`repository not found: ${owner}/${name}`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the given owner.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
    run: (store, args) => {
      const name = needString(args, 'name');
      const owner = typeof args.owner === 'string' && args.owner ? args.owner : VIEWER_LOGIN;
      if (store.getRepo(owner, name)) throw new Error('name already exists on this account');
      const repo = store.createRepo(owner, name, String(args.description ?? ''), Boolean(args.private ?? false));
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
    run: (store, args) => repoJson(repoOf(store, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const issue: IssueRec = {
        id: store.newIssueId(),
        number: repo.nextNumber,
        title: needString(args, 'title'),
        body: String(args.body ?? ''),
        state: 'open',
        labels: [],
        seq: store.nextSeq(),
        closedSeq: null,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()].sort((a, b) => b.seq - a.seq);
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      return list.map((i) => issueJson(repo, i));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const head = needString(args, 'head');
      const base = needString(args, 'base');
      if (!repo.refs.has(`refs/heads/${head}`)) throw new Error(`head branch not found: ${head}`);
      if (!repo.refs.has(`refs/heads/${base}`)) throw new Error(`base branch not found: ${base}`);
      const pull: PullRec = {
        id: store.newIssueId(),
        number: repo.nextNumber,
        title: needString(args, 'title'),
        body: String(args.body ?? ''),
        state: 'open',
        headRef: head,
        baseRef: base,
        seq: store.nextSeq(),
        merged: false,
        mergeCommitSha: null,
        mergedSeq: null,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, args) => {
      const repo = repoOf(store, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) throw new Error(`pull request not found: ${String(args.pull_number)}`);
      if (pull.merged) throw new Error('pull request is already merged');
      const sha = mergePull(repo, pull, 'squash');
      if (!sha) throw new Error('pull request is not mergeable');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = sha;
      pull.mergedSeq = store.nextSeq();
      return pullJson(repo, pull);
    },
  },
];

/** The tools/list payload: a constant, byte-identical across calls. */
const TOOLS_LIST = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function error(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  authed: boolean,
  readBody: (req: IncomingMessage) => Promise<Buffer>,
): Promise<void> {
  const send = (status: number, body: unknown): void => {
    const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
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
    send(400, error(null, -32700, 'Parse error'));
    return;
  }
  const rpc = (parsed ?? {}) as JsonRpcRequest;
  const method = String(rpc.method ?? '');
  const id = rpc.id;

  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }

  switch (method) {
    case 'server/discover':
      send(200, result(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      }));
      return;
    case 'initialize': {
      const params = (rpc.params ?? {}) as Record<string, unknown>;
      const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      send(200, result(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }));
      return;
    }
    case 'ping':
      send(200, result(id, {}));
      return;
    case 'tools/list':
      send(200, result(id, { tools: TOOLS_LIST }));
      return;
    case 'tools/call': {
      const params = (rpc.params ?? {}) as Record<string, unknown>;
      const toolName = String(params.name ?? '');
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        send(200, error(id, -32602, `unknown tool: ${toolName}`));
        return;
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = (tool.inputSchema.required as string[]).filter((k) => args[k] === undefined || args[k] === '');
      if (missing.length) {
        send(200, error(id, -32602, `missing required arguments: ${missing.join(', ')}`));
        return;
      }
      try {
        const value = tool.run(store, args);
        send(200, result(id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        }));
      } catch (err) {
        send(200, result(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : 'tool error' }],
          isError: true,
        }));
      }
      return;
    }
    default:
      send(200, error(id, -32601, `method not found: ${method}`));
      return;
  }
}
