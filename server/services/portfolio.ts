import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  readTable,
  plain,
  identifier,
  taskStatus,
  summarise,
  TaskStatus,
  Progress,
} from '../core/ledger_parse.js';

/**
 * What the MED-AI Builder Lab ledger says, read fresh on every request.
 *
 * IRIS reads this and never writes it. The ledger's own operating rules make
 * its Markdown the single authority for Projects, Decisions and approved
 * specifications, and say plainly that chat is not settled specification until
 * it reaches them. Caching state here would make IRIS a second authority that
 * disagrees quietly whenever someone edits a file; nothing is stored, so
 * disagreement is impossible by construction.
 *
 * The one rule the rest of this file exists to serve: **unreadable is not
 * empty**. A ledger that has moved, or a table that has been renamed, must
 * never come back as "no projects" — that is a quiet week, and a quiet week is
 * indistinguishable from a broken reader. Every failure is named.
 */

/** Where the ledger lives. Dated directory, so it is expected to move. */
export function ledgerRoot(env = process.env, home = process.env.HOME ?? ''): string {
  const configured = env.IRIS_LEDGER_ROOT?.trim();
  if (configured) return configured;
  return join(
    home,
    'Documents/Codex/2026-07-27/med-ai-builder-lab-repository-manager/MED-AI Builder Lab'
  );
}

export interface LedgerTask {
  id: string | null;
  projectId: string | null;
  title: string;
  owner: string;
  status: TaskStatus;
  dependsOn: string[];
  /** For a Blocked task this is the release condition, and it is the point. */
  notes: string;
  updated: string;
}

export interface LedgerProject {
  id: string | null;
  name: string;
  lab: string;
  status: string;
  priority: string;
  updated: string;
  notes: string;
  progress: Progress;
  tasks: LedgerTask[];
}

export interface WatchedRepo {
  path: string;
  name: string;
  lastCommit: string | null;
  /** Whether the ledger records this path anywhere. */
  registered: boolean;
}

export type PortfolioRead =
  | {
      ok: true;
      source: string;
      projects: LedgerProject[];
      labs: Array<Record<string, string>>;
      backlog: Array<Record<string, string>>;
      decisions: number;
      repos: WatchedRepo[];
      /** Anything read that did not fit the shape. Never silently dropped. */
      warnings: string[];
    }
  | { ok: false; source: string; reason: string };

/** The files this depends on, so a missing one can be named rather than guessed at. */
const FILES = {
  projects: '00_OS/Active_Projects.md',
  labs: '00_OS/Lab_Registry.md',
  decisions: '00_OS/Decision_Log.md',
  architecture: '03_Engineering/Architecture.md',
  backlog: '02_Product/Feature_Backlog.md',
};

export class PortfolioService {
  constructor(
    private root: string,
    /** Repositories to check against the ledger. Absolute, resolved paths. */
    private watched: string[] = []
  ) {}

  read(): PortfolioRead {
    if (!existsSync(this.root)) {
      return {
        ok: false,
        source: this.root,
        reason:
          '台帳が見つかりません。日付つきのディレクトリにあるため、移動した可能性があります。' +
          'IRIS_LEDGER_ROOT で場所を指定できます。',
      };
    }

    const read = (relative: string): string | null => {
      const path = join(this.root, relative);
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return null;
      }
    };

    const projectsDoc = read(FILES.projects);
    if (projectsDoc === null) {
      return { ok: false, source: this.root, reason: `${FILES.projects} を読めません。` };
    }

    const warnings: string[] = [];

    const projectTable = readTable(projectsDoc, 'Project 一覧');
    const taskTable = readTable(projectsDoc, 'Task 一覧');

    /**
     * A heading that produced no table is reported, not accepted.
     *
     * This is the failure this whole file is shaped around: if the ledger
     * renames "Task 一覧", the tasks vanish and every project shows 0 of 0 —
     * which renders as a finished project rather than as a broken reader.
     */
    if (projectTable.rows.length === 0) warnings.push('「Project 一覧」の表を読めませんでした。');
    if (taskTable.rows.length === 0) warnings.push('「Task 一覧」の表を読めませんでした。');
    if (projectTable.malformed > 0) {
      warnings.push(`Project 一覧に列数の合わない行が ${projectTable.malformed} 件あります。`);
    }
    if (taskTable.malformed > 0) {
      warnings.push(`Task 一覧に列数の合わない行が ${taskTable.malformed} 件あります。`);
    }

    const tasks: LedgerTask[] = taskTable.rows.map((row) => ({
      id: identifier(row['Task ID']),
      projectId: identifier(row['Project ID']),
      title: plain(row['Task']),
      owner: plain(row['Owner']),
      status: taskStatus(row['Status']),
      dependsOn: plain(row['Depends On'])
        .split(/[,、]/)
        .map((part) => identifier(part.trim()))
        .filter((id): id is string => id !== null),
      notes: plain(row['Notes / Blocker'] ?? row['Notes']),
      updated: plain(row['Updated']),
    }));

    const unreadableStatus = tasks.filter((t) => t.status === 'Unknown').length;
    if (unreadableStatus > 0) {
      warnings.push(
        `状態を読めない Task が ${unreadableStatus} 件あります（Todo / In Progress / Blocked / Done 以外）。`
      );
    }

    const projects: LedgerProject[] = projectTable.rows.map((row) => {
      const id = identifier(row['Project ID']);
      const mine = tasks.filter((t) => t.projectId === id);
      return {
        id,
        name: plain(row['Project Name']),
        lab: plain(row['Lab ID']),
        status: plain(row['Status']),
        priority: plain(row['Priority']),
        updated: plain(row['Updated']),
        notes: plain(row['Notes']),
        progress: summarise(mine.map((t) => t.status)),
        tasks: mine,
      };
    });

    /**
     * Tasks whose project is not in the project table.
     *
     * They would otherwise be counted nowhere and disappear from every total,
     * which is the same shape of loss as a table that failed to parse.
     */
    const known = new Set(projects.map((p) => p.id));
    const orphans = tasks.filter((t) => !known.has(t.projectId));
    if (orphans.length > 0) {
      warnings.push(
        `どの Project にも属さない Task が ${orphans.length} 件あります（${orphans
          .map((t) => t.id ?? '?')
          .join(', ')}）。`
      );
    }

    const labsDoc = read(FILES.labs);
    const labs = labsDoc ? readTable(labsDoc, 'Lab 一覧').rows : [];
    if (labsDoc === null) warnings.push(`${FILES.labs} を読めません。`);
    /**
     * An empty table from a file that is present is a reader problem, not an
     * empty registry — and it had no warning until it happened. The first run
     * against the real ledger reported "Labs: 0" in silence, because the
     * heading was matched as "Lab" and the document's own title line contains
     * that word. Nothing about the output said so. Every expected table now
     * says when it came back empty.
     */
    else if (labs.length === 0) warnings.push('「Lab 一覧」の表を読めませんでした。');

    const backlogDoc = read(FILES.backlog);
    const backlog = backlogDoc ? readTable(backlogDoc, null).rows : [];

    const decisionsDoc = read(FILES.decisions);
    const decisions = decisionsDoc ? (decisionsDoc.match(/^#{2,4} DEC-\d+/gm) ?? []).length : 0;
    if (decisionsDoc === null) warnings.push(`${FILES.decisions} を読めません。`);
    else if (decisions === 0) warnings.push('Decision Log から DEC- の見出しを読めませんでした。');

    if (backlogDoc === null) warnings.push(`${FILES.backlog} を読めません。`);

    /**
     * Which watched repositories the ledger actually names.
     *
     * Matched on absolute path, because that is what the ledger records —
     * `Architecture.md` registers a Canonical Local Working Copy and an Active
     * Development Repository by full path. Matching on directory name would be
     * unreliable in the direction that matters: these directories are named
     * after the conversation that created them, not after the product.
     */
    const haystack = [projectsDoc, labsDoc, decisionsDoc, read(FILES.architecture), backlogDoc]
      .filter((doc): doc is string => doc !== null)
      .join('\n');

    const repos: WatchedRepo[] = this.watched.map((path) => ({
      path,
      name: path.split('/').pop() ?? path,
      lastCommit: lastCommitDate(path),
      registered: haystack.includes(path),
    }));

    return {
      ok: true,
      source: this.root,
      projects,
      labs,
      backlog,
      decisions,
      repos,
      warnings,
    };
  }
}

/** The last commit date, or null when it cannot be read. Never a stand-in date. */
function lastCommitDate(repo: string): string | null {
  try {
    if (!existsSync(join(repo, '.git'))) return null;
    return execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cd', '--date=short'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Repositories under a directory, one level deep, that are git working copies. */
export function repositoriesUnder(root: string, depth = 2): string[] {
  const found: string[] = [];
  const walk = (dir: string, level: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const path = join(dir, name);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(path, '.git'))) {
        found.push(path);
        continue;
      }
      if (level < depth) walk(path, level + 1);
    }
  };
  walk(root, 0);
  return found;
}
