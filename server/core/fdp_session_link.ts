import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * どの課題を、どのセッションが進めているか。
 *
 * 課題は作業場所（`findWorkplace`）を持ち、セッションは `cwd` を持つ。
 * **cwd が作業場所の中にあるセッション**が、その課題のセッション。
 * 「場所」を押したとき、Finder ではなく**そのセッションを前に出す**ための
 * 紐付け（利用者、2026-09-11「いるよ」）。
 *
 * 道は実体で比べる。この機械では `~/Downloads/iris` が `~/Projects/iris` への
 * シンボリックリンクで、文字で比べると同じ場所が別に見える。
 *
 * 二段で拾う。`inside` は cwd が作業場所の中。`enclosing` は cwd が作業場所の
 * **上**にあるが、そのプロジェクトの根（`.git` / `CLAUDE.md` / `AGENTS.md` /
 * `package.json` のある階層）より下。T011 の論点表は `medrecall/docs/` にあり、
 * それを書いた Codex は `medrecall/` にいた —— 中だけ見ると落ちる（実測
 * 2026-09-11）。根より上（`~/Documents`）は拾わない。そこにいるセッションは
 * 何にでも紐付いてしまい、紐付けの意味が無い。
 *
 * 一つの課題に複数のセッションが居ることはある（昨日の続きと今日の新規）。
 * 中にいるものを先に、生きているものを先に、そのあと最近書かれた順。
 * **選ぶのは呼び出し側。**
 */
export interface LinkableSession {
  id: string;
  name: string | null;
  live: boolean;
  resume: string;
  cwd: string | null;
  lastAt: string;
  doingNow?: string | null;
  kind: 'claude' | 'codex';
}

export type LinkedSession = LinkableSession & { scope: 'inside' | 'enclosing' };

export function sessionsFor(
  workplace: { path: string; kind: 'folder' | 'file' } | null,
  sessions: LinkableSession[]
): LinkedSession[] {
  if (!workplace) return [];
  const place = canonical(workplace.kind === 'file' ? dirname(workplace.path) : workplace.path);
  if (!place) return [];
  const projectRoot = nearestProjectRoot(place);
  const hits: LinkedSession[] = [];
  for (const s of sessions) {
    if (!s.cwd) continue;
    const cwd = canonical(s.cwd);
    if (cwd === null) continue;
    if (cwd === place || cwd.startsWith(place + sep)) {
      hits.push({ ...s, scope: 'inside' });
    } else if (place.startsWith(cwd + sep) && cwd.length >= projectRoot.length) {
      hits.push({ ...s, scope: 'enclosing' });
    }
  }
  return hits.sort(
    (a, b) =>
      Number(a.scope === 'enclosing') - Number(b.scope === 'enclosing') ||
      Number(b.live) - Number(a.live) ||
      b.lastAt.localeCompare(a.lastAt)
  );
}

const ROOT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md', 'package.json'];

/** その場所を含む、いちばん近いプロジェクトの根。無ければその場所自身。 */
function nearestProjectRoot(place: string): string {
  let dir = place;
  for (;;) {
    if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const up = dirname(dir);
    if (up === dir) return place;
    dir = up;
  }
}

/** 実体の道。無ければ null —— 消えた資料入れのセッションは、どこにも紐付かない。 */
function canonical(p: string): string | null {
  try {
    const real = realpathSync(resolve(p));
    statSync(real);
    return real;
  } catch {
    return null;
  }
}
