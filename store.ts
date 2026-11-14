// The forge's in-memory store: repositories, their git objects and refs, and the
// REST-level records (issues, pull requests, labels, comments) that share one
// numbering space per repository, exactly as GitHub numbers them.
//
// Determinism: nothing here reads the wall clock. A logical clock (a fixed epoch
// plus a sequence counter) stamps every created record, so the same sequence of
// requests always produces the same state.

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  closedSeq: number | null;
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  seq: number;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  seq: number;
}

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';

/** Fixed epoch for the logical clock: 2025-01-01T00:00:00Z, the scenario epoch. */
const EPOCH_SEC = 1_735_689_600;

export class Store {
  repos = new Map<string, RepoRec>();
  private repoIdCounter = 5000;
  private issueIdCounter = 1;
  private commentIdCounter = 1;
  private seqCounter = 0;
  private clockCounter = 0;
  requestCounter = 0;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Monotonic sequence number for creation ordering (never a clock). */
  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  /** ISO timestamp from the logical clock: fixed epoch + one second per stamp. */
  nowIso(): string {
    this.clockCounter += 1;
    return new Date((EPOCH_SEC + this.clockCounter) * 1000).toISOString();
  }

  /** Git author/committer timestamp line value from the logical clock. */
  nowGitStamp(): string {
    this.clockCounter += 1;
    return `${EPOCH_SEC + this.clockCounter} +0000`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
    const repo: RepoRec = {
      id: this.repoIdCounter,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      seq: this.nextSeq(),
    };
    this.repoIdCounter += 1;
    this.repos.set(Store.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.key(owner, name));
  }

  reposOf(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.seq - b.seq);
  }

  newIssueId(): number {
    const id = this.issueIdCounter;
    this.issueIdCounter += 1;
    return id;
  }

  newCommentId(): number {
    const id = this.commentIdCounter;
    this.commentIdCounter += 1;
    return id;
  }
}

/** Opaque, stable GraphQL global id for a typed record (never the plain decimal). */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id made by globalId; null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
