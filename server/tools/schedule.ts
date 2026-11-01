import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import type { ScheduleLectureRead, ScheduledItem } from '../services/schedule_exams.js';

/**
 * 医学科の講義日程表（PDF から取り込んだもの）を引く。
 *
 * IRIS のファイル操作は `IRIS_Workspace` の外を読めない。それは意図した制限で、
 * 広げない。代わりにこの一つの口だけを開ける —— 読むだけで、読む先も一つ。
 * 「カレンダーの予定が日程表と合っているか」を IRIS 自身が確かめられるように
 * （2026-09-30、9/29 の「薬理学58-60」がカレンダー側の誤りだった件。IRIS は
 * 「原本を直接読む手段がありません」と答えるしかなかった）。
 */

/** 原本。IRIS が読むのは取り込み済みの抽出結果で、元はこの PDF。 */
export const SCHEDULE_ORIGINALS = [
  '~/Documents/Founder-Development-Program/m2-schedule/令和8（2026）年度医学科講義日程_2026.6.19版.pdf',
  '~/Downloads/令和8（2026）年度医学科講義日程_2026.6.19版.pdf',
];

const MAX_ITEMS = 60;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function weekday(date: string): string {
  // 暦の上の曜日。時刻は関係ないので UTC の正午で数える。
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? '';
}

/** 授業の終わり。最後の時限の始まりに 60 分。コマ数×70 ではない（昼を跨ぐと合わない）。 */
function endsAt(item: ScheduledItem): string | null {
  if (!item.start || !item.span || item.span < 1) return null;
  const PERIOD_START = ['08:30', '09:40', '10:50', '12:50', '14:00', '15:10', '16:20'];
  const first = item.period ?? PERIOD_START.indexOf(item.start) + 1;
  const last = PERIOD_START[first + item.span - 2];
  if (!last) return null;
  const [h, m] = last.split(':').map(Number);
  const total = h * 60 + m + 60;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function createScheduleTools(read: () => ScheduleLectureRead): Tool[] {
  return [
    {
      name: 'lecture_schedule',
      description:
        '医学科（M2）の講義日程表（令和8年度 2026.6.19 版の PDF）から、授業と試験を日付・語で引きます。' +
        '日程表そのものを引く道具です。カレンダーと合っているかの確認は、これと get_calendar を見比べず check_lecture_calendar を使います（原本は PDF で、IRIS はその取り込み済みの抽出結果を読みます）。' +
        '日付は YYYY-MM-DD。from だけなら、その日の分。query は題名の一部（例: 薬理学58-60）。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '始まりの日 YYYY-MM-DD' },
          to: { type: 'string', description: '終わりの日 YYYY-MM-DD（省略なら from の一日だけ）' },
          query: { type: 'string', description: '題名に含まれる語。空白の有無は無視します' },
        },
      },
      async execute(args: any) {
        const from = typeof args?.from === 'string' ? args.from.trim() : '';
        const to = typeof args?.to === 'string' && args.to.trim() ? args.to.trim() : from;
        const query = typeof args?.query === 'string' ? args.query.replace(/\s+/g, '').trim() : '';
        for (const [name, v] of [['from', from], ['to', to]] as const) {
          if (v && !DATE.test(v)) throw new Error(`${name} は YYYY-MM-DD で指定してください: ${v}`);
        }
        if (!from && !query) throw new Error('from（日付）か query（題名の語）のどちらかを指定してください。');

        const schedule = read();
        if (schedule.reason && !schedule.lectures.length && !schedule.exams.length) {
          // 読めなかったことを「該当なし」にしない。
          throw new Error(`講義日程を読めませんでした: ${schedule.reason}`);
        }

        const rows = [
          ...schedule.lectures.map((i) => ({ kind: '授業', i })),
          ...schedule.exams.map((i) => ({ kind: '試験', i })),
        ]
          .filter(({ i }) => (!from || (i.date >= from && i.date <= to)))
          .filter(({ i }) => !query || i.title.replace(/\s+/g, '').includes(query))
          .sort((a, b) => a.i.date.localeCompare(b.i.date) || (a.i.start ?? '').localeCompare(b.i.start ?? ''));

        return {
          source: schedule.source,
          originals: SCHEDULE_ORIGINALS,
          matched: rows.length,
          truncated: rows.length > MAX_ITEMS ? true : undefined,
          items: rows.slice(0, MAX_ITEMS).map(({ kind, i }) => ({
            kind,
            date: i.date,
            weekday: weekday(i.date),
            title: i.title.replace(/\s+/g, ' ').trim(),
            period: i.period,
            start: i.start,
            end: endsAt(i),
            startBasis: i.startBasis,
          })),
          notApplicableExcluded: schedule.notApplicable ? schedule.notApplicable : undefined,
          note:
            rows.length === 0
              ? '日程表にその条件の授業・試験はありません（読み取りには成功しています）。'
              : '時刻は PDF に無く、カレンダーから測った時限の対応表で付けています。6・7 限は外挿（startBasis を見る）。' +
                (schedule.notApplicable ? `学士入学生向けの ${schedule.notApplicable} 件（動物実験の基礎（学士）など）は、受講対象ではないので除いています。` : ''),
        };
      },
    },
  ];
}
