#!/usr/bin/env -S npx tsx
/**
 * Claude Code の PreToolUse から呼ばれて、記録された失敗を繰り返す前に止める。
 *
 * 置き場所が要点。読む口は前からあった（`GET /api/experiences?recurring=true`、
 * MCP の `attempts`）のに、2026-09-28 のセッションは `npm test | grep` で
 * スイートの合否を判定した —— **記録された失敗そのもの**で、出力を読み違えて
 * 「190 failed」と数えた。**思い出す口があることと、思い出すことは別。**
 *
 * だからセッションに尋ねさせない。命令が走る**手前**に立つ。
 *
 * 登録（利用者スコープ、~/.claude/settings.json）:
 *
 *   "hooks": { "PreToolUse": [{ "matcher": "Bash",
 *     "hooks": [{ "type": "command",
 *                 "command": "npx tsx <このリポジトリ>/scripts/repeat-guard.ts" }] }] }
 *
 * 入出力は Claude Code の hook の約束どおり。stdin に JSON、標準出力に JSON。
 * `permissionDecision: "deny"` で命令が走らず、`permissionDecisionReason` が
 * セッションに返る —— そこに記録の文言と直し方を入れる。
 *
 * **IRIS に届かないときは通す。**止める権限は記録から来ていて、記録が読めない
 * ときに止めるのは、根拠のない禁止になる。ただし黙って通さない: 確かめられな
 * かったことを `systemMessage` で言う。
 */
import { guardAgainstRepeats, coverage, explainHits, RecordedFailure } from '../server/core/repeat_guard.js';

const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:3002';
/**
 * 短く。hook は命令の手前に立つので、ここで待たせると全部が遅くなる。
 *
 * 1.5秒では足りなかった（実測 2026-09-28、サーバを入れ替えた直後の三回が全部
 * 時間切れ。温まっていれば同じ問い合わせは 1〜30ms）。**起動中に黙って通す**
 * ことになるので、起動の分だけ余裕を持たせる。
 */
const TIMEOUT_MS = 3000;

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
}

async function main() {
  const raw = await new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
  });

  let command: string | undefined;
  try {
    const input = JSON.parse(raw || '{}');
    if (input?.tool_name && input.tool_name !== 'Bash') out({});
    command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : undefined;
  } catch {
    // 入力が読めないなら何も言わない。hook が命令を止める理由にはならない。
    out({});
  }
  if (!command) out({});

  let recurring: RecordedFailure[];
  try {
    const res = await fetch(`${BASE}/api/experiences?recurring=true`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: any = await res.json();
    recurring = (body?.experiences ?? []).map((e: any) => ({
      attempt: String(e.attempt ?? ''),
      learned: String(e.learned ?? ''),
      observations: Number(e.observations ?? 0),
    }));
  } catch (err) {
    out({
      systemMessage:
        `繰り返しの検査ができませんでした（IRIS に届かない: ${err instanceof Error ? err.message : String(err)}）。` +
        '記録された失敗と照合せずに進みます。',
    });
    return;
  }

  const hits = guardAgainstRepeats({ command }, recurring);
  if (!hits.length) {
    /*
     * 通したことは言わない。**毎回出る欄は読み飛ばされる**（`demoted` を毎回
     * 出さないのと同じ理由）。覆えていない記録は `coverage` を呼んだ人に返る。
     */
    out({});
  }

  const cover = coverage(recurring);
  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `この形は前に失敗しています。\n\n${explainHits(hits)}\n\n` +
        `（IRIS の記録より。止められるのは ${cover.covered.length} 件で、` +
        `${cover.uncovered.length} 件は覚えているが止められません。`
        + 'この禁止が間違っているなら、記録の方を直してください: POST /api/experiences）',
    },
  });
}

main().catch(() => {
  // hook が落ちて作業を止めるのが、いちばん悪い。
  process.stdout.write('{}');
  process.exit(0);
});
