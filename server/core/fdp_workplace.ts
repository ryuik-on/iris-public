import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * その課題を、どこで進めるか。
 *
 * 「タスクだけど、それぞれどこで進めていけばわからない」（利用者、
 * 2026-09-11）。台帳の「次の行動」には `ml-bridge-plan/week0-numpy.md` の
 * ような道が文の中に埋まっているだけで、**それが `~/Documents/
 * Founder-Development-Program/` の下だとはどこにも書いていない。**
 *
 * ここでは**実在する道だけ**を返す。決め方は二段で、どちらで決めたかを
 * `basis` で言う。
 *
 *   1. 番号の名を持つ資料入れ —— `t007-*` のような。台帳の慣習で、
 *      T003・T004・T005・T007・T008 がこれ。
 *   2. 文の中の道 —— 「次の行動」「完了条件」に書かれた道のうち、根の
 *      どれかの下に実在するもの。T006 は `ml-bridge-plan/…`、T011 は
 *      別の場所（Codex の medrecall）にある台帳を指すので、根は一つでは
 *      足りない。
 *
 * 見つからなければ `null`。**手続き系（T009・T010）には作業場所が無い**
 * のが本当で、それを無理に何かに結び付けない。
 */
export interface Workplace {
  /** 絶対パス。 */
  path: string;
  kind: 'folder' | 'file';
  basis: 'folder-by-id' | 'path-in-text';
}

export interface WorkplaceInput {
  id: string;
  nextAction?: string | null;
  doneCriteria?: string | null;
}

export function findWorkplace(task: WorkplaceInput, roots: string[]): Workplace | null {
  const id = task.id.trim().toLowerCase();
  if (!id) return null;

  for (const root of roots) {
    const hit = folderByPrefix(root, `${id}-`);
    if (hit) return { path: hit, kind: 'folder', basis: 'folder-by-id' };
  }

  const text = [task.nextAction, task.doneCriteria].filter(Boolean).join(' ');
  // 拡張子を持つ道と、`名前/` の形の資料入れ。全角の括弧や句読点で切る。
  const candidates = text.match(/[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:md|csv|py|ipynb|json|txt)|[a-z0-9]+(?:-[a-z0-9]+)+\/?/g) ?? [];
  for (const raw of candidates) {
    const rel = raw.replace(/\/$/, '');
    for (const root of roots) {
      const full = join(root, rel);
      if (!existsSync(full)) continue;
      // 台帳名などで根の外へ出るものは受けない。
      if (!full.startsWith(root)) continue;
      return { path: full, kind: statSync(full).isDirectory() ? 'folder' : 'file', basis: 'path-in-text' };
    }
  }
  return null;
}

function folderByPrefix(root: string, prefix: string): string | null {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  const hit = names.find((n) => n.toLowerCase().startsWith(prefix));
  if (!hit) return null;
  const full = join(root, hit);
  try {
    return statSync(full).isDirectory() ? full : null;
  } catch {
    return null;
  }
}
