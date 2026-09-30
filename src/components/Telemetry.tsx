import React from 'react';
import { Mic, MicOff, Radio, Volume2, CloudOff, Cloud, AlertTriangle, Check, X } from 'lucide-react';
import {
  fetchPortfolio,
  type PortfolioView,
  fetchDelegation,
  holdFdpTask,
  releaseFdpTask,
  grantDelegation,
  revokeDelegation,
  type DelegationState,
  fetchSchedule,
  fetchNextExam,
  type ScheduleReading,
  NextExam,
  type ScheduleEvent,
  fetchFinanceSummary,
  type FinanceSummary,
  openTaskWorkplace,
  raiseTaskSession,
} from '../api';
import type {
  ContextSnapshot, ContextField, SpeechStatus, RoutingStatus, TtsStatus, ProactiveState,
  BudgetState, CliUsageState, FdpTask, FdpTasksReading,
} from '../api';
import { eventsForTodayTimeline, timelineMinutes, NEXT_DAY_TIMELINE_MINUTES, todayListDays } from '../calendarTimeline';
import { WeekCalendar } from './WeekCalendar';

/**
 * The right rail: what IRIS currently believes, and where it got it.
 *
 * The reason this is on screen at all is that every number behind it is
 * uncertain. A confidence, an age, a source that has never been measured, two
 * sensors disagreeing — those are the things a person needs in order to
 * discount what the assistant says, and they are exactly what a tidy summary
 * would throw away. So each field shows its provenance, and what is *not*
 * known is listed rather than omitted.
 */

const BAND_COLOR: Record<string, string> = {
  high: 'var(--hud-ok)',
  medium: 'var(--hud-warn)',
  low: 'var(--hud-danger)',
};

function age(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/** An ISO timestamp as a time someone would say. Anything else is left alone. */
function clock(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const today = new Date();
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  const time = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(at);
  if (sameDay) return time;
  return `${new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(at)} ${time}`;
}

/** Field names that carry a value a person already knows how to read. */
const SPOKEN_KEYS: Record<string, (v: any) => string> = {
  title: (v) => String(v),
  name: (v) => String(v),
  summary: (v) => String(v),
  start: (v) => clock(String(v)),
  end: (v) => clock(String(v)),
  calendar: (v) => String(v),
  text: (v) => String(v),
};

/**
 * What a person should see, rather than what the field happens to be stored as.
 *
 * This fell through to JSON.stringify, so the panel showed
 * `{"title":"そよかぜ書店","start":"2026-0…` — cut off mid-timestamp, in a column too
 * narrow for it. That is a developer's view of a value leaking into the one
 * place that exists to tell a person what IRIS currently believes.
 *
 * Known keys are read in a fixed order so the important part comes first and
 * survives if the rest is cut. Anything unrecognised still falls back to JSON:
 * showing the raw shape is worse than showing a sentence, and better than
 * showing nothing.
 */
function render(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(render).join('、');

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const order = ['title', 'name', 'summary', 'text', 'start', 'end', 'calendar'];
    const parts: string[] = [];
    for (const key of order) {
      if (obj[key] === undefined || obj[key] === null) continue;
      const format = SPOKEN_KEYS[key];
      parts.push(format ? format(obj[key]) : String(obj[key]));
    }
    if (parts.length > 0) {
      // A start with an end reads as a span rather than as two times.
      if (obj.start && obj.end) {
        const spanFrom = parts.indexOf(clock(String(obj.start)));
        if (spanFrom >= 0) parts.splice(spanFrom, 2, `${clock(String(obj.start))}〜${clock(String(obj.end))}`);
      } else if (obj.start) {
        const only = parts.indexOf(clock(String(obj.start)));
        if (only >= 0) parts[only] = `${parts[only]}〜`;
      }
      return parts.join('　');
    }
  }

  return JSON.stringify(value);
}

/**
 * 測っているものの、人が読む名前。
 *
 * `presence.occupied` のような内部の識別子が画面に並んでいた。読める人にしか
 * 読めないし、読める人にとっても「何が測れていないか」は日本語の方が速い。
 *
 * **表に無いものはそのまま出す。**知らない名前を勝手に言い換えない。
 */
const SENSOR_NAMES: Record<string, string> = {
  'presence.occupied': '在室',
  'speech.last_utterance': '最後の発話',
  'input.speech_listening': 'マイクの状態',
  'calendar.next_event': '次の予定',
  'location.place': '現在地',
};
function plainSensor(key: string): string {
  return SENSOR_NAMES[key] ?? key;
}

export function Panel({
  title, right, children,
}: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="hud-panel p-3">
      <div className="flex items-center justify-between mb-2.5">
        <span className="hud-label">{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

function Field({ field }: { field: ContextField }) {
  return (
    <div className="hud-rise space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        {/* 未観測の欄と同じ表を使う。**測っているものの名前は一つ。** */}
        <span className="text-[12px] text-sky-300/70 truncate">{plainSensor(field.kind)}</span>
        <span className="hud-mono text-[12px] text-zinc-500 flex-shrink-0">{age(field.ageMs)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[15px] text-zinc-100 leading-snug">{render(field.value)}</span>
        <span className="hud-mono text-[12px] flex-shrink-0" style={{ color: BAND_COLOR[field.band] }}>
          {field.confidence.toFixed(2)}
        </span>
      </div>
      <div className="hud-meter">
        <span style={{ width: `${Math.round(field.confidence * 100)}%`, background: BAND_COLOR[field.band] }} />
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="hud-mono text-[11px] text-zinc-500">{field.sourceLabel}</span>
        {/* An uncalibrated number is not a probability, and must not be read as one. */}
        {!field.calibrated && (
          <span className="hud-mono text-[11px] px-1 border border-amber-500/40 text-amber-400/90" title="較正なし。確率として扱わないでください。">
            未較正
          </span>
        )}
        {field.decayed && (
          <span className="hud-mono text-[11px] text-zinc-600" title={`観測時の値 ${field.reportedConfidence}`}>
            減衰
          </span>
        )}
        {/* Shown because a person should hesitate for the same reason IRIS does. */}
        {field.disagreement && field.disagreement.length > 0 && (
          <span className="hud-mono text-[11px] px-1 border border-rose-500/40 text-rose-400"
                title={field.disagreement.map((d) => `${d.source}: ${render(d.value)}`).join(' / ')}>
            不一致
          </span>
        )}
      </div>
    </div>
  );
}

export function AccessPanel() {
  const [token, setToken] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  /** 開いているか。既定は畳んだまま — 要るのは新しい端末をつなぐときだけ。 */
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    fetch('/api/access/token')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setToken(d?.token ?? null))
      .catch(() => setToken(null));
  }, []);

  if (!token) return null;

  /**
   * 畳んでおく。**一度しか要らないものが、常に場所を取っていた。**
   *
   * 「別端末からの接続に一度だけ必要です」と書いてあるものが、伏せ字とはいえ
   * 毎回一区画を占めていた。要るときに開けばいい — 開くまでは一行。
   */
  if (!open) {
    return (
      <Panel title="接続">
        <button
          onClick={() => setOpen(true)}
          className="hud-press text-[13px] text-zinc-500 hover:text-zinc-300 text-left"
        >
          別端末をつなぐ
        </button>
      </Panel>
    );
  }

  return (
    <Panel
      title="接続"
      right={<span className="hud-mono text-[11px] text-zinc-600">この端末以外</span>}
    >
      <p className="text-[13px] text-zinc-500 leading-relaxed">
        別端末からの接続に一度だけ必要です。
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="hud-mono flex-1 text-[12px] text-sky-200/90 break-all bg-white/[0.04] px-2 py-1.5">
          {shown ? token : '••••••••••••••••••••••••'}
        </code>
        <button
          onClick={() => setShown((v) => !v)}
          className="hud-mono text-[11px] text-zinc-500 hover:text-zinc-300 px-1"
        >
          {shown ? '隠す' : '表示'}
        </button>
      </div>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(token).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            },
            () => setShown(true)
          );
        }}
        className={`hud-press mt-2 hud-mono text-[11px] tracking-wide ${
          copied ? 'hud-done' : 'text-sky-300/70 hover:text-sky-200'
        }`}
      >
        {copied ? (
          <span className="inline-flex items-center gap-1">
            {/* 線が引かれるように出るチェック。動きが合図そのもの。 */}
            <svg
              className="hud-tick w-3 h-3"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 8.5l3.5 3.5L13 5" />
            </svg>
            コピーしました
          </span>
        ) : (
          'コピー'
        )}
      </button>
    </Panel>
  );
}

export function ContextPanel({ snapshot }: { snapshot: ContextSnapshot | null }) {
  const fields = snapshot ? Object.values(snapshot.fields) : [];
  return (
    <Panel
      title="状況"
      right={
        snapshot && (
          <span className="hud-mono text-[11px] text-zinc-600">{fields.length}件</span>
        )
      }
    >
      {fields.length === 0 && (
        <p className="text-[11px] text-zinc-600 leading-relaxed">
          まだ何も観測されていません。
        </p>
      )}
      <div className="space-y-3">
        {fields.map((f) => <Field key={f.kind} field={f} />)}
      </div>

      {/*
        測れていないものの名前。**内部の識別子ではなく、人の言葉で。**

        `presence.occupied` `speech.last_utterance` `input.speech_listening` が
        そのまま並んでいた。読める人にしか読めないし、読める人にとっても
        「何が測れていないか」は日本語の方が速い。表に無いものはそのまま出す
        — **知らない名前を勝手に言い換えない。**
      */}
      {snapshot && snapshot.unknown.length > 0 && (
        <div className="mt-3 pt-2.5 border-t border-white/5">
          {/* Named rather than hidden: silence from a sensor is not a "no". */}
          <div className="hud-label mb-1.5" style={{ fontSize: 11 }}>未観測（否定ではない）</div>
          <div className="flex flex-wrap gap-1">
            {snapshot.unknown.map((k) => (
              <span key={k} className="text-[11px] px-1 py-0.5 border border-white/10 text-zinc-600">
                {plainSensor(k)}
              </span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/**
 * The task ledger — which of them has stopped moving.
 *
 * The panel beside this one says what IRIS observes. This one says what the
 * person owes, which until now was on screen nowhere: the column was entirely
 * the machine's own state, and the ledger's own reading of itself lived in a
 * spreadsheet nobody opens mid-week.
 *
 * `verdict` is the sheet's `自動判定` column, carried through untouched. Three
 * things are deliberately *not* done here:
 *
 *   A blank verdict is not "順調". It is drawn as 判定なし, because the
 *   formula not having reached a row is not the same as the row being fine.
 *
 *   A failed read is not an empty ledger. `ok: false` prints the reason; it
 *   never prints 0件, which reads as "nothing to do" and is the one wrong
 *   thing this panel could say.
 *
 *   State is never carried by colour alone. The word is always there, because
 *   colour here is reserved for meaning and a person glancing at a rail in
 *   daylight loses hue before they lose text.
 */
export function TasksPanel({
  reading, onChanged, focusId = null, onFocused,
}: {
  reading: FdpTasksReading | null;
  onChanged: () => void;
  /** 着地させる課題。三件に畳んであっても、これは開いて見せる。 */
  focusId?: string | null;
  onFocused?: () => void;
}) {
  const [showAll, setShowAll] = React.useState(false);
  React.useEffect(() => {
    if (!focusId || !reading?.ok) return;
    if (!reading.tasks.some((t) => t.id === focusId)) return;
    setShowAll(true);
    // 描かれてから寄せる。開いた直後は畳まれた三件しか無い。
    const scroll = setTimeout(() => {
      document.getElementById(`task-${focusId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 50);
    // 縁は数秒残す。着いた瞬間に消えると、どれに着いたのか分からない。
    const release = setTimeout(() => onFocused?.(), 4000);
    return () => { clearTimeout(scroll); clearTimeout(release); };
  }, [focusId, reading]);
  if (reading && !reading.ok) {
    return (
      <Panel title="課題" right={<span className="hud-mono text-[11px]" style={{ color: 'var(--hud-warn)' }}>読めず</span>}>
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          課題台帳を読めませんでした。件数は不明です。
        </p>
        <p className="hud-mono text-[11px] text-zinc-600 mt-1.5 break-words">{reading.error}</p>
      </Panel>
    );
  }

  const tasks = reading?.ok ? reading.tasks : [];
  const stalled = tasks.filter((t) => t.verdict === '更新停止').length;

  return (
    <Panel
      title="課題"
      right={
        reading?.ok && <span className="hud-mono text-[11px] text-zinc-600">{tasks.length}件</span>
      }
    >
      {!reading && <p className="text-[11px] text-zinc-600">読み取り中…</p>}

      {reading?.ok && stalled > 0 && (
        // The threshold is written out rather than the ledger's word for it,
        // so the line needs no glossary — and it comes from the sheet's own
        // 設定 tab, so changing it there changes this.
        <p className="hud-mono text-[11px] mb-2.5" style={{ color: 'var(--hud-warn)' }}>
          {stalled}件が {reading.settings.stalledAfterDays}日以上 動いていません
        </p>
      )}

      {reading?.ok && tasks.length === 0 && (
        <p className="text-[11px] text-zinc-600 leading-relaxed">未完了の課題はありません。</p>
      )}

      <div className="space-y-3">
        {(showAll ? tasks : tasks.slice(0, 3)).map((t) => (
          <Task key={t.id} task={t} onChanged={onChanged} highlighted={t.id === focusId} />
        ))}
      </div>
      {tasks.length > 3 && (
        <button type="button" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}
          className="mt-3 py-2 text-[12px] text-[var(--hud-accent)]">
          {showAll ? '3件だけ表示' : `残り${tasks.length - 3}件を見る`}
        </button>
      )}

      {reading?.ok && (
        <div className="mt-3 pt-2.5 border-t border-white/5 space-y-1">
          <div className="hud-mono text-[11px] text-zinc-600">
            {reading.doneCount > 0 && `完了 ${reading.doneCount}件 · `}
            出所 {reading.source === 'iris' ? 'IRIS' : 'スプレッドシート'}
          </div>
          {/*
            The spreadsheet still feeds the daily mail and two phone calendars.
            When a write did not reach it, those are behind by exactly this
            many — worth saying, because a stale feed looks like a quiet one.
          */}
          {reading.unmirroredWrites > 0 && (
            <div className="hud-mono text-[11px]" style={{ color: 'var(--hud-warn)' }}>
              {reading.unmirroredWrites}件がシートに未反映（日次メールとiPhoneのカレンダーはその分だけ古い）
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * Per `docs/dark-ui-colour.md`: green, amber and red are reserved for meaning,
 * and 保留 is none of them. It takes the muted text colour rather than a
 * colour of its own — the answer to "what colour is a hold" is no colour.
 *
 * `--hud-line` was wrong here and briefly shipped: it is a 26%-alpha border
 * tint, near-unreadable as text on the dark ground.
 */
const VERDICT_COLOR: Record<string, string> = {
  順調: 'var(--hud-ok)',
  保留: 'var(--hud-muted)',
  期限間近: 'var(--hud-warn)',
  更新停止: 'var(--hud-warn)',
  進捗停滞: 'var(--hud-warn)',
  遅延: 'var(--hud-danger)',
};

/**
 * The verdict, said as what happened rather than as the ledger's own word.
 *
 * "更新停止" is a column name. It tells a reader that something is wrong but
 * not what, and it was read off this panel and not understood — so the number
 * behind it is shown instead, which needs no glossary and no threshold
 * explained. "順調" goes the same way: it is a judgement, and the fact under
 * it ("last moved three days ago") is both more precise and less flattering.
 */
function saidPlainly(task: FdpTask): string {
  if (task.verdict === '完了') return '完了';
  if (task.verdict === '保留') {
    const until = (task.heldUntil ?? '').replace(/^\d{4}-/, '').replace('-', '月') + '日';
    return task.holdReason ? `${until}まで保留 — ${task.holdReason}` : `${until}まで保留`;
  }
  if (task.verdict === '遅延' && task.dueInDays !== null) {
    return `期限を${Math.abs(task.dueInDays)}日 過ぎています`;
  }
  if (task.verdict === '更新停止') {
    return task.stillDays === null ? '動いていません' : `${task.stillDays}日 動いていません`;
  }
  if (task.verdict === '期限間近' && task.dueInDays !== null) {
    return task.dueInDays === 0 ? '今日が期限です' : `あと${task.dueInDays}日で期限`;
  }
  /*
   * 進捗停滞は「遅れている」だけでは何も言っていない。**何に対して遅れて
   * いるのか**が要る — 残り日数と進捗率を並べると、判定を読まなくても同じ
   * 結論に着く。
   */
  if (task.verdict === '進捗停滞') {
    const percent = task.progress === null ? null : Math.round(task.progress * 100);
    if (percent !== null && task.dueInDays !== null) return `${percent}% で、期限まであと${task.dueInDays}日`;
    if (percent !== null) return `${percent}% で止まっています`;
    return '進みが遅れています';
  }
  // Not started, and not due to start yet: nothing has stopped.
  if (task.status === '未着手' && task.startsInDays !== null && task.startsInDays > 0) {
    return `${task.start ?? ''} 開始予定`.trim();
  }
  if (task.verdict === '順調') {
    if (task.stillDays === null) return '動いています';
    return task.stillDays === 0 ? '今日 動きました' : `${task.stillDays}日前に動きました`;
  }
  return '判定なし';
}

/**
 * Parking a task, and letting it go.
 *
 * The date field has no empty state to fall into: it opens on a fortnight from
 * today, so the quickest path is still a hold that ends. Making the end date
 * skippable would put back exactly the thing the hold was added to remove.
 */
/**
 * 作業場所の一行。押すと Finder で開く。
 *
 * 「タスクだけど、それぞれどこで進めていけばわからない」（利用者、
 * 2026-09-11）。道は台帳の文に埋まっていて、**それがどの資料入れの下かは
 * どこにも書いていなかった。**サーバが実在を確かめた道だけがここに来る。
 */
function Workplace({ task }: { task: FdpTask }) {
  const [state, setState] = React.useState<'idle' | 'opening' | 'failed'>('idle');
  const w = task.workplace;
  if (!w) {
    return <div className="text-[11px] text-zinc-600">作業場所: 決まっていません</div>;
  }
  /*
   * 末尾から見せる。**道は右端に情報がある**（`…/docs/gci-…ledger.csv`）のに、
   * 左から詰めて右を省略すると `~/Documents/Codex/2026-07-28/…` で止まり、
   * 何の場所かが消える（実測 2026-09-11）。全体は title に置く。
   */
  const home = w.path.replace(/^\/Users\/[^/]+\//, '~/');
  const parts = home.split('/');
  const shown = parts.length > 3 ? '…/' + parts.slice(-3).join('/') : home;
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-[11px] text-zinc-600 flex-shrink-0">場所:</span>
      <button
        type="button"
        onClick={async () => {
          setState('opening');
          try { await openTaskWorkplace(task.id); setState('idle'); } catch { setState('failed'); }
        }}
        title={`${home}\n${w.kind === 'file' ? 'Finder でこのファイルの場所を開く' : 'Finder で開く'}`}
        className="hud-mono text-[11px] text-left truncate min-w-0 hover:underline"
        style={{ color: state === 'failed' ? 'var(--hud-warn)' : 'var(--hud-accent)' }}
      >
        {shown}
      </button>
      {state === 'failed' && <span className="text-[11px]" style={{ color: 'var(--hud-warn)' }}>開けませんでした</span>}
    </div>
  );
}

/**
 * 誰が進めているか。押すとそのセッションを前に出す。
 *
 * 場所を Finder で開くより、**続きをやっているセッションを前に出す**方が
 * たいてい欲しいもの（利用者、2026-09-11「いるよ」）。サーバが cwd で
 * 突き合わせたものだけが来る。無ければ「セッションなし」と言う —— 空欄は
 * 「探せなかった」と「居ない」を区別しない。
 *
 * Codex は表示だけ。前に出す URL スキームが無い。
 */
function TaskSessions({ task }: { task: FdpTask }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const list = task.sessions ?? [];
  if (list.length === 0) {
    return <div className="text-[11px] text-zinc-600">セッション: なし</div>;
  }
  return (
    <div className="space-y-0.5">
      {list.map((s) => {
        const label = s.name ?? s.id;
        const state = s.live ? '動作中' : '休止';
        const where = s.scope === 'enclosing' ? '・上の階層で' : '';
        const canRaise = s.kind === 'claude';
        return (
          <div key={s.id} className="flex items-baseline gap-2 min-w-0 text-[11px]">
            <span className="text-zinc-600 flex-shrink-0">セッション:</span>
            {canRaise ? (
              <button
                type="button"
                disabled={busy === s.id}
                onClick={async () => {
                  setBusy(s.id); setNote(null);
                  try { const r = await raiseTaskSession(task.id, s.id); setNote(r?.note ?? null); }
                  catch { setNote('前に出せませんでした'); }
                  finally { setBusy(null); }
                }}
                title={s.doingNow ? `直近: ${s.doingNow}` : undefined}
                className="hud-mono truncate min-w-0 hover:underline"
                style={{ color: 'var(--hud-accent)' }}
              >
                {label}
              </button>
            ) : (
              <span className="hud-mono truncate min-w-0 text-zinc-400" title="Codex は外から前に出せません">{label}</span>
            )}
            <span className="text-zinc-600 flex-shrink-0">{s.kind === 'codex' ? 'Codex・' : ''}{state}{where}</span>
          </div>
        );
      })}
      {note && <div className="text-[10px] text-zinc-600">{note}</div>}
    </div>
  );
}

function HoldControl({ task, onChanged }: { task: FdpTask; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [until, setUntil] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const start = () => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    setUntil(d.toISOString().slice(0, 10));
    setReason('');
    setError(null);
    setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await holdFdpTask(task.id, until, reason, '本人');
      setOpen(false);
      onChanged();
    } catch (err: any) {
      setError(err?.message ?? '保留にできませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    setBusy(true);
    try {
      await releaseFdpTask(task.id, '本人');
      onChanged();
    } catch (err: any) {
      setError(err?.message ?? '解除できませんでした。');
    } finally {
      setBusy(false);
    }
  };

  if (task.heldUntil) {
    return (
      <button onClick={release} disabled={busy}
        className="hud-mono text-[11px] text-zinc-600 hover:text-sky-300 transition disabled:opacity-40">
        保留をやめる
      </button>
    );
  }

  if (!open) {
    return (
      <button onClick={start}
        className="hud-mono text-[11px] text-zinc-700 hover:text-sky-300 transition">
        保留にする
      </button>
    );
  }

  return (
    <div className="space-y-1.5 pt-1">
      <input type="date" value={until} onChange={(e) => setUntil(e.target.value)}
        className="hud-mono text-[11px] bg-transparent border border-white/10 px-1.5 py-1 text-zinc-200 w-full" />
      <input type="text" value={reason} placeholder="理由（任意）"
        onChange={(e) => setReason(e.target.value)}
        className="hud-mono text-[11px] bg-transparent border border-white/10 px-1.5 py-1 text-zinc-200 w-full placeholder-zinc-700" />
      <div className="flex items-center gap-2">
        <button onClick={submit} disabled={busy || !until}
          className="hud-mono text-[11px] px-2 py-0.5 border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 transition disabled:opacity-40">
          {busy ? '…' : 'この日まで保留'}
        </button>
        <button onClick={() => setOpen(false)}
          className="hud-mono text-[11px] text-zinc-600 hover:text-zinc-400 transition">やめる</button>
      </div>
      {error && <p className="hud-mono text-[11px]" style={{ color: 'var(--hud-danger)' }}>{error}</p>}
    </div>
  );
}

function Task({ task, onChanged, highlighted = false }: { task: FdpTask; onChanged: () => void; highlighted?: boolean }) {
  // What the number counts is written out. "あと30日" was read off this panel
  // without it being clear that it was counting to the deadline.
  const due =
    task.dueInDays === null
      ? task.due
        ? `期限 ${task.due}`
        : '期限なし'
      : task.dueInDays < 0
        ? `期限を${Math.abs(task.dueInDays)}日 超過`
        : task.dueInDays === 0
          ? '期限は今日'
          : `期限まで${task.dueInDays}日`;

  const colour = task.verdict ? VERDICT_COLOR[task.verdict] ?? 'var(--hud-warn)' : 'var(--hud-warn)';

  return (
    <div
      id={`task-${task.id}`}
      className="hud-rise space-y-1 rounded-md transition"
      // 着地した課題だけ、一拍だけ縁を持つ。色は構造の青。
      style={highlighted ? { boxShadow: '0 0 0 1px var(--hud-accent)', padding: '6px', margin: '-6px' } : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="hud-mono text-[12px] text-sky-300/70 flex-shrink-0">{task.id}</span>
        <span className="hud-mono text-[12px] text-zinc-500 flex-shrink-0">{due}</span>
      </div>
      <div className="text-[14px] text-zinc-100 leading-snug">{task.title}</div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="hud-mono text-[11px]" style={{ color: colour }}>{saidPlainly(task)}</span>
      </div>
      <details className="iris-task-details">
        <summary className="cursor-pointer py-1 text-[12px] text-[var(--hud-accent)]">次の行動・操作</summary>
        <div className="space-y-2 pt-1">
      {task.nextAction && task.nextAction.trim().length > 0 && (
        <div className="text-[12px] text-zinc-400 leading-snug">
          <span className="text-zinc-600">次: </span>
          {task.nextAction}
        </div>
      )}
      {/*
        どこで進めるか。**無いものは無いと言う。**手続き系（説明会に出る、
        班の希望を出す）に資料入れは無く、そこに何かを結び付けるのは嘘になる。
      */}
      <Workplace task={task} />
      <TaskSessions task={task} />
      <HoldControl task={task} onChanged={onChanged} />
        </div>
      </details>
    </div>
  );
}


/**
 * これから何があるか。
 *
 * `/api/schedule` は最初からサーバにあって、**画面が一度も呼んでいなかった。**
 * 出ていたのは「次の予定」一件だけで、明日以降は画面のどこにも無かった。
 *
 * 空き時間を出さない日がある。サーバが `blocked` を返したときで、意味は
 * **読めていない源がある**ということ。そのとき空きを出せば、予定が欠けたまま
 * 「空いています」と人に渡すことになる。**理由をそのまま出して、空きは出さない。**
 */
/**
 * 一日を縮尺どおりに描く帯。
 *
 * 「なんかタイムラインで見たいね。1日の予定が可視化されてるみたい」
 * （利用者、2026-09-09）。一覧では**空いている時間が行間に消える** ——
 * 同じ日に「10:40に終わって次は12:50」と二度聞かれたのは、始まりと終わりが
 * 並んでいても**その間がどれだけかは読み手が引き算する**ことになるから。
 *
 * 縮尺があるので、空白は空白の大きさで出る。**四時間の空きは四時間ぶんの
 * 高さ**になる。
 *
 * 時刻の無い予定（終日）は帯に置かない。**始まりも終わりも無いものを縮尺の
 * 上に置くと、置いた場所が意味を持ってしまう。**
 */
function DayBand({ events, now }: { events: ScheduleEvent[]; now: Date }) {
  const todayKey = now.toLocaleDateString('sv-SE');
  const minutes = (iso: string) => timelineMinutes(iso, todayKey);
  const timed = eventsForTodayTimeline(events, todayKey);
  if (timed.length === 0) return null;

  /*
   * 端は 08:00〜24:00 を既定にして、はみ出す予定があればそちらへ広げる。
   * **切り取らない** —— 06:00 の予定を 08:00 の位置に描くと、嘘の時刻になる。
   */
  const starts = timed.map((e) => minutes(e.start));
  const ends = timed.map((e) => (e.end && e.end.length >= 16 ? minutes(e.end) : minutes(e.start) + 30));
  const from = Math.min(8 * 60, ...starts);
  // Today always has room through 26:00 so a post-midnight rehearsal is visible.
  const to = Math.max(24 * 60 + NEXT_DAY_TIMELINE_MINUTES, ...ends);
  const H = 420;
  const y = (m: number) => ((m - from) / (to - from)) * H;

  const hours: number[] = [];
  for (let h = Math.ceil(from / 60); h <= Math.floor(to / 60); h += 2) hours.push(h);

  const nowM = now.getHours() * 60 + now.getMinutes();
  const inRange = nowM >= from && nowM <= to;

  return (
    <div className="flex gap-2 mb-5">
      <div className="relative w-[52px] flex-shrink-0" style={{ height: H }}>
        {hours.map((h) => (
          <div
            key={h}
            className="hud-mono absolute right-0 text-[9px] leading-none tabular-nums"
            /* 明暗どちらでも読めるように、色はトークンから取る。 */
            style={{ top: y(h * 60), color: 'var(--hud-muted)' }}
          >
            {h >= 24 ? `翌日 ${String(h - 24).padStart(2, '0')}` : String(h).padStart(2, '0')}
          </div>
        ))}
        {/* いまは溝に出す。**予定の文字の上を横切らせない。** */}
        {inRange && (
          <div
            className="absolute -right-1 w-1.5 h-1.5 rounded-full"
            style={{ top: y(nowM) - 3, background: 'var(--hud-warn)' }}
          />
        )}
      </div>
      <div
        className="relative flex-1 rounded-[3px]"
        /*
         * 溝の地は白の薄膜ではなく、空色の薄膜。**明るい地では白が消える** ——
         * `rgba(255,255,255,.03)` は明モードで一日の器が見えなくなっていた。
         */
        style={{ height: H, background: 'rgba(91,156,245,0.07)' }}
      >
        {inRange && (
          <div
            className="absolute left-0 right-0 h-px"
            style={{
              top: y(nowM),
              background: 'linear-gradient(to right, rgba(199,145,94,0.55), rgba(199,145,94,0))',
            }}
          />
        )}
        {timed.map((e, i) => {
          const a = minutes(e.start);
          const b = e.end && e.end.length >= 16 ? minutes(e.end) : a + 30;
          const clockLabel = (value: number, nextDay: boolean) => {
            const localMinutes = nextDay ? value - 1440 : value;
            return `${nextDay ? '翌日 ' : ''}${String(Math.floor(localMinutes / 60)).padStart(2, '0')}:${String(localMinutes % 60).padStart(2, '0')}`;
          };
          // 短い予定が線になって読めなくなるので、床を置く。位置は動かさない。
          const h = Math.max(y(b) - y(a), 15);
          return (
            <div
              key={i}
              className="absolute left-0 right-0 rounded-[3px] px-1.5 py-0.5 overflow-hidden"
              style={{
                top: y(a),
                height: h,
                background: 'rgba(91,156,245,0.22)',
                borderLeft: '2px solid var(--hud-accent)',
              }}
            >
              <div className="hud-mono text-[9px] leading-none tabular-nums" style={{ color: 'var(--hud-muted)' }}>
                {e.dayOffset > 0 ? clockLabel(a, true) : clockLabel(a, false)}
                {e.end && e.end.length >= 16 ? `-${clockLabel(b, b >= 1440)}` : ''}
              </div>
              {/*
                題名は丸ごと。**`shortTitle` は回数を落とす** —— 「病理学Ⅱ31-32」が
                「病理学Ⅱ」になり、帯の上で二つの授業が見分けられなくなる。
                下の一覧も丸ごと出している。
              */}
              <div className="text-[10.5px] leading-tight truncate mt-px" style={{ color: 'var(--hud-text)' }}>
                {e.title}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SchedulePanel() {
  /**
   * 週の暦を開いているか。
   *
   * ここにあった「7日分を見る」は、押すと**縮尺の無い一覧**に変わっていた。
   * 空きが行間に消えるので、帯を作った理由が週を見た瞬間に無くなる。
   * 週は窓いっぱいの暦で見る（`WeekCalendar`）。この欄は今日のまま。
   */
  const [weekOpen, setWeekOpen] = React.useState(false);
  const [reading, setReading] = React.useState<ScheduleReading | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  /**
   * 次の試験。
   *
   * 一度レールの頭に出したが、52ポイントには日数しか入らず、件名は押さないと
   * 出なかった。求められていたのは「開いた先にまとまっていること」なので、
   * 予定の頭に置く。`undefined` は**まだ読んでいない**、`null` は**読んで、
   * 無かった**。混ぜると、読めていないことが「試験は無い」に見える。
   */
  const [exam, setExam] = React.useState<NextExam | null | undefined>(undefined);

  React.useEffect(() => {
    let alive = true;
    const load = () => {
      fetchSchedule(7)
        .then((d) => { if (alive) { setReading(d); setFailed(null); } })
        .catch((e) => { if (alive) setFailed(e?.message ?? String(e)); });
      fetchNextExam()
        .then((d) => { if (alive) setExam(d); })
        // 試験が読めなくても予定は出す。**片方の不通で両方消さない。**
        .catch(() => { if (alive) setExam(undefined); });
    };
    load();
    const t = setInterval(load, 300_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (failed) {
    return (
      <Panel title="予定" right={<span className="hud-mono text-[11px]" style={{ color: 'var(--hud-warn)' }}>読めず</span>}>
        <p className="text-[11px] text-zinc-400 leading-relaxed">予定を読めませんでした。</p>
        <p className="hud-mono text-[11px] text-zinc-600 mt-1.5 break-words">{failed}</p>
      </Panel>
    );
  }
  if (!reading) {
    return <Panel title="予定"><p className="text-[11px] text-zinc-600">読み取り中…</p></Panel>;
  }

  // 日ごとにまとめる。サーバは平らな並びで返す。
  const byDay = new Map<string, ScheduleEvent[]>();
  for (const e of reading.events) {
    const key = e.start.slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(e);
  }
  const freeByDay = new Map(reading.free.map((f) => [f.date, f]));
  const days = [...byDay.keys()].sort();
  const todayKey = new Date().toLocaleDateString('sv-SE');
  const nextDayEarlyEvents = eventsForTodayTimeline(reading.events, todayKey)
    .filter((event) => event.dayOffset === 1);
  const shownDays = todayListDays(days, todayKey, nextDayEarlyEvents.length > 0);
  const nextEvent = [...reading.events]
    .filter(e => new Date(e.start).getTime() > Date.now())
    .sort((a, b) => a.start.localeCompare(b.start))[0];

  const dayName = (iso: string) => {
    const d = new Date(iso + 'T00:00');
    const w = '日月火水木金土'[d.getDay()];
    const today = todayKey;
    const head = iso === today ? '今日' : `${d.getMonth() + 1}/${d.getDate()}`;
    return `${head}(${w})`;
  };

  return (
    <Panel
      title="予定"
      right={<span className="hud-mono text-[11px] text-zinc-600">{reading.events.length}件 / {reading.days}日</span>}
    >
      {/*
        試験は予定の上。**一番動かないものを一番上に置く。**
        日付が近づくこと自体が読みたいものなので、下に流れると見なくなる。
      */}
      {exam && (
        <div className="mb-2.5 pb-2.5 border-b border-white/5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] text-zinc-200 truncate">{exam.title}</span>
            <span
              className="hud-mono text-[13px] tabular-nums shrink-0"
              style={{ color: exam.days <= 3 ? 'var(--hud-warn)' : 'var(--hud-accent, #7dd3fc)' }}
            >
              {exam.days <= 0 ? '今日' : `あと${exam.days}日`}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 mt-0.5">
            <span className="hud-mono text-[10px] text-zinc-600">
              {exam.date.slice(5).replace('-', '/')}
              {exam.after > 0 && ` ・ この先あと${exam.after}件`}
            </span>
            {/*
              暦ではなく印刷物から答えたときは、そう言う。日程表には版があり、
              刷ったあとに動く。**出どころの違いは、日付と同じ大きさの事実。**
            */}
            {exam.from && (
              <span className="hud-mono text-[10px] text-zinc-600 shrink-0">{exam.from}</span>
            )}
          </div>
        </div>
      )}

      {reading.blocked && (
        <p className="text-[11px] leading-relaxed mb-2" style={{ color: 'var(--hud-warn)' }}>
          {reading.blocked}
        </p>
      )}
      {/*
        今日の帯。**一覧の上。**空きの大きさが見えるのがこれの取り柄で、
        下に置くと一覧を読み終えた人しか見ない。
      */}
      <DayBand events={reading.events} now={new Date()} />

      {days.length === 0 && <p className="text-[11px] text-zinc-600">この先 {reading.days} 日に予定はありません。</p>}
      {days.length > 0 && shownDays.length === 0 && (
        <p className="text-[12px] text-zinc-500 mb-2">今日の予定はありません。</p>
      )}
      {nextEvent && (
        <div className="text-[12px] text-zinc-500 mb-3">
          次：{nextEvent.start.slice(5,10).replace('-', '/')} {nextEvent.allDay ? '終日' : nextEvent.start.slice(11,16)}　{nextEvent.title}
        </div>
      )}
      <div className="space-y-2.5">
        {shownDays.map((day) => {
          const free = freeByDay.get(day);
          return (
            <div key={day} className="hud-rise">
              <div className="flex items-baseline justify-between gap-2">
                <span className="hud-mono text-[12px] text-sky-300/70">{dayName(day)}</span>
                {/* 空きは、出せるときだけ出す。 */}
                {free && free.slots.length > 0 && (
                  <span className="hud-mono text-[11px] text-zinc-600 truncate">
                    空き {free.slots.map((s) => `${s.from}-${s.to}`).join(' ')}
                  </span>
                )}
              </div>
              {(byDay.get(day) ?? []).map((e, i) => (
                <div key={i} className="flex items-baseline gap-2 mt-0.5">
                  <span className="hud-mono text-[11px] text-zinc-500 flex-shrink-0 w-[76px]">
                    {e.allDay ? '終日' : e.start.slice(11, 16)}
                  </span>
                  <span className="text-[13px] text-zinc-200 leading-snug truncate">{e.title}</span>
                </div>
              ))}
              {day === todayKey && nextDayEarlyEvents.map((e, i) => (
                <div key={`next-day-${i}`} className="flex items-baseline gap-2 mt-0.5">
                  <span className="hud-mono text-[11px] text-zinc-500 flex-shrink-0 w-[76px]">
                    翌日 {e.start.slice(11, 16)}
                  </span>
                  <span className="text-[13px] text-zinc-200 leading-snug truncate">{e.title}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <button type="button" aria-haspopup="dialog" aria-expanded={weekOpen} onClick={() => setWeekOpen(true)}
        className="mt-3 text-[12px] text-[var(--hud-accent)] py-2">
        週で見る
      </button>
      {weekOpen && <WeekCalendar onClose={() => setWeekOpen(false)} />}
    </Panel>
  );
}


/**
 * 家計。**月ごとの集計だけ。**
 *
 * サーバはこれを二つに分けている — 月の集計（共有してよい）と、一件ずつの
 * 取引（`privacy: 'local_only'` の印が付き、模型にも人にも渡さない）。その
 * 切り分けは丁寧に作ってあったのに、**共有してよい側を読むものが一つも
 * 無かった。**画面はここだけを読む。
 *
 * `pending` を強調するのは、Gmail の通知から取っただけで**明細と突き合わせて
 * いない**から。合計を確定した数字の顔で出すと、後から明細が来たときに
 * 「増えた」ように見える — 実際には最初から分かっていなかっただけ。
 */
export function FinancePanel() {
  const [summary, setSummary] = React.useState<FinanceSummary | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    const load = () => {
      fetchFinanceSummary()
        .then((d) => { if (alive) { setSummary(d); setFailed(null); } })
        .catch((e) => { if (alive) setFailed(e?.message ?? String(e)); });
    };
    load();
    const t = setInterval(load, 600_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (failed) {
    return (
      <Panel title="家計" right={<span className="hud-mono text-[11px]" style={{ color: 'var(--hud-warn)' }}>読めず</span>}>
        <p className="hud-mono text-[11px] text-zinc-600 break-words">{failed}</p>
      </Panel>
    );
  }
  if (!summary) return <Panel title="家計"><p className="text-[11px] text-zinc-600">読み取り中…</p></Panel>;

  const months = [...summary.spendingByMonth].sort((a, b) => b.month.localeCompare(a.month));
  if (months.length === 0) {
    return (
      <Panel title="家計">
        <p className="text-[11px] text-zinc-600 leading-relaxed">まだ何も取り込んでいません。</p>
      </Panel>
    );
  }

  // 確定していない行がどれだけあるか。合計を出す以上、その素性は一緒に出す。
  const pendingCount = summary.months.filter((m) => m.status === 'pending').reduce((a, m) => a + m.count, 0);
  const total = summary.months.reduce((a, m) => a + m.count, 0);
  const yen = (n: number) => '¥' + Math.abs(n).toLocaleString('ja-JP');
  const biggest = Math.max(...months.map((m) => Math.abs(m.total)), 1);
  const lastImport = summary.imports[0]?.importedAt ?? null;

  /*
   * 直近の月を箱で割る。**未分類を最後に、隠さずに置く。**
   *
   * 分類できたぶんだけ並べると、割合が全体の割合に見える。実際には半分は
   * 店名が届いていないか、規則に無い店で、そこを畳むと**分かっている部分が
   * 全体の顔をする。**未分類は一番大きい箱なので、なおさら出す。
   */
  const latest = months[0]?.month ?? null;
  const buckets = latest
    ? [...summary.months
        .filter((m) => m.month === latest && m.kind === 'spending')
        .reduce((acc, m) => {
          const key = m.category || '未分類';
          acc.set(key, (acc.get(key) ?? 0) + Math.abs(m.total));
          return acc;
        }, new Map<string, number>())]
        .sort((a, b) => (a[0] === '未分類' ? 1 : b[0] === '未分類' ? -1 : b[1] - a[1]))
    : [];
  const bucketTotal = buckets.reduce((a, b) => a + b[1], 0);
  const staleDays = lastImport
    ? Math.floor((Date.now() - Date.parse(lastImport)) / 86_400_000)
    : null;

  return (
    <Panel
      title="家計"
      right={<span className="hud-mono text-[11px] text-zinc-600">{total}件</span>}
    >
      <div className="space-y-1.5">
        {months.map((m) => (
          <div key={m.month} className="hud-rise">
            <div className="flex items-baseline justify-between gap-2">
              <span className="hud-mono text-[12px] text-sky-300/70">{m.month.replace('-', '年')}月</span>
              <span className="hud-mono text-[13px] text-zinc-100">{yen(m.total)}</span>
            </div>
            <div className="hud-meter mt-1">
              <span style={{ width: `${Math.round((Math.abs(m.total) / biggest) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>

      {buckets.length > 0 && (
        <div className="mt-3 pt-2.5 border-t border-white/5">
          <div className="hud-mono text-[10px] text-zinc-600 mb-1.5">
            {latest?.replace('-', '年')}月の内訳
          </div>
          <div className="space-y-1">
            {buckets.map(([name, yenAmount]) => {
              const unknown = name === '未分類';
              return (
                <div key={name} className="flex items-baseline gap-2">
                  <span
                    className={`text-[11px] flex-1 ${unknown ? 'text-zinc-500' : 'text-zinc-300'}`}
                  >
                    {name}
                  </span>
                  <span className="hud-mono text-[10px] text-zinc-600 tabular-nums">
                    {Math.round((yenAmount / Math.max(1, bucketTotal)) * 100)}%
                  </span>
                  <span
                    className={`hud-mono text-[11px] tabular-nums ${unknown ? 'text-zinc-500' : 'text-zinc-200'}`}
                  >
                    {yen(yenAmount)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/*
        素性を数字の隣に置く。**確定していないことは、合計と同じ大きさの事実。**
      */}
      {pendingCount > 0 && (
        <p className="text-[11px] leading-relaxed mt-2" style={{ color: 'var(--hud-warn)' }}>
          {pendingCount === total ? '全件' : `${pendingCount}件`}が
          カードの通知メールだけで、明細と突き合わせていません。確定した額ではありません。
        </p>
      )}
      {staleDays !== null && staleDays >= 3 && (
        <p className="text-[11px] text-zinc-500 leading-relaxed mt-1">
          最後の取り込みは {staleDays}日前。それ以降の買い物は入っていません。
        </p>
      )}
    </Panel>
  );
}

export function SpeechPanel({
  status, onStart, onStop, busy,
}: { status: SpeechStatus | null; onStart: () => void; onStop: () => void; busy: boolean }) {
  const listening = status?.state === 'listening';
  const unavailable = status?.state === 'unavailable';

  return (
    <Panel
      title="音声入力"
      right={
        <button
          onClick={listening ? onStop : onStart}
          disabled={busy || unavailable}
          className={`hud-mono text-[11px] px-2 py-0.5 border transition disabled:opacity-40 ${
            listening
              ? 'border-rose-500/50 text-rose-300 hover:bg-rose-500/10'
              : 'border-sky-500/40 text-sky-300 hover:bg-sky-500/10'
          }`}
        >
          {listening ? '停止' : '聞く'}
        </button>
      }
    >
      <div className="flex items-center gap-2.5">
        {listening ? <Mic className="w-4 h-4 text-sky-400" /> : <MicOff className="w-4 h-4 text-zinc-600" />}
        <div className="flex items-end gap-[3px] h-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="hud-bar"
              style={{
                animationDelay: `${i * 110}ms`,
                animationPlayState: listening ? 'running' : 'paused',
                opacity: listening ? 1 : 0.15,
              }}
            />
          ))}
        </div>
        <span className="hud-mono text-[12px] text-zinc-500 ml-auto uppercase">{status?.state ?? '—'}</span>
      </div>

      {/* Volatile text: shown so the sentence can be watched forming, and
          deliberately styled as provisional because it is not yet what was said. */}
      {status?.partial && (
        <p className="mt-2.5 text-[11px] text-sky-200/60 italic leading-snug">{status.partial}…</p>
      )}

      {status && status.pending > 0 && (
        <p className="mt-2 hud-mono text-[12px] text-zinc-500">未取得の発話 {status.pending} 件</p>
      )}

      {status?.lastError && (
        <div className="mt-2.5 flex items-start gap-1.5 text-[12px] text-amber-300/90 leading-snug">
          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <div>
            <div>{status.lastError.message}</div>
            {status.lastError.hint && <div className="text-zinc-500 mt-0.5">{status.lastError.hint}</div>}
          </div>
        </div>
      )}
    </Panel>
  );
}

export function RoutingPanel({ routing }: { routing: RoutingStatus | null }) {
  if (!routing?.routing) {
    return (
      <Panel title="モデル経路">
        <p className="text-[11px] text-zinc-600">プロバイダが設定されていません。</p>
      </Panel>
    );
  }
  return (
    <Panel
      title="モデル経路"
      right={<span className="hud-mono text-[11px] text-zinc-600">無料優先</span>}
    >
      <div className="space-y-1.5">
        {routing.providers?.map((p) => (
          <div key={p.key} className="flex items-center gap-2">
            <span
              className={`w-1.5 h-1.5 flex-shrink-0 ${p.available ? 'bg-emerald-400' : 'bg-rose-500'}`}
              style={{ borderRadius: 1 }}
            />
            <span className="hud-mono text-[12px] text-zinc-300 w-20 truncate">{p.key}</span>
            <span className="hud-mono text-[11px] text-zinc-600 flex-1 truncate">{p.model}</span>
            {/* When a provider is out, the useful fact is when it comes back. */}
            {p.available ? (
              <span className="hud-mono text-[11px] text-zinc-600">{p.servedCount}</span>
            ) : (
              <span className="hud-mono text-[11px] text-amber-400/80" title={p.message ?? undefined}>
                {p.retryAt ? new Date(p.retryAt).toLocaleTimeString() : p.reason}
              </span>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function VoicePanel({ tts, onStop }: { tts: TtsStatus | null; onStop: () => void }) {
  const active = tts?.engines.find((e) => e.id === tts.engine);
  return (
    <Panel
      title="音声出力"
      right={
        tts?.speaking ? (
          <button onClick={onStop} className="hud-mono text-[11px] px-2 py-0.5 border border-rose-500/50 text-rose-300">
            停止
          </button>
        ) : undefined
      }
    >
      <div className="space-y-1.5">
        {tts?.engines.map((e, i) => (
          <div key={e.id} className="flex items-center gap-2">
            <span className="hud-mono text-[11px] text-zinc-600 w-3">{i + 1}</span>
            {/* Whether the text leaves this machine is the fact worth seeing. */}
            {e.remote
              ? <Cloud className="w-3 h-3 flex-shrink-0" style={{ color: e.ok ? 'var(--hud-warn)' : '#3f4c5a' }} />
              : <CloudOff className="w-3 h-3 flex-shrink-0" style={{ color: e.ok ? 'var(--hud-ok)' : '#3f4c5a' }} />}
            <span className={`hud-mono text-[12px] flex-1 truncate ${e.ok ? 'text-zinc-300' : 'text-zinc-600'}`}>
              {e.id}
            </span>
            {e.id === tts?.engine && e.ok && (
              <span className="hud-mono text-[11px] text-sky-400">有効</span>
            )}
            {!e.ok && <span className="hud-mono text-[11px] text-zinc-700" title={e.reason}>無効</span>}
          </div>
        ))}
      </div>
      {active?.remote && active.ok && (
        <p className="mt-2 text-[12px] text-amber-300/80 leading-snug">
          読み上げテキストはこの端末の外に送信されます。
        </p>
      )}
    </Panel>
  );
}

export function SuggestionsPanel({
  state, onAccept, onDismiss,
}: { state: ProactiveState | null; onAccept: (id: string) => void; onDismiss: (id: string) => void }) {
  const pending = state?.pending ?? [];
  if (pending.length === 0) return null;

  return (
    <Panel title="提案" right={<Radio className="w-3 h-3 text-sky-400 hud-pulse" />}>
      <div className="space-y-2.5">
        {pending.map((s) => (
          <div key={s.id} className="hud-rise space-y-1.5">
            <p className="text-[12px] text-zinc-100 leading-snug">{s.suggestion}</p>
            {/* The evidence, so the reasoning can be disagreed with and not
                just the conclusion. */}
            <div className="space-y-0.5">
              {s.because.map((b) => (
                <div key={b.kind} className="hud-mono text-[11px] text-zinc-600 flex items-center gap-1.5">
                  <span className="truncate">{b.kind} = {render(b.value)}</span>
                  <span style={{ color: BAND_COLOR[b.confidence >= 0.75 ? 'high' : b.confidence >= 0.4 ? 'medium' : 'low'] }}>
                    {b.confidence.toFixed(2)}
                  </span>
                  {!b.calibrated && <span className="text-amber-500/70">未較正</span>}
                </div>
              ))}
            </div>
            <div className="flex gap-1.5 pt-0.5">
              <button
                onClick={() => onAccept(s.id)}
                className="hud-mono text-[11px] px-2 py-0.5 border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 flex items-center gap-1"
              >
                <Check className="w-2.5 h-2.5" /> 実行
              </button>
              <button
                onClick={() => onDismiss(s.id)}
                className="hud-mono text-[11px] px-2 py-0.5 border border-white/10 text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
              >
                <X className="w-2.5 h-2.5" /> 却下
              </button>
            </div>
          </div>
        ))}
      </div>
      {/* A guess may open a conversation and nothing else — the orchestrator
          enforces it, and saying so here keeps the promise visible. */}
      <p className="mt-2.5 pt-2 border-t border-white/5 text-[11px] text-zinc-600 leading-relaxed">
        推定実行は外部・破壊操作を行いません。
      </p>
    </Panel>
  );
}

export { Volume2 };

/**
 * The standing approval, and what it has spent today.
 *
 * Shown whether or not anything is granted, unlike most panels here — the
 * question "can IRIS start work without asking me right now" should be
 * answerable by looking, not by remembering. When a grant exists the panel
 * says what it costs so far against its cap, because a delegation that stops
 * being visible is the failure mode of granting one.
 */
export function DelegationPanel() {
  const [state, setState] = React.useState<DelegationState | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    fetchDelegation().then(setState, () => setState(null));
  }, []);

  React.useEffect(() => {
    load();
    // Slow: the number moves only when an agent finishes.
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  if (!state) return null;

  const act = (fn: () => Promise<DelegationState>) => {
    setBusy(true);
    fn().then(
      (next) => {
        setState(next);
        setBusy(false);
        // The POST answers with the grant alone; re-read for the spend.
        load();
      },
      () => setBusy(false)
    );
  };

  if (!state.granted) {
    return (
      <Panel title="委任" right={<span className="hud-mono text-[11px] text-zinc-600">未委任</span>}>
        <p className="text-[13px] text-zinc-500 leading-relaxed">
          毎回承認が必要です。委任すると、範囲と上限内で自動的に着手します。
        </p>
        <button
          disabled={busy}
          onClick={() => act(() => grantDelegation({ dailyUsdCap: 5, maxConcurrent: 1, days: 30 }))}
          className="hud-press mt-2 hud-mono text-[11px] tracking-wide text-sky-300/70 hover:text-sky-200 disabled:text-zinc-600"
        >
          {busy ? '委任しています…' : '委任する（1日 $5 / 同時1件 / 30日）'}
        </button>
      </Panel>
    );
  }

  const grant = state.grant!;
  const today = state.today;
  const days = Math.max(0, Math.ceil((Date.parse(grant.expiresAt) - Date.now()) / 86400000));
  // The charged figure, not the metered one: in-flight and unreadable runs
  // count at the per-run ceiling, and that is what the cap is measured against.
  const used = today?.chargedUsd ?? 0;
  const ratio = today ? Math.min(1, used / today.capUsd) : 0;

  return (
    <Panel
      title="委任"
      right={<span className="hud-mono text-[11px] text-sky-300/60">委任中</span>}
    >
      <p className="text-[13px] text-zinc-500 leading-relaxed">
        コーディングを自動で開始します。成果はブランチに残り、本体には入りません。
      </p>

      <div className="mt-2 hud-mono text-[12px] text-zinc-400 tabular-nums">
        本日 ${used.toFixed(2)} / ${today?.capUsd.toFixed(2) ?? '—'}
        {today && today.unmetered > 0 && (
          <span className="text-amber-300/70"> （未確定 {today.unmetered}件）</span>
        )}
      </div>
      <div className="mt-1 h-[3px] bg-white/[0.06]">
        <div
          className="h-full bg-sky-400/50"
          style={{ width: `${ratio * 100}%`, transition: 'width 400ms ease-out' }}
        />
      </div>

      <div className="mt-2 hud-mono text-[11px] text-zinc-600">
        同時 {grant.maxConcurrent} 件 · 残り {days} 日 · {grant.repos.length} リポジトリ
      </div>

      <button
        disabled={busy}
        onClick={() => act(revokeDelegation)}
        className="hud-press mt-2 hud-mono text-[11px] tracking-wide text-zinc-500 hover:text-zinc-300 disabled:text-zinc-700"
      >
        {/* `…` では何をしているのか分からない。**待たせるなら、何をか言う。** */}
        {busy ? '解除しています…' : '委任を解除'}
      </button>
    </Panel>
  );
}

/** The four the ledger defines, and the one that means it could not be read. */
const TASK_TONE: Record<string, string> = {
  Done: 'text-emerald-300/60',
  'In Progress': 'text-sky-300/80',
  Blocked: 'text-amber-300/85',
  Todo: 'text-zinc-400',
  Unknown: 'text-rose-300/85',
};

