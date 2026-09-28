/**
 * 講義日程表とカレンダーの食い違い。
 *
 * 確かめるのは主に**言わないこと** —— どちらが正しいとは言わない、読めて
 * いない側があるときは比べない、そして**読めていない場所を超えて広げない。**
 *
 * Run: npx tsx scripts/test-lecture-divergence.ts
 */
import { findLectureDivergence, lectureKey } from '../server/core/lecture_divergence.js';

let passed = 0, failed = 0;
const failures: string[] = [];
function section(n: string) { console.log(`\n▸ ${n}`); }
function eq(n: string, a: any, b: any) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; failures.push(`${n}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); console.log(`  ✗ ${n}`); }
}

const base = { from: '2026-09-08', to: '2026-09-21' };

section('時刻が違うものを拾う');
{
  /*
   * 実際に起きたこと（2026-09-08）。日程表は 1限＝08:30、カレンダーは 09:40。
   * **気づいたのは本人の記憶で、IRIS は両方を持ちながら黙っていた。**
   */
  const d = findLectureDivergence({
    ...base,
    lectures: [{ title: '病理学Ⅱ31-32', date: '2026-09-09', period: 1, start: '08:30', startBasis: 'measured' }],
    events: [{ title: '病理学Ⅱ31-32', start: '2026-09-09T09:40:00+09:00' }],
  });
  eq('比べた', d.compared, true);
  eq('一件', d.moved.length, 1);
  eq('両方の時刻を並べる', [d.moved[0].scheduled, d.moved[0].calendar], ['08:30', '09:40']);
  eq('どちらが正しいとは書かない', Object.keys(d.moved[0]).includes('correct'), false);
  eq('欠けには数えない', d.missing.length, 0);
}

section('題名の書き方の違いで別物にしない');
{
  const d = findLectureDivergence({
    ...base,
    lectures: [{ title: '病理学Ⅱ35-36 実習', date: '2026-09-11', period: 1, start: '08:30' }],
    events: [{ title: '病理学Ⅱ35-36実習', start: '2026-09-11T08:30:00+09:00' }],
  });
  eq('空白の違いは同じもの', [d.missing.length, d.moved.length], [0, 0]);

  // 回数が違えば別物。前方一致にすると 31-32 と 33-34 が同じになる。
  const other = findLectureDivergence({
    ...base,
    lectures: [{ title: '病理学Ⅱ31-32', date: '2026-09-09', period: 1, start: '08:30' }],
    events: [{ title: '病理学Ⅱ33-34', start: '2026-09-09T08:30:00+09:00' }],
  });
  eq('回数が違えば別物', other.missing.length, 1);
}

section('日がずれているものを、欠けとして数えない');
{
  /*
   * 2026-09-08 に実際にやってしまったこと。突き合わせは日ごとなので、
   * **日付がずれた予定は「その日に無い」に見える。**欠けとして入れた結果、
   * 77件のうち13件が暦に二日並んだ（病理学Ⅱ35-36実習 が 9/10 と 9/11）。
   */
  const d = findLectureDivergence({
    ...base,
    lectures: [{ title: '病理学Ⅱ35-36 実習', date: '2026-09-11', period: 1, start: '08:30' }],
    events: [{ title: '病理学Ⅱ35-36実習', start: '2026-09-10T12:50:00+09:00' }],
  });
  eq('欠けにしない', d.missing.length, 0);
  eq('ずれとして出す', d.shifted.length, 1);
  eq('暦の側の日付を持つ', d.shifted[0].calendar, '2026-09-10');
  eq('日程表の側の日付も持つ', d.shifted[0].date, '2026-09-11');
  // どちらが正しいかは決めない。紙にも暦にも版がある。
  eq('正解を書かない', Object.keys(d.shifted[0]).includes('correct'), false);

  // 離れていれば別物。前の週の同じ授業を「ずれ」と読むと、本当の欠けが消える。
  const farAway = findLectureDivergence({
    ...base,
    lectures: [{ title: '病理学Ⅱ35-36 実習', date: '2026-09-18', period: 1, start: '08:30' }],
    events: [{ title: '病理学Ⅱ35-36実習', start: '2026-09-10T12:50:00+09:00' }],
  });
  eq('一週間離れていれば欠け', farAway.missing.length, 1);
  eq('ずれには数えない', farAway.shifted.length, 0);
}

section('言えないときは比べない');
{
  const noSchedule = findLectureDivergence({ ...base, lectures: [], events: [], scheduleReason: '取り込みがありません。' });
  eq('日程表が読めなければ比べない', noSchedule.compared, false);
  eq('理由を持つ', noSchedule.reason?.includes('取り込み'), true);

  const noCal = findLectureDivergence({ ...base, lectures: [], events: [], calendarReason: '失効しました。' });
  eq('カレンダーが読めなければ比べない', noCal.compared, false);
  eq('「カレンダーに無い」を出さない', noCal.missing.length, 0);
}

section('読めていない場所を超えて広げない');
{
  const lectures = [{ title: 'x', date: '2026-09-09', period: 1, start: '08:30' }];
  /*
   * 数だけ見て止めていたので、**五ヶ月先の一件が今週の突き合わせを拒んだ**
   * （実測 2026-09-08、2027-02-11 の次が 2027-02-13 という一件）。
   * 読めないと言うのは正しいが、読めていない場所を超えて広げるのは諦め。
   */
  const far = findLectureDivergence({
    ...base, lectures, events: [],
    gridFaults: [{ between: ['2027-02-11', '2027-02-13'] }],
  });
  eq('範囲の外の不一致では止まらない', far.compared, true);
  eq('中身は比べられている', far.missing.length, 1);

  const near = findLectureDivergence({
    ...base, lectures, events: [],
    gridFaults: [{ between: ['2026-09-09', '2026-09-11'] }],
  });
  eq('範囲の中の不一致なら止まる', near.compared, false);
  eq('どこが合っていないかを言う', near.reason?.includes('2026-09-09'), true);
}

section('範囲の外の授業は見ない');
{
  const d = findLectureDivergence({
    ...base,
    lectures: [{ title: '来月の授業', date: '2026-10-20', period: 1, start: '08:30' }],
    events: [],
  });
  eq('窓の外は数えない', d.missing.length, 0);
}

section('外挿の時刻は、そう分かるようにする');
{
  const d = findLectureDivergence({
    ...base,
    lectures: [{ title: '夕方の演習', date: '2026-09-09', period: 6, start: '15:10', startBasis: 'extrapolated' }],
    events: [{ title: '夕方の演習', start: '2026-09-09T15:30:00+09:00' }],
  });
  eq('違いは出す', d.moved.length, 1);
  eq('外挿だと印が付く', d.moved[0].extrapolated, true);
}

section('半角の中点と★を、題名の違いにしない');
{
  const d = findLectureDivergence({
    ...base,
    from: '2026-11-09', to: '2026-11-09',
    lectures: [{ title: '★腎･泌1', date: '2026-11-09', period: 2, start: '09:40', startBasis: 'measured' },
               { title: '腎･泌2', date: '2026-11-09', period: 3, start: '10:50', startBasis: 'measured' }],
    events: [{ title: '腎・泌2', start: '2026-11-09T10:50:00+09:00' }],
  });
  eq('中点の半角・全角は同じ題名', d.surplus.length, 0);
  eq('欠けでもない', d.missing.filter((g) => g.title.includes('泌2')).length, 0);
}

section('カレンダーにあって日程表に無いものを拾う（逆向き）');
{
  // 2026-09-16 に手で入れた演習。日程表では 9/18 で、9/18 には正しい方が別にある。
  const d = findLectureDivergence({
    ...base,
    from: '2026-09-15', to: '2026-09-19',
    lectures: [{ title: '医学系演習/プライマリ・ケア演習Ⅱ1-3', date: '2026-09-18', period: 1, start: '08:30', startBasis: 'measured' }],
    events: [
      { title: '医学系演習/プライマリ・ケア演習Ⅱ1-3', start: '2026-09-16T14:00:00+09:00' },
      { title: '★医学系演習　/プライマ リ・ケア演習Ⅱ1-3', start: '2026-09-18T08:30:00+09:00' },
      { title: 'なかゆー飲み', start: '2026-09-18T18:00:00+09:00' },
    ],
  });
  eq('欠けではない（9/18 に正しい方がある）', d.missing.length, 0);
  eq('日ずれでもない（9/18 は埋まっている）', d.shifted.length, 0);
  eq('別の日の複製を余分として出す', d.surplus.length, 1);
  eq('その日付', d.surplus[0].date, '2026-09-16');
  eq('暦の時刻を持つ', d.surplus[0].calendar, '14:00');
  eq('授業でない予定（飲み会）は触らない', d.surplus.some((g) => g.title.includes('飲み')), false);
}
{
  // 日ずれとして拾った相手は、余分として二度言わない。
  const d = findLectureDivergence({
    ...base,
    from: '2026-09-09', to: '2026-09-12',
    lectures: [{ title: '病理学Ⅱ35-36 実習', date: '2026-09-11', period: 1, start: '08:30', startBasis: 'measured' }],
    events: [{ title: '病理学Ⅱ35-36実習', start: '2026-09-10T08:30:00+09:00' }],
  });
  eq('日ずれとして一件', d.shifted.length, 1);
  eq('同じ予定を余分にも数えない', d.surplus.length, 0);
}

section('題名を科目と番号に分ける');
{
  eq('範囲', JSON.stringify(lectureKey('循環器4-6')), JSON.stringify({ subject: '循環器', from: 4, to: 6, annotated: false }));
  eq('単発', JSON.stringify(lectureKey('神経5')), JSON.stringify({ subject: '神経', from: 5, to: 5, annotated: false }));
  eq('接尾の実習は落とす', lectureKey('病理学Ⅱ41-42実習')?.subject, '病理学Ⅱ');
  eq('注記は人の意図', lectureKey('循環器1-3（再）')?.annotated, true);
  eq('番号が無ければ授業ではない', lectureKey('琉大祭'), null);
  eq('予備も授業ではない', lectureKey('病理学Ⅱ予備'), null);
  eq('半角の中点と★を揃える', lectureKey('★腎･泌1')?.subject, '腎・泌');
}

section('余分は科目と番号で見る（意図して残したものは鳴らない）');
{
  const d = findLectureDivergence({
    ...base,
    from: '2026-09-25', to: '2026-11-20',
    lectures: [
      { title: '琉大祭準備', date: '2026-09-25', period: null, start: null, startBasis: 'measured' },
      { title: '★循環器1', date: '2026-10-29', period: 5, start: '14:00', startBasis: 'measured' },
      { title: '循環器2', date: '2026-10-29', period: 6, start: '15:10', startBasis: 'measured' },
      { title: '循環器4', date: '2026-11-12', period: 1, start: '08:30', startBasis: 'measured' },
      { title: '病理学Ⅱ予備', date: '2026-11-19', period: 6, start: '15:10', startBasis: 'measured' },
    ],
    events: [
      { title: '琉大祭', start: '2026-09-26' },
      { title: '循環器1-3（再）', start: '2026-10-30T14:00:00+09:00' },
      { title: '病理学Ⅱ予備', start: '2026-11-18T14:00:00+09:00' },
      { title: '循環器4-6', start: '2026-11-11T08:30:00+09:00' },
      { title: '★循環器1', start: '2026-10-29T14:00:00+09:00' },
      { title: '循環器2', start: '2026-10-29T15:10:00+09:00' },
      { title: '循環器4', start: '2026-11-12T08:30:00+09:00' },
    ],
  });
  eq('余分は古い層の一件だけ', d.surplus.map((g) => g.title).join(), '循環器4-6');
  eq('琉大祭は部分一致で鳴らない', d.surplus.some((g) => g.title === '琉大祭'), false);
  eq('注記付きは鳴らない', d.surplus.some((g) => g.title.includes('（再）')), false);
  eq('予備は鳴らない', d.surplus.some((g) => g.title.includes('予備')), false);
}

section('同じ題名が一日に複数あっても、時刻の合うものに当てる');
{
  const d = findLectureDivergence({
    ...base,
    from: '2027-01-22', to: '2027-01-22',
    lectures: [
      { title: '腎・泌', date: '2027-01-22', period: 4, start: '12:50', startBasis: 'measured' },
      { title: '腎・泌', date: '2027-01-22', period: 5, start: '14:00', startBasis: 'measured' },
      { title: '腎・泌', date: '2027-01-22', period: 6, start: '15:10', startBasis: 'measured' },
    ],
    events: [
      { title: '腎・泌', start: '2027-01-22T15:10:00+09:00' },
      { title: '腎・泌', start: '2027-01-22T12:50:00+09:00' },
      { title: '腎・泌', start: '2027-01-22T14:00:00+09:00' },
    ],
  });
  eq('三つとも揃っていれば時刻違いは無い', d.moved.length, 0);
  eq('欠けも無い', d.missing.length, 0);
}
{
  const d = findLectureDivergence({
    ...base,
    from: '2027-01-22', to: '2027-01-22',
    lectures: [
      { title: '腎・泌', date: '2027-01-22', period: 4, start: '12:50', startBasis: 'measured' },
      { title: '腎・泌', date: '2027-01-22', period: 6, start: '15:10', startBasis: 'measured' },
    ],
    events: [{ title: '腎・泌', start: '2027-01-22T15:10:00+09:00' }],
  });
  eq('一つしか無ければ、残りは欠け（時刻違いではない）', d.missing.length, 1);
  eq('欠けたのは 12:50 の方', d.missing[0].scheduled, '12:50');
}

section('試験も突き合わせる');
{
  /*
   * 実際に起きたこと（2026-09-16）。「今日から年度末まで欠け0」と報告した裏で、
   * **病理学Ⅱ各論試験（10/26 12:50）がカレンダーに無かった。**検査が授業だけを
   * 見ていたので、0 は「無い」ではなく「見ていない」だった。
   *
   * 紙の題名は抽出が途中で折り返して「病理学Ⅱ各論試 験★」になる。空白と★は
   * 突き合わせの前に落ちる。
   */
  const d = findLectureDivergence({
    from: '2026-10-19', to: '2026-10-29',
    lectures: [{ title: '病理学Ⅰ実習41-42', date: '2026-10-19', period: 4, start: '12:50', startBasis: 'measured' }],
    exams: [
      { title: '薬理学期末試験★', date: '2026-10-19', period: 1, start: '08:30', startBasis: 'measured', span: 3 },
      { title: '病理学Ⅱ各論試 験★', date: '2026-10-26', period: 4, start: '12:50', startBasis: 'measured', span: 2 },
      { title: '病理学Ⅰ各論試 験★', date: '2026-10-29', period: 1, start: '08:30', startBasis: 'measured', span: 2 },
    ],
    events: [
      { title: '薬理学期末試験', start: '2026-10-19T08:30:00+09:00' },
      { title: '病理学Ⅰ実習41-42', start: '2026-10-19T12:50:00+09:00' },
      { title: '病理学Ⅰ各論試験', start: '2026-10-26T08:30:00+09:00' },
    ],
  });
  eq('欠けているのは病理学Ⅱ各論試験', d.missing.map((m) => m.title), ['病理学Ⅱ各論試 験★']);
  eq('欠けは試験として印が付く', d.missing[0]?.kind, 'exam');
  eq('コマ数も持って出る（入れ直す長さに要る）', d.missing[0]?.span, 2);
  eq('題名が折り返していても、揃っている試験は欠けにしない', d.missing.some((m) => m.title.includes('薬理')), false);
  /*
   * 紙は病理学Ⅰ各論試験を 10/29 と言い、暦は 10/26 に持っている。三日離れて
   * いるので日ずれ。**どちらが正しいかは言わない。**
   */
  eq('日がずれた試験は日ずれ', d.shifted.map((x) => [x.title, x.date, x.calendar]), [['病理学Ⅰ各論試 験★', '2026-10-29', '2026-10-26']]);
  eq('日ずれを欠けとして二度言わない', d.missing.length, 1);
  eq('暦の側の試験を「日程表に無い」と言わない', d.surplus.length, 0);
  eq('授業は授業として印が付く', d.missing.concat(d.shifted).every((g) => g.kind === 'exam'), true);
}
{
  /*
   * 実測 2026-09-28。暦の 10/29「病理学Ⅰ各論試験（再）」が、紙の 10/29
   * 「病理学Ⅰ各論試験」に部分一致で当たり、食い違い無しと言っていた。
   * **再試は試験ではない。**落ちなければ起きないものが、本番の代わりに
   * 立っていた。
   */
  const d = findLectureDivergence({
    from: '2026-10-26', to: '2026-10-29',
    lectures: [],
    exams: [{ title: '病理学Ⅰ各論試 験★', date: '2026-10-29', period: 1, start: '08:30', startBasis: 'measured', span: 2 }],
    events: [
      { title: '病理学Ⅰ各論試験（再）', start: '2026-10-29T08:30:00+09:00' },
      { title: '病理学Ⅰ各論試験', start: '2026-10-26T08:30:00+09:00' },
    ],
  });
  eq('再試は本番の代わりにならない（日ずれとして出る）', d.shifted.map((x) => [x.date, x.calendar]), [['2026-10-29', '2026-10-26']]);
  eq('注記付きの再試そのものは余分にしない', d.surplus.length, 0);
}
{
  /*
   * 暦にあって、その日の紙に無い試験。実測 2026-09-28、暦の 10/20 に
   * 「病理学Ⅱ各論試験」があり、紙は 10/26。**六日離れているので日ずれでもなく**、
   * 番号が無いので授業の余分にもならず、**検査のどの欄にも出なかった。**
   */
  const d = findLectureDivergence({
    from: '2026-10-19', to: '2026-10-26',
    lectures: [],
    exams: [{ title: '病理学Ⅱ各論試 験★', date: '2026-10-26', period: 4, start: '12:50', startBasis: 'measured', span: 2 }],
    events: [{ title: '病理学Ⅱ各論試験', start: '2026-10-20T08:30:00+09:00' }],
  });
  eq('紙に無い日の試験は余分', d.surplus.map((x) => [x.kind, x.date, x.calendar]), [['exam', '2026-10-20', '08:30']]);
  eq('同時に、紙の日には欠けとして出る', d.missing.map((x) => x.date), ['2026-10-26']);
}
{
  // 試験の題名を含むだけの自分の予定は、余分にしない。完全一致だけを見る。
  const d = findLectureDivergence({
    from: '2026-10-20', to: '2026-10-26',
    lectures: [],
    exams: [{ title: '病理学Ⅱ各論試験', date: '2026-10-26', period: 4, start: '12:50', startBasis: 'measured' }],
    events: [
      { title: '病理学Ⅱ各論試験の勉強', start: '2026-10-20T19:00:00+09:00' },
      { title: '病理学Ⅱ各論試験', start: '2026-10-26T12:50:00+09:00' },
    ],
  });
  eq('「〜の勉強」は試験ではない', d.surplus.length, 0);
  eq('本番は揃っているので欠けない', d.missing.length, 0);
}
{
  // 同じ日に授業と試験が並ぶとき、片方が相手の予定を横取りしない。
  const d = findLectureDivergence({
    from: '2026-10-19', to: '2026-10-19',
    lectures: [{ title: '病理学Ⅰ実習41-42', date: '2026-10-19', period: 4, start: '12:50', startBasis: 'measured' }],
    exams: [{ title: '薬理学期末試験★', date: '2026-10-19', period: 1, start: '08:30', startBasis: 'measured' }],
    events: [
      { title: '薬理学期末試験', start: '2026-10-19T08:30:00+09:00' },
      { title: '病理学Ⅰ実習41-42', start: '2026-10-19T12:50:00+09:00' },
    ],
  });
  eq('同じ日の授業と試験は、それぞれ自分の予定に当たる', [d.missing.length, d.moved.length, d.shifted.length], [0, 0, 0]);
}
{
  // 試験を渡さなければ、振る舞いは前と同じ。既にある呼び出し元を壊さない。
  const d = findLectureDivergence({
    from: '2026-10-26', to: '2026-10-26',
    lectures: [],
    events: [],
  });
  eq('試験を渡さない呼び出しは 0 件のまま', [d.compared, d.missing.length], [true, 0]);
}
{
  /*
   * 抽出結果に試験の欄が無い版（古い道具で作ったもの）。**授業の突き合わせは
   * 続ける。**片方が取れていないことは、もう片方を止める理由にならない。
   */
  const d = findLectureDivergence({
    from: '2026-10-19', to: '2026-10-19',
    lectures: [{ title: '病理学Ⅰ実習41-42', date: '2026-10-19', period: 4, start: '12:50', startBasis: 'measured' }],
    exams: [],
    events: [],
  });
  eq('試験が空でも授業の欠けは出る', d.missing.map((m) => [m.title, m.kind]), [['病理学Ⅰ実習41-42', 'lecture']]);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Lecture divergence: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All lecture divergence tests passed.');
