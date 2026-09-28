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
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

/**
 * このセッションで実機を動かしたか、を覚えておく場所。
 *
 * セッションごとに一つ。**別のセッションで動かしたことは、このセッションの証拠に
 * ならない。**入れ替えたコードを動かしたかどうかが問題で、機械がいつか動いた
 * ことではない。
 */
const MARKS = join(homedir(), '.iris', 'repeat-guard');

/**
 * 「実機を動かした」と言える形。
 *
 * `menubar/install.sh` は作って署名して開くところまでやる。`launchctl kickstart`
 * は常駐サーバを入れ替える。`open -a` は盤を開く。`curl 127.0.0.1:3002` は
 * 生きているサーバを叩く。`npm run day` は実際の予定で盤を出す。
 *
 * **`swiftc -typecheck` は数えない。**通ることは動くことではない —— それが
 * この記録そのもの。
 */
function looksLikeRealRun(command: string): boolean {
  if (/-typecheck\b/.test(command)) return false;
  return (
    /menubar\/install\.sh/.test(command) ||
    /launchctl\s+kickstart/.test(command) ||
    /\bopen\s+-a\b/.test(command) ||
    /127\.0\.0\.1:3002/.test(command) ||
    /\bnpm\s+run\s+day\b/.test(command) ||
    /\bxcodebuild\b/.test(command)
  );
}

function realRunSeen(sessionId: string | null): boolean | undefined {
  // セッションが分からなければ「分からない」。false と混ぜない。
  if (!sessionId) return undefined;
  try {
    const held = JSON.parse(readFileSync(join(MARKS, `${sessionId}.json`), 'utf8'));
    return held?.realRun === true;
  } catch {
    return false;
  }
}

function markRealRun(sessionId: string | null): void {
  if (!sessionId) return;
  try {
    mkdirSync(MARKS, { recursive: true });
    writeFileSync(join(MARKS, `${sessionId}.json`), JSON.stringify({ realRun: true, at: new Date().toISOString() }));
  } catch {
    // 覚えられなくても命令は止めない。次の判定は「動かしていない」に寄るが、
    // その方が安全側。
  }
}

/**
 * コミットに乗る変更。
 *
 * 追加した分（`--cached`）と、していない分の両方。`git commit -a` があるので、
 * **上げてある分だけを見ると足りない。**
 */
function changedPaths(cwd: string | undefined): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 3000,
    });
    return out
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  const raw = await new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
  });

  let command: string | undefined;
  let sessionId: string | null = null;
  let cwd: string | undefined;
  try {
    const input = JSON.parse(raw || '{}');
    if (input?.tool_name && input.tool_name !== 'Bash') out({});
    command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : undefined;
    sessionId = typeof input?.session_id === 'string' ? input.session_id : null;
    cwd = typeof input?.cwd === 'string' ? input.cwd : undefined;
  } catch {
    // 入力が読めないなら何も言わない。hook が命令を止める理由にはならない。
    out({});
  }
  if (!command) out({});

  /*
   * 実機を動かす命令なら、先に印を付けて通す。**これから走るものを証拠として
   * 数える**のは、この hook が走った直後にその命令が走るから。止めないと決めた
   * 命令の結果を待つ口は無い。
   */
  if (looksLikeRealRun(command)) {
    markRealRun(sessionId);
    out({});
  }

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

  /*
   * コミットのときだけ git に聞く。**毎回聞くと、全部の命令が git 一回ぶん遅くなる。**
   */
  const committing = /\bgit\s+(commit|push)\b/.test(command);
  const hits = guardAgainstRepeats(
    {
      command,
      changedPaths: committing ? changedPaths(cwd) : undefined,
      realRunSeen: committing ? realRunSeen(sessionId) : undefined,
    },
    recurring
  );
  if (!hits.length) {
    /*
     * 通したことは言わない。**毎回出る欄は読み飛ばされる**（`demoted` を毎回
     * 出さないのと同じ理由）。覆えていない記録は `coverage` を呼んだ人に返る。
     */
    out({});
  }

  const cover = coverage(recurring);
  /*
   * 実機の話だけは、**どうすれば通るか**を書く。「実機で回す」は方針であって
   * 手順ではないので、この機械での形を並べる —— 止めた場所で全部言う。
   */
  const realRun = hits.some((h) => h.attempt.includes('ユニットテスト'))
    ? '\n\n実機で確かめる形（どれか一つで印が付きます）:\n' +
      '  menubar/install.sh        —— 盤を作って署名して開く\n' +
      '  launchctl kickstart -k gui/501/com.user.iris —— 常駐サーバを入れ替える\n' +
      '  curl http://127.0.0.1:3002/api/…  —— 生きているサーバを叩く\n' +
      '  npm run day               —— 実際の予定で盤を出す'
    : '';
  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `この形は前に失敗しています。\n\n${explainHits(hits)}${realRun}\n\n` +
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
