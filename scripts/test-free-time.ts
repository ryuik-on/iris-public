/**
 * 空き時間。
 *
 * この機能だけは、答えが他人に渡る。だから確かめるのは主に「出しすぎないこと」で、
 * 境界（開始ちょうど・終了ちょうど・終了時刻の無い予定）はすべて入れてある。
 *
 * Run: npx tsx scripts/test-free-time.ts
 */
import { freeForDay, sliceByDay, asPlainText } from '../server/services/free_time.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

const D = '2026-09-01';
const at = (from: string, to?: string, extra: any = {}) => ({
  title: '予定',
  start: `${D}T${from}:00`,
  ...(to ? { end: `${D}T${to}:00` } : {}),
  ...extra,
});
const slots = (events: any[], options: any = {}) =>
  freeForDay(D, events, options).slots.map((s) => `${s.from}-${s.to}`);

function main() {
  section('何も無ければ一日ぶん');
  {
    eq('9時から24時', slots([]), ['09:00-24:00']);
  }

  section('予定のあいだ');
  {
    eq('午後に一件', slots([at('13:00', '15:00')]), ['09:00-13:00', '15:00-24:00']);
    // 09:00-10:00 もちょうど60分あるので出る。書いていて落とした — 最短が
    // 60分なら、60分ちょうども空きである。
    eq(
      '二件のあいだ',
      slots([at('10:00', '12:00'), at('18:00', '20:00')]),
      ['09:00-10:00', '12:00-18:00', '20:00-24:00']
    );
    // 60分未満の隙間は出さない。30分の提案は使えない。
    eq('狭い隙間は捨てる', slots([at('09:00', '12:00'), at('12:30', '24:00')]), []);
    eq('ちょうど60分は残る', slots([at('09:00', '12:00'), at('13:00', '24:00')]), ['12:00-13:00']);
  }

  section('重なりと、はみ出し');
  {
    eq('重なった予定', slots([at('10:00', '14:00'), at('12:00', '13:00')]), ['09:00-10:00', '14:00-24:00']);
    // 枠の外へ出る予定は枠で切る。早朝の予定が翌日の空きを削ってはいけない。
    eq('枠より早い予定', slots([at('07:00', '10:00')]), ['10:00-24:00']);
    eq('枠をまたぐ予定', slots([at('08:00', '25:00')]), []);
  }

  section('終了時刻の無い予定');
  {
    /**
     * 開始だけの予定を「一瞬で終わる」と扱うと、直後が空きとして出てしまう。
     * 少なくとも最短の塊ぶんは埋まっているものとして扱う。
     */
    eq('最短のぶんは埋める', slots([at('13:00')]), ['09:00-13:00', '14:00-24:00']);
  }

  section('終日');
  {
    const day = freeForDay(D, [{ title: '琉大祭', allDay: true, calendar: '自宅' }]);
    eq('その日は空き無し', day.slots.length, 0);
    eq('何が潰しているかを言う', day.note, '琉大祭（終日）');

    /**
     * 祝日だけは潰さない。予定ではなく印で、潰すと休日が一日中埋まって見える。
     * 実測 2026-08-31: 終日9件のうち4件が「日本の祝日」だった。
     */
    const holiday = freeForDay(D, [{ title: '敬老の日', allDay: true, calendar: '日本の祝日' }]);
    eq('祝日は空きのまま', holiday.slots.map((s) => `${s.from}-${s.to}`), ['09:00-24:00']);
    eq('それでも但し書きは残る', holiday.note, '敬老の日（終日）');
  }

  section('貼り付ける形');
  {
    const text = asPlainText(
      [
        { date: '2026-09-01', slots: [{ from: '13:00', to: '15:00' }], note: null },
        { date: '2026-09-02', slots: [], note: '琉大祭（終日）' },
      ],
      ['google', 'icloud'],
      new Date('2026-09-01T14:30:00')
    );
    eq(
      '素の文字で、出典と時刻つき',
      text,
      '9/1(火) 13:00-15:00\n9/2(水) 空きなし  ※ 琉大祭（終日）\n\n（google・icloud から作成 / 2026-09-01 14:30 時点）'
    );
  }

  section('日をまたぐ予定を、またいだ日にも置く');
  {
    /*
     * astra のレビュー（2026-09-08）が見つけ、こちらでも再現した。
     * 予定は開始日だけで束ねられ、`minutesOf` は時刻だけを拾って日付を
     * 捨てる。「9/8 22:00〜9/9 12:00」は 9/8 に逆向きの区間として置かれ、
     * **9/9 には一件も現れず、9:00〜24:00 が丸ごと空きになっていた。**
     *
     * この数字は `freeText` として人に貼られるので、**間違いは画面の中で
     * 止まらない。**
     */
    const dates = ['2026-09-08', '2026-09-09', '2026-09-10'];
    const overnight = [{ title: '夜勤', start: '2026-09-08T22:00', end: '2026-09-09T12:00' }];
    const byDay = sliceByDay(overnight, dates);

    eq('またいだ先の日にも現れる', byDay.get('2026-09-09')?.length, 1);
    eq('その日の始まりから始まる', byDay.get('2026-09-09')?.[0].start, '2026-09-09T00:00');
    eq('終わりは本来の終わり', byDay.get('2026-09-09')?.[0].end, '2026-09-09T12:00');
    eq('始めの日はその日の終わりまで', byDay.get('2026-09-08')?.[0].end, '2026-09-08T23:59');
    eq('始めの日の始まりは動かさない', byDay.get('2026-09-08')?.[0].start, '2026-09-08T22:00');
    eq('関係の無い日には置かない', byDay.get('2026-09-10'), undefined);

    // 肝心なのはここ。翌日の午前が空きとして出ないこと。
    const next = freeForDay('2026-09-09', byDay.get('2026-09-09') ?? []);
    eq('翌日の午前は空きではない', next.slots, [{ from: '12:00', to: '24:00' }]);

    // 切る前の姿。**直す前はこう出ていた**ので、戻ったら気づける。
    const unsliced = freeForDay('2026-09-09', []);
    eq('切らなければ丸ごと空きになる', unsliced.slots, [{ from: '09:00', to: '24:00' }]);
  }

  section('切り分けの、こまかいところ');
  {
    const dates = ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];

    // 終日の終わりは翌日（排他）。3日ぶんの出張は 3日を潰す。
    const trip = sliceByDay(
      [{ title: '出張', start: '2026-09-08', end: '2026-09-11', allDay: true }], dates
    );
    eq('終日は最終日の手前まで', [...trip.keys()].sort(), ['2026-09-08', '2026-09-09', '2026-09-10']);
    eq('排他なので終わりの日は含めない', trip.get('2026-09-11'), undefined);

    // 終わりの無い終日は一日だけ。
    const oneDay = sliceByDay([{ title: 'x', start: '2026-09-09', allDay: true }], dates);
    eq('終わりが無い終日は一日', [...oneDay.keys()], ['2026-09-09']);

    // 終わりの無い時刻付きは、勝手に翌日へ伸ばさない。
    const open = sliceByDay([{ title: '歯医者', start: '2026-09-09T14:00' }], dates);
    eq('終わりが無ければ その日だけ', [...open.keys()], ['2026-09-09']);
    eq('終わりは足さない', open.get('2026-09-09')?.[0].end, undefined);

    // 窓の外の日には置かない。
    const outside = sliceByDay(
      [{ title: 'y', start: '2026-09-06T10:00', end: '2026-09-06T11:00' }], dates
    );
    eq('窓の外は落とす', outside.size, 0);

    // 同じ日で終わるものは、そのまま。
    const plain = sliceByDay(
      [{ title: 'z', start: '2026-09-09T10:00', end: '2026-09-09T11:00' }], dates
    );
    eq('日をまたがないものは触らない', plain.get('2026-09-09')?.[0].end, '2026-09-09T11:00');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Free time: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All free time tests passed.');
}

main();
