import type { CenterSnapshot } from '../api';

/**
 * ホーム：核を中央に、今日の要点を左右に置く。
 *
 * 「コアめちゃめちゃ好きだから、もっと主役とか、そうじゃなくてもなんか活用したい」
 * 「ホームに戻る画面がない」（利用者、2026-10-17）。核は、IRIS 自身の顔であって、飾りではない。
 * 核の周りに、いま目を向けたいことを置く：次の予定、試験、期限、手が要るもの、今週の使用。
 * 核を隠さず、核と競わない。小さな札を左右に置き、押すと、それぞれの画面へ行く。
 *
 * 札は、通知センターが持っている数字をそのまま使う（ここで新しく読まない）。読めていないものは、
 * 「—」と書く。空欄を、「何も無い」と読ませない。
 */
type Tile = { key: string; label: string; main: string; sub?: string; tone?: 'warn' | 'quiet'; onClick?: () => void };

export function HomeGlance({ center, onCalendar, onCenter, onState }: {
  center: CenterSnapshot | null;
  onCalendar: () => void;
  onCenter: (tab?: string) => void;
  onState: () => void;
}) {
  const summary: any = center?.today?.summary ?? null;
  const next = summary?.todayRemaining?.[0] ?? summary?.tomorrow?.[0] ?? null;
  const nextDay = summary?.todayRemaining?.[0] ? '今日' : summary?.tomorrow?.[0] ? '明日' : '';
  // 予定の入り口が読めていないときの空は、「無い」ではなく「読めていない」。
  const calendarUnread = summary ? summary.calendarComplete === false : false;
  const exam = summary?.nextExam ?? null;
  const due = (summary?.studyDueSoon ?? [])[0] ?? null;
  const approvals = center?.counts.approvals ?? 0;
  const notices = center?.counts.unreadNotices ?? 0;
  const stalled = center?.stalledDev?.length ?? 0;
  const usage: any = center?.system?.usage ?? null;
  const pct = (v: unknown) => (typeof v === 'number' ? `${v}%` : '—');

  const left: Tile[] = [
    next
      ? { key: 'next', label: '次の予定', main: `${next.allDay ? '終日' : next.start ?? ''} ${next.title}`.trim(), sub: `${nextDay}${next.calendar ? `・${next.calendar}` : ''}`, onClick: onCalendar }
      : { key: 'next', label: '次の予定', main: !summary ? '—' : calendarUnread ? '予定を読めていません' : '直近の予定はありません', sub: calendarUnread ? '通信が戻ると読み直します（無い、ではありません）' : undefined, tone: calendarUnread ? 'warn' : undefined, onClick: onCalendar },
    exam
      ? { key: 'exam', label: '次の試験', main: String(exam.title ?? '試験'), sub: typeof exam.days === 'number' ? (exam.days === 0 ? '今日' : `あと ${exam.days} 日`) : undefined, tone: typeof exam.days === 'number' && exam.days <= 3 ? 'warn' : undefined }
      : { key: 'exam', label: '次の試験', main: summary ? '予定されていません' : '—', tone: 'quiet' },
  ];
  const right: Tile[] = [
    due
      ? { key: 'due', label: '近い期限', main: String(due.title ?? due.id ?? '課題'), sub: typeof due.dueInDays === 'number' ? (due.dueInDays < 0 ? `${-due.dueInDays} 日超過` : `あと ${due.dueInDays} 日`) : undefined, onClick: () => onCenter('today') }
      : { key: 'due', label: '近い期限', main: summary ? '近い期限はありません' : '—', tone: 'quiet' },
    {
      key: 'attention', label: '手が要るもの',
      main: center ? `承認 ${approvals}・知らせ ${notices}${stalled ? `・止まった開発 ${stalled}` : ''}` : '—',
      tone: approvals > 0 ? 'warn' : 'quiet',
      onClick: () => onCenter(approvals > 0 ? 'approvals' : notices > 0 ? 'notices' : stalled > 0 ? 'development' : undefined),
    },
    { key: 'usage', label: '今週の使用', main: usage ? `Claude ${pct(usage.claude?.week)}・Codex ${pct(usage.codex?.week)}` : '—', tone: 'quiet', onClick: onState },
  ];

  const card = (t: Tile) => (
    <button
      key={t.key}
      type="button"
      onClick={t.onClick}
      disabled={!t.onClick}
      className={`pointer-events-auto text-left w-[220px] max-w-[26vw] px-3.5 py-2.5 rounded-xl border bg-[var(--hud-panel)] backdrop-blur-sm transition ${
        t.tone === 'warn' ? 'border-amber-400/40' : 'border-[var(--hud-line)]'
      } ${t.onClick ? 'hover:border-sky-400/40 cursor-pointer' : 'cursor-default'}`}
    >
      <div className="text-[11px] text-[var(--hud-muted)]">{t.label}</div>
      <div className={`text-[13px] mt-0.5 leading-snug ${t.tone === 'quiet' ? 'text-zinc-400' : 'text-[var(--hud-text)]'} line-clamp-2`}>{t.main}</div>
      {t.sub && <div className={`text-[11px] mt-0.5 ${t.tone === 'warn' ? 'text-amber-300' : 'text-[var(--hud-muted)]'}`}>{t.sub}</div>}
    </button>
  );

  return (
    <div className="absolute inset-0 pointer-events-none flex items-center justify-between px-6 lg:px-10" aria-label="ホーム">
      <div className="flex flex-col gap-3">{left.map(card)}</div>
      <div className="flex flex-col gap-3 items-end">{right.map(card)}</div>
    </div>
  );
}
