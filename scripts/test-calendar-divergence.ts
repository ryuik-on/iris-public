/**
 * 源どうしの食い違いの試験。
 *
 * 中心は**読めなかったときに黙ること。**読み取りが失敗した状態で「3件が
 * Mac にありません」と出すのは、嘘をそれらしい数字で言うこと —— 無いのでは
 * なく見えていないので、直しに行く先が全く違う。
 */

import { findDivergence, type SourceReading } from '../server/core/calendar_divergence.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: any) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); console.log('  ✗ ' + name); }
}
function section(n: string) { console.log('\n▸ ' + n); }

const ev = (title: string, start: string, calendar?: string) => ({ title, start, calendar: calendar ?? null });
const src = (source: string, events: any[], ok = true, reason?: string): SourceReading =>
  ({ source, ok, events, reason });

section('クラウドにあって Mac に無い');
{
  /*
   * iPhone で入れた予定が iCloud には届いているのに、Mac の Calendar.app が
   * まだ取り込んでいない状態。**利用者の言う症状そのもの。**
   */
  const d = findDivergence([
    src('eventkit', [ev('ガウス', '2026-09-08T15:00')]),
    src('icloud', [ev('ガウス', '2026-09-08T15:00'), ev('歯医者', '2026-09-09T10:00', '自宅')]),
  ]);
  check('比べられた', d.compared);
  check('一件見つける', d.missingOnMac.length === 1, d.missingOnMac);
  check('題名', d.missingOnMac[0].title === '歯医者');
  check('どのカレンダーか言う', d.missingOnMac[0].calendar === '自宅', d.missingOnMac[0]);
  check('どこで見えたか言う', d.missingOnMac[0].seenIn.includes('icloud'));
  check('逆向きは無い', d.missingInCloud.length === 0, d.missingInCloud);
}

section('Mac にあってクラウドに無い');
{
  // 上りが止まっている形。**iPhone から見えていない**ので、出先で困るのはこちら。
  const d = findDivergence([
    src('eventkit', [ev('会議', '2026-09-08T09:00'), ev('打合せ', '2026-09-10T13:00')]),
    src('google', [ev('会議', '2026-09-08T09:00')]),
  ]);
  check('一件見つける', d.missingInCloud.length === 1, d.missingInCloud);
  check('題名', d.missingInCloud[0].title === '打合せ');
  check('どこに無いか言う', d.missingInCloud[0].missingFrom.includes('google'));
}

section('読めなかったときは比べない');
{
  /*
   * ここが一番大事。**空の配列を「0件」と読むと、読めていない源が
   * 「全部無い」に化ける。**
   */
  const macDown = findDivergence([
    src('eventkit', [], false, 'ヘルパーが応答しません'),
    src('icloud', [ev('歯医者', '2026-09-09T10:00')]),
  ]);
  check('比べたと言わない', macDown.compared === false);
  check('理由を言う', /Mac のカレンダーを読めません/.test(macDown.reason ?? ''), macDown.reason);
  check('相手の言い分も残す', /ヘルパーが応答しません/.test(macDown.reason ?? ''), macDown.reason);
  check('件数を出さない', macDown.missingOnMac.length === 0 && macDown.missingInCloud.length === 0);

  const cloudDown = findDivergence([
    src('eventkit', [ev('会議', '2026-09-08T09:00')]),
    src('icloud', [], false, '認証に失敗'),
  ]);
  check('空の上が読めなくても比べない', cloudDown.compared === false);
  check('「Mac にしか無い」と言わない', cloudDown.missingInCloud.length === 0, cloudDown.missingInCloud);

  const noMac = findDivergence([src('icloud', [ev('x', '2026-09-08T09:00')])]);
  check('Mac を読んでいなければ比べない', noMac.compared === false, noMac.reason);
}

section('片方だけ落ちているときは、残りで比べたと言う');
{
  /*
   * Google が落ちていて iCloud が読めているなら、iCloud と Mac の比較は
   * 成立する。ただし**「Google にしか無い予定」は見えていない**ので、そう書く。
   */
  const d = findDivergence([
    src('eventkit', [ev('会議', '2026-09-08T09:00')]),
    src('icloud', [ev('会議', '2026-09-08T09:00'), ev('歯医者', '2026-09-09T10:00')]),
    src('google', [], false, '失効'),
  ]);
  check('比べた', d.compared === true);
  check('見つける', d.missingOnMac.length === 1, d.missingOnMac);
  check('読めていない源を名指しする', /google/.test(d.reason ?? ''), d.reason);
}

section('突き合わせの鍵');
{
  // 題名と開始時刻。三つの源に共通する識別子が無いので、これしかない。
  const same = findDivergence([
    src('eventkit', [ev(' ガウス ', '2026-09-08T15:00:00')]),
    src('icloud', [ev('ガウス', '2026-09-08T15:00')]),
  ]);
  check('前後の空白と秒は無視', same.missingOnMac.length === 0 && same.missingInCloud.length === 0, same);

  // 同じ題名でも時刻が違えば別の予定。「ガウス」は週に何度も来る。
  const twice = findDivergence([
    src('eventkit', [ev('ガウス', '2026-09-08T15:00')]),
    src('icloud', [ev('ガウス', '2026-09-08T15:00'), ev('ガウス', '2026-09-10T15:00')]),
  ]);
  check('時刻が違えば別の予定', twice.missingOnMac.length === 1, twice.missingOnMac);
}

section('源によって時刻の書き方が違う');
{
  /*
   * EventKit は UTC（`...Z`）、Google と iCloud は帯なしの地方時。同じ予定が
   * 別の文字列になる。**最初これを文字列のまま突き合わせて、35件の存在しない
   * 同期不具合を報告した** —— 両方の一覧に同じ予定が並び、片方だけ9時間
   * ずれていた。時差そのものが「食い違い」として出ていた。
   *
   * この試験は日本時間の機械で走る前提。`Z` 付きの 02:50 は地方時の 11:50。
   */
  const utcIsLocal = (local: string) => new Date(`${local}:00`).toISOString();
  const d = findDivergence([
    src('eventkit', [ev('薬理学', utcIsLocal('2026-09-07T08:30'))]),
    src('google', [ev('薬理学', '2026-09-07T08:30')]),
  ]);
  check('同じ予定として扱う', d.missingOnMac.length === 0 && d.missingInCloud.length === 0, d);

  // 本当に一時間ずれていれば、別の予定として出る。
  const off = findDivergence([
    src('eventkit', [ev('薬理学', utcIsLocal('2026-09-07T09:30'))]),
    src('google', [ev('薬理学', '2026-09-07T08:30')]),
  ]);
  check('本当のずれは見逃さない', off.missingOnMac.length === 1 && off.missingInCloud.length === 1, off);

  // 秒やミリ秒が付いていても同じ。
  const secs = findDivergence([
    src('eventkit', [ev('会議', '2026-09-07T08:30:00.000+09:00')]),
    src('google', [ev('会議', '2026-09-07T08:30')]),
  ]);
  check('秒とミリ秒を無視', secs.missingOnMac.length === 0 && secs.missingInCloud.length === 0, secs);
}

section('終日も、源によって書き方が違う');
{
  /*
   * クラウドは `2026-09-20` と日付だけ、EventKit は**地方時の深夜**を UTC で
   * 表した `2026-09-19T15:00Z` を返す。`Date.parse('2026-09-20')` は UTC の
   * 深夜として読むので、直す前は祝日もライブも両方の一覧に並んでいた ——
   * **時差の分だけ、同じ予定が二重に食い違って見えていた。**
   */
  const localMidnight = new Date('2026-09-20T00:00:00').toISOString();
  const d = findDivergence([
    src('eventkit', [ev('敬老の日', localMidnight)]),
    src('google', [ev('敬老の日', '2026-09-20')]),
  ]);
  check('同じ終日として扱う', d.missingOnMac.length === 0 && d.missingInCloud.length === 0, d);

  const off = findDivergence([
    src('eventkit', [ev('敬老の日', new Date('2026-09-21T00:00:00').toISOString())]),
    src('google', [ev('敬老の日', '2026-09-20')]),
  ]);
  check('本当に日がずれていれば出す', off.missingOnMac.length === 1, off);
}

section('同じ予定を二度数えない');
{
  /*
   * 「日本の祝日」というカレンダーが二つあるので、敬老の日が Mac 側に二件
   * 並ぶ。**同じ予定が二つのカレンダーに入っているのは事実だが、同期の
   * 食い違いとしては一件。**数を水増しすると深刻さを読み違える。
   */
  const d = findDivergence([
    src('eventkit', [ev('敬老の日', '2026-09-20', '日本の祝日'), ev('敬老の日', '2026-09-20', '日本の祝日')]),
    src('google', [ev('会議', '2026-09-08T09:00')]),
  ]);
  check('一件として数える', d.missingInCloud.length === 1, d.missingInCloud);
}

section('食い違いが無ければ、無いと言う');
{
  const d = findDivergence([
    src('eventkit', [ev('会議', '2026-09-08T09:00')]),
    src('icloud', [ev('会議', '2026-09-08T09:00')]),
  ]);
  check('比べた', d.compared === true);
  check('どちらも空', d.missingOnMac.length === 0 && d.missingInCloud.length === 0);
  check('言い訳を付けない', d.reason === null, d.reason);
}

console.log('\n' + '─'.repeat(60));
console.log(`Calendar divergence: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All calendar divergence tests passed.');
