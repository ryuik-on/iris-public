/**
 * 予定の下書きの試験。
 *
 * 中心は「正しく読めること」ではなく、**読み違えが画面に出ること。**
 *
 * 取り違えた予定は、正しい予定と見分けが付かない —— 日付があり、題名が
 * 付いていて、本物のカレンダーに並ぶ。だから試験も「間違いをどう見せるか」に
 * 寄せてある。
 */

import {
  buildPrompt,
  parseDraft,
  describeDraft,
  type EventDraft,
} from '../server/core/event_draft.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: any) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); console.log('  ✗ ' + name); }
}
function section(name: string) { console.log('\n▸ ' + name); }

/** 2026-09-06（日）10:00 を「いま」とする。 */
const NOW = new Date(2026, 8, 6, 10, 0, 0);
const json = (o: Record<string, unknown>) => JSON.stringify(o);

section('いまが何日かを模型に渡す');
{
  /*
   * 渡さないと「明日」を訓練時点から数える。**一度どこかで必ず起きる**種類の
   * 間違いで、渡すのは一行で済む。曜日も渡すのは、「来週の火曜」を解くのに
   * 要るのが日付ではなく曜日だから —— 曜日を模型に計算させるとそこが外れる。
   */
  const p = buildPrompt('来週の火曜3時にガウス', NOW);
  check('今日の日付が入る', p.includes('2026-09-06'), p.slice(0, 120));
  check('曜日が入る', p.includes('日曜'), p.slice(0, 120));
  check('いまの時刻が入る', p.includes('10:00'));
  check('入力がそのまま入る', p.includes('来週の火曜3時にガウス'));
  check('絶対値で返せと言う', /絶対値/.test(p));
  check('推測するなと言う', /推測せず null/.test(p));
}

section('ふつうに読めるもの');
{
  const d = parseDraft(json({
    title: 'ガウス', start: '2026-09-08T15:00', end: '2026-09-08T16:00',
    allDay: false, location: null,
  }), NOW)!;
  check('下書きになる', d !== null);
  check('題名', d.title === 'ガウス');
  check('始まり', d.start === '2026-09-08T15:00');
  check('終わり', d.end === '2026-09-08T16:00');
  check('場所が無いことは欠けとして残る', d.missing.includes('場所'), d.missing);
  check('疑いは無い', d.doubts.length === 0, d.doubts);
}

section('前後に付いてくるものを落とす');
{
  const wrapped = '```json\n' + json({ title: '会議', start: '2026-09-10T09:00', allDay: false }) + '\n```';
  check('コードの囲みを落とす', parseDraft(wrapped, NOW)?.title === '会議');
  const chatty = 'はい、こちらです。\n' + json({ title: '会議', start: '2026-09-10T09:00', allDay: false });
  check('前置きを落とす', parseDraft(chatty, NOW)?.title === '会議');
}

section('分からないものを埋めない');
{
  /*
   * 終了時刻が書かれていないときに「1時間」と入れると、**推測が入力と同じ顔**
   * になる。欠けは欠けとして持ち上げて、要るなら人に足してもらう。
   */
  const d = parseDraft(json({
    title: '歯医者', start: '2026-09-10T14:00', end: null, allDay: false, location: null,
  }), NOW)!;
  check('終わりは null のまま', d.end === null);
  check('既定の長さを入れない', !JSON.stringify(d).includes('15:00'));
  check('欠けとして数える', d.missing.includes('終了時刻'), d.missing);
}

section('読み違えの形を、疑いとして持ち上げる');
{
  /*
   * 年を落として今年として読む、週を一つずらす、「来週」を月またぎで外す ——
   * どれも過去か、遠すぎる未来に落ちる。**正しい入力ではめったに出ない形**
   * なので、疑いの印になる。**直さずに持ち上げる**のは、直し方がこちらには
   * 分からないから。日付を勝手にずらす方が、間違ったまま出すより悪い。
   */
  const past = parseDraft(json({ title: 'x', start: '2026-09-01T10:00', allDay: false }), NOW)!;
  check('過去の日付', past.doubts.some((d) => d.includes('過去')), past.doubts);

  const far = parseDraft(json({ title: 'x', start: '2028-01-01T10:00', allDay: false }), NOW)!;
  check('一年より先', far.doubts.some((d) => d.includes('一年')), far.doubts);

  const back = parseDraft(json({
    title: 'x', start: '2026-09-10T15:00', end: '2026-09-10T14:00', allDay: false,
  }), NOW)!;
  check('終わりが始まりより前', back.doubts.some((d) => d.includes('終わり')), back.doubts);

  // 今日そのものは過去ではない。ここを間違えると今日の予定が毎回疑われる。
  const today = parseDraft(json({ title: 'x', start: '2026-09-06T08:00', allDay: false }), NOW)!;
  check('今日の朝は過去ではない', today.doubts.length === 0, today.doubts);
}

section('予定にならないものは、下書きにしない');
{
  /*
   * 部分的に読めた JSON から組み立てると、**欠けた場所に既定値が入る。**
   * 始まりが無ければ予定ではない。
   */
  check('JSON でない', parseDraft('よく分かりませんでした', NOW) === null);
  check('始まりが無い', parseDraft(json({ title: 'x', allDay: false }), NOW) === null);
  check('始まりが言い回しのまま', parseDraft(json({ title: 'x', start: '来週の火曜', allDay: false }), NOW) === null);
  check('日付だけで終日でない', parseDraft(json({ title: 'x', start: '2026-09-10', allDay: false }), NOW) === null);
  check('終日なのに時刻付き', parseDraft(json({ title: 'x', start: '2026-09-10T10:00', allDay: true }), NOW) === null);
  check('題名だけ', parseDraft(json({ title: '会議' }), NOW) === null);
}

section('終日');
{
  const d = parseDraft(json({ title: '出張', start: '2026-09-12', allDay: true }), NOW)!;
  check('終日として読む', d !== null && d.allDay && d.start === '2026-09-12');
  check('終了時刻は欠けに数えない', !d.missing.includes('終了時刻'), d.missing);
}

section('時刻が落ちたことを、終日に化けさせない');
{
  /*
   * 「金曜の夜ごはん」が `allDay: true` で返ってきた（実測）。**時刻を落とした
   * ことが、終日という意図的な指定に化けている。**「9/20 出張」の終日と画面上で
   * 見分けが付かないので、見ても気づけない。
   *
   * 何時かはこちらにも分からない（「夜」は 18時とも 20時とも取れる）ので、
   * **埋めずに落ちたことだけを言う。**
   */
  const night = parseDraft(json({ title: '夜ごはん', start: '2026-09-11', allDay: true }), NOW, '金曜の夜ごはん')!;
  check('「夜」を持ち上げる', night.doubts.some((d) => d.includes('夜')), night.doubts);
  check('時刻は勝手に埋めない', night.start === '2026-09-11' && night.allDay);

  const trip = parseDraft(json({ title: '出張', start: '2026-09-20', allDay: true }), NOW, '9/20 終日 出張')!;
  check('本当の終日は疑わない', trip.doubts.length === 0, trip.doubts);

  // 時刻が入っていれば、言葉があっても問題ない。
  const timed = parseDraft(json({ title: '夜ごはん', start: '2026-09-11T19:00', allDay: false }), NOW, '金曜の夜19時')!;
  check('時刻が付いていれば疑わない', timed.doubts.length === 0, timed.doubts);

  // 入力を渡さない呼び方でも落ちない。
  const noHeard = parseDraft(json({ title: 'x', start: '2026-09-11', allDay: true }), NOW)!;
  check('入力なしでも動く', noHeard !== null && noHeard.doubts.length === 0);
}

section('人に見せる一行は、解決済みの絶対値だけ');
{
  /*
   * 打った言い回し（「来週の火曜」）は出さない。並べると、読み違えていても
   * 「そう書いたから」で通ってしまう。**確認は入力との一致ではなく、結果が
   * 正しいかを見る作業。**
   */
  const timed: EventDraft = {
    title: 'ガウス', start: '2026-09-08T15:00', end: '2026-09-08T16:00',
    allDay: false, location: null, missing: [], doubts: [],
  };
  check('曜日まで出す', describeDraft(timed) === '2026年9月8日(火) 15:00〜16:00', describeDraft(timed));

  const open = { ...timed, end: null };
  check('終わりが無ければ開いたまま', describeDraft(open) === '2026年9月8日(火) 15:00〜', describeDraft(open));

  const allDay: EventDraft = {
    title: '出張', start: '2026-09-12', end: null, allDay: true,
    location: null, missing: [], doubts: [],
  };
  check('終日', describeDraft(allDay) === '2026年9月12日(土) 終日', describeDraft(allDay));
}

console.log('\n' + '─'.repeat(60));
console.log(`Event draft: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All event draft tests passed.');
