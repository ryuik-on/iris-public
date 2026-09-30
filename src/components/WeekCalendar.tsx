import React from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { fetchSchedule } from '../api';
import type { ScheduleEvent, ScheduleReading } from '../api';
import { addDays, dayKey, hourRange, layoutDay, mondayOf } from '../weekCalendar';
import type { DayLayout, PlacedEvent } from '../weekCalendar';

/**
 * 週の暦。窓いっぱいに。
 *
 * 「もっと大きい画面で見たい」「カレンダーも今日の予定しか見れないじゃん」
 * 「普通のカレンダーみたいにすぐ翌週とかも見れるようにしてほしい」
 * （利用者、2026-09-30）。
 *
 * 予定は右の引き出し（幅 200px ほど）にしか無く、帯は今日と明日の朝まで。
 * 「7日分を見る」は押すと**ただの一覧**になり、縮尺が消えて**空きが行間に
 * 消えていた** —— 帯を作った理由そのものが、週を見た瞬間に無くなる。
 *
 * ここは今日の帯と**同じ向き**（下へ行くほど遅い時刻）。週の画面を別に
 * 覚えなくていいように、今日の帯の倍率違いとして作る。
 */

const WD = ['月', '火', '水', '木', '金', '土', '日'];
/** 手元に持っている週の答えを、これだけの間は使う。予定は分の単位では動かない。 */
const KEEP_MS = 5 * 60_000;

/**
 * カレンダーごとの色。**週をめくっても同じカレンダーは同じ色。**
 *
 * 出てきた順に色を振ると、週によって並びが変わり、先週は青だった職場が
 * 今週は緑になる。名前で決める。
 */
const TONES = ['#6fb58a', '#a58be0', '#d97aa6', '#5fb3b3'];
function toneOf(calendar: string | null | undefined): string {
  const name = calendar ?? '';
  if (name.includes('@')) return 'var(--hud-accent)';
  if (name === '職場') return 'var(--hud-warn)';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}
/** 凡例の名前。Google の主カレンダーはアドレスが名前なので、そう呼ぶ。 */
const calendarLabel = (calendar: string | null | undefined) =>
  !calendar ? '（名前なし）' : calendar.includes('@') ? 'Google' : calendar;

const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * 予定の本当の時刻。**切った後の時刻ではなく。**
 *
 * 日をまたぐ予定は各日の中に切って置くが、札に書くのは元の始まりと終わり。
 * 日付が違えば日付を添える —— 「22:00–02:00」だけでは、その日の中で終わる
 * ように読める。
 */
function spanLabel(e: ScheduleEvent): string {
  const s = new Date(e.start);
  const start = `${clock(s.getHours() * 60 + s.getMinutes())}`;
  if (!e.end || e.end.length < 16) return start;
  const t = new Date(e.end);
  const end = clock(t.getHours() * 60 + t.getMinutes());
  if (dayKey(s) === dayKey(t)) return `${start}–${end}`;
  return `${s.getMonth() + 1}/${s.getDate()} ${start} – ${t.getMonth() + 1}/${t.getDate()} ${end}`;
}

/**
 * その日の空きを一言で。出せない日は `null`（過ぎた日、読めていない源がある週）。
 *
 * 終日の予定で埋まっている日は、**埋まっている理由を添える。**「空きなし」だけだと、
 * 何も書いていない土曜が空いていないように読める。
 */
function freeLabel(reading: ScheduleReading, date: string): string | null {
  const day = reading.free.find((f) => f.date === date);
  if (!day) return null;
  const minutes = freeMinutes(day);
  if (minutes > 0) return `空き ${Math.floor(minutes / 60)}h${minutes % 60 ? String(minutes % 60).padStart(2, '0') : ''}`;
  return day.note ? '終日の予定で空きなし' : '空きなし';
}

function freeMinutes(day: ScheduleReading['free'][number]): number {
  let total = 0;
  for (const s of day.slots) {
    const [fh, fm] = s.from.split(':').map(Number);
    const [th, tm] = s.to.split(':').map(Number);
    total += th * 60 + tm - (fh * 60 + fm);
  }
  return total;
}

type Held = { at: number; reading: ScheduleReading };

export function WeekCalendar({ onClose }: { onClose: () => void }) {
  const [monday, setMonday] = React.useState(() => mondayOf(new Date()));
  const [now, setNow] = React.useState(() => new Date());
  const [selected, setSelected] = React.useState<{ event: ScheduleEvent; date: string } | null>(null);
  const [failures, setFailures] = React.useState<Record<string, string>>({});
  const held = React.useRef(new Map<string, Held>());
  const inflight = React.useRef(new Set<string>());
  const [, rerender] = React.useReducer((n: number) => n + 1, 0);
  const dialog = React.useRef<HTMLDivElement>(null);
  const body = React.useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = React.useState(0);

  const weekKey = dayKey(monday);

  const load = React.useCallback((key: string, force = false) => {
    const have = held.current.get(key);
    if (!force && have && Date.now() - have.at < KEEP_MS) return;
    if (inflight.current.has(key)) return;
    inflight.current.add(key);
    fetchSchedule(7, key)
      .then((reading) => {
        held.current.set(key, { at: Date.now(), reading });
        setFailures((f) => {
          if (!(key in f)) return f;
          const { [key]: _gone, ...rest } = f;
          return rest;
        });
      })
      .catch((err) => setFailures((f) => ({ ...f, [key]: err?.message ?? String(err) })))
      .finally(() => {
        inflight.current.delete(key);
        rerender();
      });
  }, []);

  /*
   * 見ている週を読み、**両隣も先に読んでおく。**「すぐ翌週とかも見れる」の
   * 「すぐ」はここ —— めくってから網を叩くと、一枚ごとに二秒待つ。
   */
  React.useEffect(() => {
    load(weekKey);
    load(dayKey(addDays(monday, 7)));
    load(dayKey(addDays(monday, -7)));
  }, [weekKey, monday, load]);

  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    const el = body.current;
    if (!el) return;
    const observe = new ResizeObserver(() => setBodyHeight(el.clientHeight));
    observe.observe(el);
    setBodyHeight(el.clientHeight);
    return () => observe.disconnect();
  }, []);

  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const go = React.useCallback((weeks: number) => {
    setSelected(null);
    setMonday((m) => addDays(m, weeks * 7));
  }, []);
  const today = React.useCallback(() => {
    setSelected(null);
    setMonday(mondayOf(new Date()));
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 't' || e.key === 'T') { e.preventDefault(); today(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        // 札が開いていれば札から閉じる。**一押しで全部消さない。**
        if (selected) setSelected(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, today, onClose, selected]);

  const reading = held.current.get(weekKey)?.reading ?? null;
  const failure = failures[weekKey] ?? null;
  const dates = Array.from({ length: 7 }, (_, i) => dayKey(addDays(monday, i)));
  const layouts: DayLayout[] = reading ? dates.map((d) => layoutDay(reading.events, d)) : dates.map((d) => ({ date: d, timed: [], allDay: [] }));
  const range = hourRange(layouts);
  const span = range.to - range.from;
  const y = (m: number) => ((m - range.from) / span) * bodyHeight;
  const todayKey = dayKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const last = addDays(monday, 6);
  const label =
    monday.getFullYear() === last.getFullYear()
      ? `${monday.getFullYear()}年 ${monday.getMonth() + 1}月${monday.getDate()}日 – ${last.getMonth() + 1}月${last.getDate()}日`
      : `${monday.getFullYear()}年${monday.getMonth() + 1}月${monday.getDate()}日 – ${last.getFullYear()}年${last.getMonth() + 1}月${last.getDate()}日`;
  const isThisWeek = weekKey === dayKey(mondayOf(now));

  // 凡例は、この週に出ているカレンダーだけ。
  const calendars = [...new Set(layouts.flatMap((day) => [
    ...day.timed.map((p) => p.event.calendar ?? ''),
    ...day.allDay.map((e) => e.calendar ?? ''),
  ]))].sort();

  const hours: number[] = [];
  for (let h = Math.ceil(range.from / 60); h <= range.to / 60; h++) hours.push(h);

  const columns = 'grid-cols-[48px_repeat(7,minmax(104px,1fr))]';

  return createPortal(
    <div
      ref={dialog}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="週の予定"
      className="fixed inset-0 z-50 flex flex-col outline-none"
      style={{ background: 'var(--hud-bg)', color: 'var(--hud-text)' }}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 sm:px-6 pt-4 pb-3">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => go(-1)} aria-label="前の週"
            className="hud-press w-9 h-9 grid place-items-center rounded-md hover:bg-[var(--hud-line)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--hud-accent)]">
            <ChevronLeft size={18} />
          </button>
          <button type="button" onClick={today} disabled={isThisWeek}
            className="hud-press h-9 px-3 rounded-md text-[13px] border disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--hud-accent)]"
            style={{ borderColor: 'var(--hud-line)' }}>
            今日
          </button>
          <button type="button" onClick={() => go(1)} aria-label="次の週"
            className="hud-press w-9 h-9 grid place-items-center rounded-md hover:bg-[var(--hud-line)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--hud-accent)]">
            <ChevronRight size={18} />
          </button>
        </div>
        <h2 className="text-[17px] font-semibold tabular-nums" aria-live="polite">{label}</h2>
        <div className="hud-mono text-[11px]" style={{ color: 'var(--hud-muted)' }}>
          {failure && !reading ? (
            <span style={{ color: 'var(--hud-warn)' }}>読めず</span>
          ) : !reading ? (
            '読み取り中…'
          ) : (
            `${reading.events.length}件 · ${reading.sources.join(' + ') || '源なし'}`
          )}
        </div>
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: 'var(--hud-muted)' }}>
          {calendars.map((c) => (
            <li key={c} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm" style={{ background: toneOf(c) }} />
              {calendarLabel(c)}
            </li>
          ))}
        </ul>
        <button type="button" onClick={onClose} aria-label="週の予定を閉じる"
          className="hud-press ml-auto w-9 h-9 grid place-items-center rounded-md hover:bg-[var(--hud-line)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--hud-accent)]">
          <X size={18} />
        </button>
      </header>

      {reading?.blocked && (
        <p className="px-4 sm:px-6 pb-2 text-[12px]" style={{ color: 'var(--hud-warn)' }}>{reading.blocked}</p>
      )}

      {/* 狭い画面では、この中だけが横に動く。**ページ全体は横に動かさない。** */}
      <div className="flex-1 min-h-0 overflow-auto px-4 sm:px-6 pb-4">
        <div className="min-w-[776px] h-full flex flex-col">
          <div className={`grid ${columns} gap-x-1.5`}>
            <div />
            {dates.map((d, i) => {
              const date = addDays(monday, i);
              const isToday = d === todayKey;
              return (
                <div key={d} className="pb-1.5 border-b" style={{ borderColor: 'var(--hud-line)' }}>
                  <div className="text-[10px] tracking-[0.08em]" style={{ color: isToday ? 'var(--hud-accent)' : 'var(--hud-muted)' }}>
                    {WD[i]}{isToday && ' · 今日'}
                  </div>
                  <div className="hud-mono text-[17px] font-semibold leading-tight tabular-nums"
                    style={{ color: isToday ? 'var(--hud-accent)' : undefined }}>
                    {date.getMonth() + 1}/{date.getDate()}
                  </div>
                </div>
              );
            })}
            {/*
              終日の段。**縦軸には置かない** —— 始まりも終わりも無いものを縮尺に
              置くと、置いた場所が意味を持ってしまう。
            */}
            <div className="text-[9.5px] pt-1.5 text-right pr-1.5" style={{ color: 'var(--hud-muted)' }}>終日</div>
            {layouts.map((day) => (
              <div key={day.date} className="py-1 min-h-[26px] border-b flex flex-col gap-0.5" style={{ borderColor: 'var(--hud-line)' }}>
                {day.allDay.map((e, i) => (
                  <button key={i} type="button" onClick={() => setSelected({ event: e, date: day.date })}
                    className="text-left text-[11px] leading-tight px-1.5 py-[3px] rounded-[3px] truncate focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--hud-accent)]"
                    style={{ background: `color-mix(in srgb, ${toneOf(e.calendar)} 18%, transparent)`, borderLeft: `2px solid ${toneOf(e.calendar)}` }}
                    title={e.title}>
                    {e.title}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div ref={body} className={`relative flex-1 min-h-[540px] grid ${columns} gap-x-1.5 mt-1`}>
            <div className="relative">
              {hours.map((h) => (
                <div key={h} className="hud-mono absolute right-1.5 text-[10px] leading-none tabular-nums -translate-y-1/2"
                  style={{ top: y(h * 60), color: 'var(--hud-muted)' }}>
                  {String(h).padStart(2, '0')}
                </div>
              ))}
            </div>
            {layouts.map((day) => {
              const isToday = day.date === todayKey;
              return (
                <div key={day.date} className="relative rounded-[3px]"
                  style={{ background: isToday ? 'color-mix(in srgb, var(--hud-accent) 9%, transparent)' : 'color-mix(in srgb, var(--hud-accent) 4%, transparent)' }}>
                  {hours.slice(1, -1).map((h) => (
                    <div key={h} className="absolute left-0 right-0 h-px" style={{ top: y(h * 60), background: 'color-mix(in srgb, var(--hud-line) 45%, transparent)' }} />
                  ))}
                  {/* いまの線は予定の下に。**予定の文字の上を横切らせない。** */}
                  {isToday && nowMinutes >= range.from && (
                    <div className="absolute left-0 right-0 h-px" style={{ top: y(nowMinutes), background: 'var(--hud-warn)' }}>
                      <div className="absolute -left-[3px] -top-[2.5px] w-1.5 h-1.5 rounded-full" style={{ background: 'var(--hud-warn)' }} />
                    </div>
                  )}
                  {bodyHeight > 0 && day.timed.map((p, i) => (
                    <EventBlock key={i} placed={p} top={y(p.from)} height={y(p.to) - y(p.from)}
                      onSelect={() => setSelected({ event: p.event, date: day.date })} />
                  ))}
                </div>
              );
            })}
            {!reading && failure && (
              <div className="absolute inset-0 grid place-items-center">
                <div className="max-w-md text-center px-4 py-3 rounded-md" style={{ background: 'var(--hud-bg)', border: '1px solid var(--hud-line)' }}>
                  <p className="text-[13px] mb-1">この週の予定を読めませんでした。</p>
                  <p className="hud-mono text-[11px] break-words mb-2" style={{ color: 'var(--hud-muted)' }}>{failure}</p>
                  <button type="button" onClick={() => load(weekKey, true)} className="text-[12px] py-1.5 px-3 rounded-md border"
                    style={{ borderColor: 'var(--hud-line)', color: 'var(--hud-accent)' }}>
                    もう一度読む
                  </button>
                </div>
              </div>
            )}
          </div>

          {/*
            空きは今日から先だけ（サーバがそう返す）。**過ぎた日に「空き」と書くのは、
            使えない時間を使える顔で出すこと。**読めていない源があるときは出さない。
          */}
          <div className={`grid ${columns} gap-x-1.5 pt-1.5`}>
            <div />
            {dates.map((d) => {
              const text = reading ? freeLabel(reading, d) : null;
              return (
                <div key={d} className="hud-mono text-[10.5px] tabular-nums text-right" style={{ color: 'var(--hud-muted)' }}>
                  {text ?? ''}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {selected && <EventCard event={selected.event} onClose={() => setSelected(null)} />}
    </div>,
    document.body
  );
}

function EventBlock({ placed, top, height, onSelect }: {
  placed: PlacedEvent; top: number; height: number; onSelect: () => void;
}) {
  const e = placed.event;
  const tone = toneOf(e.calendar);
  // 短い予定が線になって読めなくなるので、床を置く。**位置は動かさない。**
  const h = Math.max(height, 18);
  const roomy = h >= 34;
  const width = 100 / placed.columns;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={`${spanLabel(e)}  ${e.title}`}
      /* `button` は中身を縦の真ん中に置く。**時刻は予定の頭に書く** —— 真ん中だと、その高さの時刻に始まるように読める。 */
      className="absolute flex flex-col justify-start items-stretch text-left rounded-[3px] px-1.5 py-[3px] overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--hud-accent)] hover:brightness-125"
      style={{
        top,
        height: h,
        left: `calc(${placed.column * width}% + ${placed.column ? 1 : 0}px)`,
        width: `calc(${width}% - ${placed.columns > 1 ? 2 : 0}px)`,
        background: `color-mix(in srgb, ${tone} 22%, var(--hud-bg))`,
        borderLeft: `2px solid ${tone}`,
        // 前の日から続く／次の日へ続くものは、切った端を破線にする。**切ったことを隠さない。**
        borderTop: placed.continuesBefore ? `1px dashed ${tone}` : undefined,
        borderBottom: placed.continuesAfter ? `1px dashed ${tone}` : undefined,
      }}
    >
      {roomy ? (
        <>
          <div className="hud-mono text-[10px] leading-none tabular-nums" style={{ color: 'var(--hud-muted)' }}>
            {placed.continuesBefore ? '前日から ' : ''}{clock(placed.from)}{placed.continuesAfter ? ' 翌日へ' : ''}
          </div>
          <div className="text-[12px] leading-[1.3] mt-0.5 break-words" style={{ color: 'var(--hud-text)' }}>{e.title}</div>
        </>
      ) : (
        <div className="text-[11px] leading-tight truncate" style={{ color: 'var(--hud-text)' }}>
          <span className="hud-mono tabular-nums mr-1" style={{ color: 'var(--hud-muted)' }}>{clock(placed.from)}</span>
          {e.title}
        </div>
      )}
    </button>
  );
}

function EventCard({ event, onClose }: { event: ScheduleEvent; onClose: () => void }) {
  const tone = toneOf(event.calendar);
  const when = event.allDay
    ? (() => {
        const s = event.start.slice(0, 10).split('-').map(Number);
        return `${s[1]}/${s[2]} 終日`;
      })()
    : (() => {
        const s = new Date(event.start);
        return `${s.getMonth() + 1}/${s.getDate()}(${'日月火水木金土'[s.getDay()]}) ${spanLabel(event)}`;
      })();
  return (
    <div role="dialog" aria-label={event.title}
      className="absolute right-4 bottom-4 w-[min(360px,calc(100vw-32px))] rounded-lg p-4 shadow-xl"
      style={{ background: 'var(--hud-bg)', border: `1px solid ${tone}` }}>
      <div className="flex items-start gap-2">
        <span className="mt-1.5 w-2 h-2 rounded-sm shrink-0" style={{ background: tone }} />
        <h3 className="text-[14px] font-semibold leading-snug flex-1 break-words">{event.title}</h3>
        <button type="button" onClick={onClose} aria-label="閉じる" className="w-7 h-7 grid place-items-center rounded-md hover:bg-[var(--hud-line)] shrink-0">
          <X size={15} />
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-[4em_1fr] gap-y-1 text-[12px]">
        <dt style={{ color: 'var(--hud-muted)' }}>時刻</dt>
        <dd className="hud-mono tabular-nums">{when}</dd>
        {event.location && (<><dt style={{ color: 'var(--hud-muted)' }}>場所</dt><dd className="break-words">{event.location}</dd></>)}
        <dt style={{ color: 'var(--hud-muted)' }}>暦</dt>
        <dd>{calendarLabel(event.calendar)}</dd>
      </dl>
    </div>
  );
}
