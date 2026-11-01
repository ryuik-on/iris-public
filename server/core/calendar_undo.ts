import fs from 'fs';
import path from 'path';

/**
 * 予定を消す・直す前の控え。**元に戻す手がかりが無いまま、消さない。**
 *
 * これまで予定の削除は、人が id を指定して確認し、控え（`.iris/schedule/undo/*.json`）を
 * 置いてから行っていた。IRIS にも削除と編集を渡す（利用者、2026-10-03）ので、**同じ控えを
 * 道具の側が必ず置く**。控えが書けなかったら、変更しない。
 */
export interface UndoEvent {
  id: string; title: string; start: string | null; end: string | null; location: string | null; allDay?: boolean;
}

export function writeUndo(dir: string, input: {
  kind: 'delete' | 'edit'; calendarId: string; reason: string; before: UndoEvent[]; after?: Array<Record<string, unknown>>; /** 元に戻すための、元のファイルの中身など（iCloud）。 */ extra?: Record<string, unknown>; now?: Date;
}): string {
  if (!input.before.length) throw new Error('控える予定がありません。');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `iris-${input.kind}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ calendarId: input.calendarId, reason: input.reason, kind: input.kind, events: input.before, after: input.after ?? null, ...(input.extra ? { extra: input.extra } : {}) }, null, 1), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  return file;
}
