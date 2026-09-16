/**
 * Reading the coding assistants' own files.
 *
 * These formats belong to other programs and are not a contract — Codex writes
 * its rate limits into a session rollout because that is convenient for Codex,
 * and it can stop doing so in any release. So the assertions that matter here
 * are the ones about not answering when the answer is not there: a parser that
 * returns zero when the shape changed reports a quiet week forever, which is
 * worse than reporting nothing.
 *
 * Run: npx tsx scripts/test-cli-usage.ts
 */
import { parseCodexLimit, withinCurrentWindow, readCodexLimit } from '../server/services/cli_usage.js';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) {
  console.log(`\n▸ ${name}`);
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
    console.log(`  ✗ ${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
  }
}

/** A rollout line in the shape Codex actually writes, taken from a real file. */
function rollout(usedPercent: number, at: string, resetsAt = 1785233995) {
  return JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 12345 } },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAt },
        secondary: null,
        plan_type: 'plus',
      },
    },
  });
}

function main() {
  section('The last reading in a rollout is the current one');

  {
    const text = [rollout(11, '2026-08-20T09:00:00.000Z'), rollout(42, '2026-08-20T11:01:56.507Z')].join('\n');
    const found = parseCodexLimit(text, 'fixture');
    eq('takes the last, not the first', found?.usedPercent, 42);
    eq('reads the plan', found?.planType, 'plus');
    eq('reads the window', found?.windowMinutes, 10080);

    // Epoch seconds in the file, milliseconds everywhere in this codebase.
    eq('converts the reset to milliseconds', found?.resetsAtMs, 1785233995000);
    eq('carries when Codex wrote it', found?.recordedAtMs, Date.parse('2026-08-20T11:01:56.507Z'));
  }

  section('A tail begins mid-line, and that is normal');

  {
    // Reading the end of a large file almost always cuts the first line in
    // half. That fragment is not the end of the search.
    const text = ['{"timestamp":"2026-08-2', rollout(7, '2026-08-20T11:00:00.000Z')].join('\n');
    eq('skips the fragment and finds the record', parseCodexLimit(text)?.usedPercent, 7);

  }

  section('A reading from a window that has already reset');
  {
    /**
     * A rollout keeps every rate-limit line a session ever received, and a
     * long-lived session's file goes on being appended for days — so the last
     * such line in the newest file is not necessarily from the current week.
     *
     * Measured 2026-08-23: the figure served as "this week" was 82%, while
     * the records carrying 82–86% are stamped 2026-08-22T20:29Z, before the
     * window that began 2026-08-23T03:53Z. Last week's exhaustion was being
     * read as this week's — and with SPENT_PERCENT at 90 that is one bad
     * reading away from routing every dispatch off an agent 41% used.
     */
    const week = 10080;
    const resets = Date.parse('2026-08-30T03:53:00Z');
    const base = { planType: 'plus', usedPercent: 86, windowMinutes: week, resetsAtMs: resets, source: 'f' };

    eq('a record from before this window is refused', !withinCurrentWindow({ ...base, recordedAtMs: Date.parse('2026-08-22T20:29:00Z') } as any), true);
    eq('and one from inside it stands', withinCurrentWindow({ ...base, recordedAtMs: Date.parse('2026-08-23T19:39:00Z') } as any), true);
    eq('the boundary itself counts as inside', withinCurrentWindow({ ...base, recordedAtMs: resets - week * 60_000 } as any), true);
    /**
     * Unverifiable is not the same as wrong. Without a reset time or a window
     * there is nothing to check against, and discarding the reading would
     * report "no data" for a figure that may be perfectly current.
     */
    eq('no reset time means no judgement', withinCurrentWindow({ ...base, resetsAtMs: null, recordedAtMs: 0 } as any), true);
    eq('and no timestamp means the same', withinCurrentWindow({ ...base, recordedAtMs: null } as any), true);
  }

  section('Which of the two windows is the week');
  {
    /**
     * Codex reports two windows and which one is `primary` is not fixed.
     * Measured 2026-08-28: primary was five hours at 4% while secondary was
     * the week at 16%. Reading `primary` meant the figure shown as 「今週」,
     * used to route delegations and to refuse unattended runs, was the
     * five-hour meter — which resets five times a day, and which is why the
     * same day read 100% in the afternoon and 6% in the evening.
     */
    const both = (primaryWindow: number, primaryPct: number, secondaryWindow: number, secondaryPct: number) =>
      JSON.stringify({
        timestamp: '2026-08-28T05:01:37.310Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: primaryPct, window_minutes: primaryWindow, resets_at: 1787908230 },
            secondary: { used_percent: secondaryPct, window_minutes: secondaryWindow, resets_at: 1788452825 },
            plan_type: 'plus',
          },
        },
      });

    eq('the week is taken from secondary when that is where it is', parseCodexLimit(both(300, 4, 10080, 16))?.usedPercent, 16);
    eq('and from primary when it is there instead', parseCodexLimit(both(10080, 16, 300, 4))?.usedPercent, 16);
    eq('the window travels with it', parseCodexLimit(both(300, 4, 10080, 16))?.windowMinutes, 10080);
    // A five-hour figure is not a worse answer to the weekly question; it is
    // an answer to a different one. Reporting nothing is the honest result.
    eq('no weekly window means no reading', parseCodexLimit(both(300, 4, 60, 2)), null);
  }

  section('The newest reading, not the newest file');
  {
    /**
     * A long-lived session keeps its rollout open and touches it for other
     * reasons, so a file can be the most recently written while the last
     * rate-limit line inside it is hours old. Reported 2026-08-27 by another
     * session: IRIS said Codex was at 0% while Codex was running normally.
     */
    const older = rollout(0, '2026-08-27T01:00:00.000Z');
    const newer = rollout(41, '2026-08-27T14:00:00.000Z');
    eq('a lone reading is taken as it is', parseCodexLimit(older)?.usedPercent, 0);
    eq('and so is the other', parseCodexLimit(newer)?.usedPercent, 41);
    // Within one file the last line still wins — that part was already right.
    eq('the last line of a file wins', parseCodexLimit([older, newer].join('\n'))?.usedPercent, 41);
    eq(
      'and the timestamp travels with it, so files can be compared',
      parseCodexLimit(newer)?.recordedAtMs,
      Date.parse('2026-08-27T14:00:00.000Z')
    );
  }

  section('Nothing is not zero');

  {
    eq('empty text has no answer', parseCodexLimit(''), null);
    eq('unrelated lines have no answer', parseCodexLimit('{"type":"message"}\n{"a":1}'), null);

    // The shape this depends on can change without warning. When it does, the
    // right answer is "cannot read" — a zero here would show a fresh weekly
    // allowance every time and nobody would notice until they hit the limit.
    const renamed = JSON.stringify({
      timestamp: '2026-08-20T11:00:00.000Z',
      payload: { rate_limits: { primary: { pct_used: 42, window_minutes: 10080 } } },
    });
    eq('a renamed field is unreadable, not empty', parseCodexLimit(renamed), null);

    const noPrimary = JSON.stringify({
      timestamp: '2026-08-20T11:00:00.000Z',
      payload: { rate_limits: { primary: null, secondary: null } },
    });
    eq('missing primary is unreadable', parseCodexLimit(noPrimary), null);

    const wrongType = JSON.stringify({
      timestamp: '2026-08-20T11:00:00.000Z',
      payload: { rate_limits: { primary: { used_percent: '42' } } },
    });
    eq('a percentage as a string is unreadable', parseCodexLimit(wrongType), null);
  }

  section('Malformed input never throws');

  {
    // This runs behind an endpoint. A parse failure has to be an answer, not
    // an exception that takes the panel with it.
    let threw = false;
    try {
      parseCodexLimit('{{{ not json\n\n]]]rate_limits[[[\n');
    } catch {
      threw = true;
    }
    eq('garbage returns rather than throws', threw, false);

    let threw2 = false;
    let result: unknown = 'unset';
    try {
      result = parseCodexLimit('rate_limits');
    } catch {
      threw2 = true;
    }
    eq('a bare keyword does not throw', threw2, false);
    eq('and has no answer', result, null);
  }

  section('The reading carries its own age');

  {
    // The percentage is only as current as the last time Codex ran. A caller
    // that cannot tell a figure from an hour ago from one from last week will
    // present a stale number as the truth, so this must always come back.
    const found = parseCodexLimit(rollout(63, '2026-08-14T02:30:00.000Z'));
    eq('recorded time survives', found?.recordedAtMs, Date.parse('2026-08-14T02:30:00.000Z'));

    const undated = JSON.stringify({
      payload: { rate_limits: { primary: { used_percent: 5, window_minutes: 10080 } } },
    });
    eq('an undated record admits it', parseCodexLimit(undated)?.recordedAtMs, null);
    eq('but still reports the figure', parseCodexLimit(undated)?.usedPercent, 5);
  }

  section('形の違う記録が混ざっても、混ぜて答えない');
  {
    /*
     * 2026-09-07 に実際に起きたこと。同じ `~/.codex/sessions` に、5時間と週の
     * 両方を書く実行系（Codex Desktop / plus）と、週だけを書く実行系
     * （codex_exec / prolite）が交互に記録していた。「最新の読み」だけで
     * 決めていたので、レールの週が 68% と 2% の間を行き来した。
     *
     * **空欄より悪い。**5時間が消えるのは目に見えるが、週が別の契約の数字に
     * 化けるのは、正しい数字と見分けが付かない。
     */
    const home = mkdtempSync(join(tmpdir(), 'codex-mix-'));
    const dir = join(home, '.codex', 'sessions', '2026', '09', '07');
    mkdirSync(dir, { recursive: true });

    const line = (at: string, originator: string, rl: any) =>
      [
        JSON.stringify({ timestamp: at, type: 'session_meta', payload: { originator } }),
        JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } }),
      ].join('\n');

    /*
     * 記録の時刻も、いまから測る。
     *
     * 固定の日付（'2026-09-07T10:42:37Z'）と、いまから6日後のリセット時刻を
     * 混ぜて書いていた。`withinCurrentWindow` は「記録がリセットの一週間前より
     * 後か」を見るので、**実時間が進むと窓が滑って、固定の記録が窓から
     * 外れる。**朝は通って夜に落ちた。時計を跨ぐ試験は、落ちた理由が
     * コードに見えない。
     */
    const soon = Math.floor(Date.now() / 1000) + 6 * 24 * 3600;
    const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
    const complete = join(dir, 'rollout-a.jsonl');
    writeFileSync(
      complete,
      line(ago(2), 'Codex Desktop', {
        plan_type: 'plus',
        primary: { used_percent: 30, window_minutes: 300, resets_at: soon },
        secondary: { used_percent: 68, window_minutes: 10080, resets_at: soon },
      })
    );
    const weeklyOnly = join(dir, 'rollout-b.jsonl');
    writeFileSync(
      weeklyOnly,
      line(ago(1), 'codex_exec', {
        plan_type: 'prolite',
        primary: { used_percent: 2, window_minutes: 10080, resets_at: soon },
        secondary: null,
      })
    );
    // 週だけの方を新しくする。これが「最新の読み」で勝っていた側。
    const now = Date.now() / 1000;
    utimesSync(complete, now - 60, now - 60);
    utimesSync(weeklyOnly, now, now);

    const { limit } = readCodexLimit(home);
    eq('新しい方ではなく、両方の窓を持つ読みを採る', limit?.usedPercent, 68);
    eq('5時間も同じ記録から来る', limit?.session?.usedPercent, 30);
    eq('どの実行系のものか分かる', limit?.originator, 'Codex Desktop');

    // 週だけの読みしか無ければ、それを返す。ただし5時間は借りてこない。
    const lone = mkdtempSync(join(tmpdir(), 'codex-lone-'));
    const loneDir = join(lone, '.codex', 'sessions', '2026', '09', '07');
    mkdirSync(loneDir, { recursive: true });
    writeFileSync(
      join(loneDir, 'rollout-b.jsonl'),
      line(ago(1), 'codex_exec', {
        plan_type: 'prolite',
        primary: { used_percent: 2, window_minutes: 10080, resets_at: soon },
        secondary: null,
      })
    );
    const only = readCodexLimit(lone);
    eq('週だけなら週だけ返す', only.limit?.usedPercent, 2);
    eq('5時間は空欄のまま', only.limit?.session, null);
    eq('空欄の理由を言う', typeof only.reason === 'string' && only.reason.includes('codex_exec'), true);
  }

  section('模型ごとの枠を、口座の枠として読まない');
  {
    /*
     * 実測 2026-09-07: 同じロールアウトに `limit_id: "codex_bengalfox"` /
     * `limit_name: "GPT-5.3-Codex-Spark"` が混ざる。形は口座の枠と同じ
     * （5時間＋週）で、値は 0%。ほとんど使っていない模型なので正しい 0% だが、
     * **口座の枠として出すと「Codex は 0%」になる。**
     *
     * 2026-08-27 に「Codex は普通に動いているのに IRIS が 0% と言う」と
     * 報告があったのは、おそらくこれ。
     */
    const named = JSON.stringify({
      timestamp: '2026-09-07T14:58:52.227Z',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex_bengalfox',
          limit_name: 'GPT-5.3-Codex-Spark',
          primary: { used_percent: 0, window_minutes: 300, resets_at: 1788811124 },
          secondary: { used_percent: 0, window_minutes: 10080, resets_at: 1789397924 },
          plan_type: null,
        },
      },
    });
    eq('名前の付いた計器は読まない', parseCodexLimit(named), null);

    const account = JSON.stringify({
      timestamp: '2026-09-07T14:00:00.000Z',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          limit_name: null,
          primary: { used_percent: 30, window_minutes: 300, resets_at: 1788811124 },
          secondary: { used_percent: 68, window_minutes: 10080, resets_at: 1789397924 },
          plan_type: 'plus',
        },
      },
    });
    eq('名前の無い計器は読む', parseCodexLimit(account)?.usedPercent, 68);
    eq('どの計器か持ち歩く', parseCodexLimit(account)?.limitId, 'codex');
    // 名前付きが後ろにあっても、口座の枠が隠れない。
    eq('名前付きを飛ばして口座の枠まで遡る', parseCodexLimit([account, named].join('\n'))?.usedPercent, 68);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Coding CLI usage: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All coding CLI usage tests passed.');
}

main();
