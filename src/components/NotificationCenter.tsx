import React, { useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import type { CenterSnapshot, SelfFinding } from '../api';
import { dismissFinding, approveFinding, pauseSelfDev, markAllNoticesRead, recheckCenter, retryFinding, updateFdpTask, holdFdpTask, abandonDevTask, restartDevTask } from '../api';

/**
 * 通知センター。IRIS 全体の「いま」を一枚で。
 *
 * レールの札・チャット・盤に散らばっていたものを、ここに集める：今日のまとめと提案、
 * IRIS からの知らせ、開発の実行、承認待ち、IRIS 自身の状態、活動のログ。
 * 数秒ごとに読み直すので、開いている間は動いているものが動いて見える。
 *
 * ここは見る場所で、動かす場所ではない。行を押すと該当の会話へ行く。
 */

type Tab = 'today' | 'notices' | 'development' | 'improve' | 'approvals' | 'system' | 'log';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'today', label: '今日' },
  { id: 'notices', label: '知らせ' },
  { id: 'development', label: '開発' },
  { id: 'improve', label: '改善' },
  { id: 'approvals', label: '承認' },
  { id: 'system', label: '状態' },
  { id: 'log', label: 'ログ' },
];

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const minutes = Math.floor((now - t) / 60_000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes} 分前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 時間前`;
  return `${Math.floor(minutes / (24 * 60))} 日前`;
}

function duration(from: string, to: string | null): string {
  const end = to ? Date.parse(to) : Date.now();
  const seconds = Math.max(0, Math.floor((end - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分`;
  return `${Math.floor(seconds / 3600)} 時間 ${Math.floor((seconds % 3600) / 60)} 分`;
}

const STOP_REASON: Record<string, string> = {
  completed: '完了',
  unmeterable: '費用を読めず停止',
  time_limit: '時間上限で停止',
  cost_limit: '費用上限で停止',
  machine_slept: 'スリープで停止',
  spawn_failed: '起動できなかった',
  stopped_by_user: '手で停止',
};

function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'live' | 'quiet'; children: React.ReactNode }) {
  const style = {
    ok: 'text-emerald-300 border-emerald-400/30',
    warn: 'text-amber-300 border-amber-400/30',
    bad: 'text-rose-300 border-rose-400/30',
    live: 'text-sky-300 border-sky-400/30 animate-pulse',
    quiet: 'text-zinc-500 border-zinc-600/40',
  }[tone];
  return <span className={`hud-mono text-[10px] px-1.5 py-0.5 border rounded flex-shrink-0 ${style}`}>{children}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="hud-mono text-[12px] text-zinc-600 px-1 py-6">{children}</div>;
}

const SOURCE_LABEL: Record<SelfFinding['source'], string> = {
  complaint: 'あなたの不満', selfcheck: '動作チェック', error: 'エラー・停止', overview: '全体',
};
const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Claude（本命。速いほうも合計）', 'anthropic-fast': 'Claude（速い）', openai: 'OpenAI', gemini: 'Gemini' };
const REASON_LABEL: Record<string, string> = {
  insufficient_credit: '残高が足りません', quota_exhausted: '今日の無料枠を使い切りました', rate_limited: '混み合っています',
  overloaded: '混み合っています', auth: '鍵が通りません', timeout: '応答がありません', network: '通信できません',
};

const STATUS_LABEL: Record<SelfFinding['status'], { text: string; tone: 'ok' | 'warn' | 'bad' | 'live' | 'quiet' }> = {
  open: { text: '直す順番待ち', tone: 'quiet' },
  fixing: { text: '直しています', tone: 'live' },
  verifying: { text: '検査しています', tone: 'live' },
  awaiting_approval: { text: '承認待ち', tone: 'warn' },
  merged: { text: '反映済み', tone: 'ok' },
  dismissed: { text: '却下', tone: 'quiet' },
  failed: { text: '直せなかった', tone: 'bad' },
};

function plusDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 学習・課題の提案に付く、その場の操作。期限を延ばす／完了にする。IRIS の台帳が正本で、シートへは後から反映される。 */
function TaskActions({ taskId, ask, onChanged }: { taskId: string; ask?: { status: string | null; progress: number | null }; onChanged: () => void }) {
  const [date, setDate] = useState(plusDays(7));
  const [confirmDone, setConfirmDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = (field: 'dueDate' | 'status' | 'progress', value: string, label: string) => {
    setBusy(true);
    setMessage(null);
    updateFdpTask(taskId, field, field === 'dueDate' ? value.replace(/-/g, '/') : value)
      .then((r) => {
        setMessage(`${label}。${r.mirror && r.mirror.ok === false ? 'シートへの反映は時間がかかっています（IRIS の台帳は更新済み）。' : 'シートにも反映しました。'}`);
        setConfirmDone(false);
        onChanged();
        // 進捗を答えたとき、まだ未着手なら着手したことにする（進捗があるのに未着手、は食い違い）。
        if (field === 'progress' && ask?.status === '未着手') return updateFdpTask(taskId, 'status', '進行中').then(() => onChanged());
      })
      .catch((err: any) => setMessage(err?.message ?? String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-1.5 pt-1.5 border-t border-[var(--hud-line)] flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
      {ask && (
        <div className="w-full flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-amber-300">進み具合を教えてください。</span>
          {ask.status === '未着手' && (
            <button disabled={busy} onClick={() => run('status', '進行中', '進行中にしました')} className="hud-press hud-mono text-[10px] px-2 py-0.5 border border-amber-400/50 rounded text-amber-200 hover:bg-amber-400/10 disabled:opacity-40">
              着手した
            </button>
          )}
          {[0.25, 0.5, 0.75].map((n) => (
            <button key={n} disabled={busy} onClick={() => run('progress', String(n), `進捗を ${n * 100}% にしました`)} className="hud-press hud-mono text-[10px] px-2 py-0.5 border border-amber-400/30 rounded text-amber-200/80 hover:bg-amber-400/10 disabled:opacity-40">
              {n * 100}%
            </button>
          ))}
        </div>
      )}
      <span className="hud-mono text-[10px] text-zinc-500">{taskId}</span>
      <input
        type="date" value={date} onChange={(e) => setDate(e.target.value)}
        className="hud-mono text-[11px] bg-transparent border border-zinc-600/40 rounded px-1.5 py-0.5 text-zinc-300"
      />
      <button
        disabled={busy || !date}
        onClick={() => run('dueDate', date, `期限を ${date.replace(/-/g, '/')} にしました`)}
        className="hud-press hud-mono text-[10px] px-2 py-0.5 border border-sky-400/40 rounded text-sky-300 hover:bg-sky-400/10 disabled:opacity-40"
      >
        期限をこの日に延ばす
      </button>
      <button
        disabled={busy || !date}
        onClick={() => {
          setBusy(true); setMessage(null);
          holdFdpTask(taskId, date, '', '本人（通知センター）')
            .then(() => { setMessage(`${date.replace(/-/g, '/')} まで保留にしました。`); onChanged(); })
            .catch((err: any) => setMessage(err?.message ?? String(err)))
            .finally(() => setBusy(false));
        }}
        className="hud-press hud-mono text-[10px] px-2 py-0.5 border border-zinc-600/40 rounded text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
      >
        この日まで保留
      </button>
      {confirmDone ? (
        <>
          <button disabled={busy} onClick={() => run('status', '完了', '完了にしました')} className="hud-press hud-mono text-[10px] px-2 py-0.5 border border-emerald-400/50 rounded text-emerald-200 hover:bg-emerald-400/10">
            本当に完了にする
          </button>
          <button onClick={() => setConfirmDone(false)} className="hud-mono text-[10px] text-zinc-500 hover:text-zinc-300">やめる</button>
        </>
      ) : (
        <button disabled={busy} onClick={() => setConfirmDone(true)} className="hud-press hud-mono text-[10px] px-2 py-0.5 border border-zinc-600/40 rounded text-zinc-400 hover:text-zinc-200">
          完了にする
        </button>
      )}
      {message && <span className="text-[11px] text-sky-300 w-full">{message}</span>}
    </div>
  );
}

/** 改善の一件。確認が要るものだけが大きく出て、ほかは一行。細部は「詳細」の中。 */
function FindingCard({ f, onDismiss, onChanged }: { f: SelfFinding; onDismiss: (id: string) => void; onChanged: () => void }) {
  const status = STATUS_LABEL[f.status];
  const v = f.verification;
  const protectedHits: Array<{ file: string; why: string }> = v?.protectedHits ?? [];
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const awaiting = f.status === 'awaiting_approval' && !!v;

  const approve = () => {
    setBusy(true);
    setMessage(null);
    approveFinding(f.id, understood)
      .then((r) => { setMessage(`反映しました（${r.head}）。まもなく再起動します。`); onChanged(); })
      .catch((err: any) => setMessage(err?.message ?? String(err)))
      .finally(() => setBusy(false));
  };

  if (!awaiting) {
    return (
      <div className="flex items-baseline gap-2 text-[12px] text-zinc-400 py-0.5">
        <span className="flex-shrink-0 text-zinc-500">{status.text}</span>
        <span className="truncate">{plainTitle(f.title)}</span>
        <span className="ml-auto flex-shrink-0 text-zinc-600">{ago(f.lastSeen)}</span>
      </div>
    );
  }

  const checksOk = (v.steps ?? []).every((st: any) => st.ok);
  return (
    <div className="px-3 py-3 rounded-lg border border-[var(--hud-line)] space-y-2">
      <div className="text-[14px] text-zinc-100 leading-snug">{plainTitle(f.title)}</div>
      {f.evidence[0] && <div className="text-[12px] text-zinc-400 leading-snug line-clamp-2">{f.evidence[0]}</div>}
      <div className="text-[12px] text-zinc-400">
        IRIS が直しました。{checksOk ? '検査はすべて通っています。' : '検査に通らないものがあります。'}
        反映するまで、いまの IRIS には入りません。
      </div>
      {protectedHits.length > 0 && (
        <div className="rounded border border-rose-400/50 bg-rose-500/10 px-2 py-1.5 space-y-1">
          <div className="text-[12px] text-rose-200">自分を監督するコードに触れています</div>
          {protectedHits.map((h) => <div key={h.file} className="text-[11px] text-rose-200/80">{h.file} — {h.why}</div>)}
          <label className="flex items-center gap-1.5 text-[11px] text-rose-100 pt-0.5">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            理解した上で反映する
          </label>
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={approve} disabled={busy || !checksOk || (protectedHits.length > 0 && !understood)}
          className="hud-press text-[12px] px-3 py-1 border border-zinc-400/40 rounded-lg text-zinc-100 hover:bg-white/5 disabled:opacity-40">
          {busy ? '反映中…' : '反映する'}
        </button>
        <button onClick={() => onDismiss(f.id)} className="hud-press text-[12px] px-3 py-1 border border-zinc-600/40 rounded-lg text-zinc-400 hover:text-zinc-200">見送る</button>
      </div>
      {message && <div className="text-[12px] text-zinc-300">{message}</div>}
      <details className="text-[11px] text-zinc-500">
        <summary className="cursor-pointer select-none">詳細（変えたファイル {v.files?.length ?? 0} 件）</summary>
        <div className="mt-1 space-y-0.5">
          {(v.steps ?? []).map((st: any) => (
            <div key={st.name}>{st.name === 'typecheck' ? '型の検査' : st.name === 'tests' ? 'テスト' : st.name === 'build' ? 'ビルド' : st.name}：{st.ok ? '通過' : '失敗'}</div>
          ))}
          {(v.files ?? []).slice(0, 8).map((x: string) => <div key={x}>{x}</div>)}
          {(v.commits ?? []).slice(0, 3).map((c: string) => <div key={c}>{c}</div>)}
          <div>反映すると、画面を作り直して IRIS が再起動します。</div>
        </div>
      </details>
    </div>
  );
}

/** 通知センターが開いているとき、左に取る幅。会話の画面はこの分だけ右へ寄る。 */
/** 右端のレール（天気・時計・お知らせの縦の帯）に重ならないための空き。 */
export const CENTER_RAIL_GAP = '76px';

const EVENT_LABELS: Record<string, string> = {
  'weather.ok': '天気を取得', 'weather.failed': '天気を取得できなかった', 'weather.unreadable': '天気を読めなかった',
  'finance.gmail_auto': 'メールから家計を更新', 'gmail.refreshed': 'Gmail を読み直した', 'model.verified': 'モデルを確認',
  'mcp.connected': '外部ツールに接続', 'caldav.discovered': 'iCloud の予定を確認', 'backup.taken': 'バックアップを作成',
  'backup.config_copied': '設定を控えた', 'config.issue': '設定の注意', 'proactive.suggested': 'IRIS から提案',
  'caldav.expand_unsupported': 'iCloud の繰り返し予定を展開できなかった',
};
const CHECK_LABELS: Record<string, string> = {
  health: '本体が動いている', rail_data_fast: 'レールの表示が速い', center_snapshot: '通知センターが開ける',
  ui_build_served: '画面が最新', ui_deposit_roundtrip: '画面への指示が届く', calendar_readable: '予定が読める',
  lecture_divergence: '講義日程の食い違い', morning_brief_today: '今朝のまとめ', dev_tasks_not_orphaned: '宙に浮いた開発がない',
  external_tools_live: '外部ツールが使える',
};
const plainTitle = (t: string) => {
  const x = t.replace(/実機検査「([^」]+)」が落ちた/, (_m, n) => `動作チェック「${CHECK_LABELS[n] ?? n}」が通らなかった`)
    .replace(/「([a-z_.]+)」が 6 時間に (\d+) 回（warn）/, (_m, e, n) => `${EVENT_LABELS[e] ?? e} が ${n} 回続いた`);
  return x.length > 44 ? `${x.slice(0, 43)}…` : x;
};

export function NotificationCenter(props: {
  open: boolean;
  snapshot: CenterSnapshot | null;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onOpenConversation: (id: string) => void;
  /** 会話と並べて置く（画面が広いとき）。dockWidth は右のレール分の空きを含む幅（px）。 */
  docked?: boolean;
  dockWidth?: number;
}) {
  const { open, snapshot, error, onClose, onRefresh, onOpenConversation, docked, dockWidth } = props;
  const [tab, setTab] = useState<Tab>('today');
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all');

  const counts = snapshot?.counts;
  const badge = (id: Tab): number => {
    if (!counts) return 0;
    if (id === 'notices') return counts.unreadNotices;
    if (id === 'approvals') return counts.approvals;
    if (id === 'development') return counts.runningRuns;
    if (id === 'improve') return snapshot?.selfDev.findings.filter((f) => f.status === 'awaiting_approval').length ?? 0;
    if (id === 'system') return counts.problems;
    return 0;
  };

  // 画面が広いときは、会話と並べて右半分に置く（会話を覆わない）。狭い画面では上に重ねる。
  const paneWidth = dockWidth ? dockWidth - parseInt(CENTER_RAIL_GAP, 10) : null;
  return (
    <div
      className={docked ? 'order-last flex-shrink-0 h-full overflow-hidden' : `fixed top-0 right-0 h-full z-[60] ${open ? '' : 'pointer-events-none'}`}
      style={docked
        ? { width: open ? dockWidth : 0, paddingRight: open ? CENTER_RAIL_GAP : 0, transition: 'width 260ms cubic-bezier(0.4,0,0.2,1)' }
        : { width: 'min(100vw, 520px)' }}
      aria-hidden={!open}
    >
      <aside
        role="dialog"
        aria-label="通知センター"
        className="iris-calm h-full flex flex-col bg-[var(--hud-bg)] border-l border-[var(--hud-line)]"
        style={docked
          ? { width: paneWidth ?? undefined }
          : { width: '100%', transform: open ? 'translateX(0)' : 'translateX(110%)', transition: 'transform 220ms cubic-bezier(0.4,0,0.2,1)' }}
      >
        <header className="flex items-center gap-3 px-4 pt-4 pb-2">
          <span className="hud-label">通知センター</span>
          <span className="hud-mono text-[10px] text-zinc-600">
            {snapshot ? `${new Date(snapshot.generatedAt).toLocaleTimeString()} 更新` : '読み込み中…'}
          </span>
          <button onClick={onRefresh} title="いま読み直す" aria-label="読み直す" className="ml-auto p-1.5 text-zinc-500 hover:text-sky-400 transition">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={onClose} title="閉じる" aria-label="閉じる" className="p-1.5 text-zinc-500 hover:text-sky-400 transition">
            <X className="w-4 h-4" />
          </button>
        </header>

        {error && <div className="mx-4 mb-2 hud-mono text-[11px] text-rose-300">読み込めませんでした: {error}</div>}

        <nav className="flex gap-1 px-3 border-b border-[var(--hud-line)] overflow-x-auto">
          {TABS.map((t) => {
            const n = badge(t.id);
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`hud-press px-3 py-2 text-[13px] flex items-center gap-1.5 border-b-2 transition flex-shrink-0 ${
                  tab === t.id ? 'border-sky-400 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t.label}
                {n > 0 && <span className="hud-mono text-[10px] px-1.5 rounded-full bg-sky-400/20 text-sky-200">{n}</span>}
              </button>
            );
          })}
        </nav>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {!snapshot && !error && <Empty>読み込み中…</Empty>}

          {snapshot && tab === 'today' && (() => {
            const brief = (snapshot.today.brief?.text ?? '').replace(/\*\*/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
              .filter((l) => !/^おはよう|^こんにちは|^こんばんは/.test(l));
            // 「今日の予定／明日／次の試験」の見出しと中身を、一行ずつにまとめる。
            const rows: Array<[string, string]> = [];
            let head = '';
            for (const l of brief) {
              if (!l.startsWith('-') && !l.startsWith('・')) { head = l; continue; }
              const body = l.replace(/^[-・]\s*/, '');
              if (/提案|気にしておくこと|読めなかった/.test(head)) continue;
              if (/予定はありません/.test(body)) continue;
              rows.push([head, body]);
            }
            return (
              <div className="space-y-4">
                {snapshot.today.proposals.length === 0 && rows.length === 0 && <div className="text-[13px] text-zinc-400">今日、やることは特にありません。</div>}
                {snapshot.today.proposals.length > 0 && (
                  <ul className="space-y-2">
                    {snapshot.today.proposals.slice(0, 4).map((p) => (
                      <li key={p.id}>
                        <div
                          role={p.to ? 'button' : undefined}
                          onClick={() => p.to && setTab(p.to === 'notices' ? 'notices' : p.to === 'approvals' ? 'approvals' : p.to === 'development' ? 'development' : 'system')}
                          className={`px-3 py-2 rounded-lg border border-[var(--hud-line)] ${p.to ? 'hud-press cursor-pointer hover:bg-white/[0.03]' : ''}`}
                        >
                          <div className="text-[14px] text-zinc-100 leading-snug">{p.text.replace(/ を進める$/, '')}</div>
                          {p.detail && <div className="text-[12px] text-zinc-500 mt-0.5 leading-snug line-clamp-2">{p.detail}</div>}
                          {p.taskId && (
                            <details className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                              <summary className="cursor-pointer select-none text-[12px] text-zinc-400">{p.ask ? '進み具合・期限を直す' : '期限・完了を直す'}</summary>
                              <TaskActions taskId={p.taskId} ask={p.ask} onChanged={onRefresh} />
                            </details>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {rows.length > 0 && (
                  <dl className="text-[13px] space-y-1">
                    {rows.slice(0, 5).map(([h, body], i) => (
                      <div key={i} className="flex gap-3">
                        <dt className="w-16 flex-shrink-0 text-zinc-500">{h.replace(/（.*$/, '')}</dt>
                        <dd className="text-zinc-300">{body}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {!snapshot.today.brief && <Empty>まとめを作れませんでした。</Empty>}
                {snapshot.today.couldNotRead.length > 0 && (
                  <div className="text-[12px] text-zinc-500">読めなかったもの: {snapshot.today.couldNotRead.join('、')}</div>
                )}
              </div>
            );
          })()}

          {snapshot && tab === 'notices' && snapshot.notices.some((n) => !n.replied && !n.read) && (
            <div className="flex items-center justify-between pb-1">
              <span className="text-[12px] text-zinc-500">未読があります</span>
              <button
                onClick={() => { void markAllNoticesRead().then(onRefresh); }}
                className="hud-press text-[12px] text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
              >
                すべて既読にする
              </button>
            </div>
          )}
          {snapshot && tab === 'notices' && (() => {
            if (snapshot.notices.length === 0) return <Empty>知らせはありません。</Empty>;
            const row = (n: typeof snapshot.notices[number]) => (
              <button
                key={`${n.conversationId}-${n.createdAt}`}
                onClick={() => onOpenConversation(n.conversationId)}
                className={`hud-press w-full text-left px-3 py-2 rounded-lg border border-[var(--hud-line)] hover:bg-white/[0.03] ${n.replied || n.read ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center gap-2">
                  {!n.replied && !n.read && <span className="w-1.5 h-1.5 rounded-full bg-zinc-200 flex-shrink-0" title="未読" />}
                  <span className="text-[13px] text-zinc-100 truncate">{n.title}</span>
                  <span className="text-[11px] text-zinc-600 ml-auto flex-shrink-0">{ago(n.createdAt)}</span>
                </div>
                {n.preview && <div className="text-[12px] text-zinc-500 mt-0.5 leading-snug line-clamp-1">{n.preview.split('\n')[0]}</div>}
              </button>
            );
            // 返事待ち・未読を先に、最大 8 件。済んだものは折りたたむ。
            const open = snapshot.notices.filter((n) => !n.replied && !n.read);
            const done = snapshot.notices.filter((n) => n.replied || n.read);
            const shown = open.slice(0, 8);
            const rest = [...open.slice(8), ...done];
            return (
              <div className="space-y-1.5">
                {shown.length === 0 && <div className="text-[13px] text-zinc-400">返事を待っているものはありません。</div>}
                {shown.map(row)}
                {rest.length > 0 && (
                  <details className="pt-1">
                    <summary className="cursor-pointer select-none text-[12px] text-zinc-500">読んだもの・返事したもの（{rest.length}）</summary>
                    <div className="mt-1.5 space-y-1.5">{rest.map(row)}</div>
                  </details>
                )}
              </div>
            );
          })()}

          {snapshot && tab === 'development' && (snapshot.stalledDev?.length ?? 0) > 0 && (
            <section className="mb-3">
              <div className="hud-label mb-1 text-amber-300">止まっている開発（{snapshot.stalledDev!.length}）</div>
              <div className="text-[12px] text-zinc-500 mb-1.5">進行中・計画中のまま、動いていないものです。理由を読んで、やめるか、もう一度動かすかを選べます。</div>
              <div className="space-y-1.5">
                {snapshot.stalledDev!.map((t) => (
                  <div key={t.id} className="px-3 py-2 rounded border border-amber-400/30">
                    <div className="flex items-center gap-2">
                      <Chip tone="warn">{t.status === 'planned' ? '計画中' : '進行中'}</Chip>
                      <span className="text-[13px] text-zinc-100 truncate">{t.title}</span>
                      {t.since && <span className="hud-mono text-[10px] text-zinc-600 ml-auto flex-shrink-0">{ago(t.since)}</span>}
                    </div>
                    <div className="text-[12px] text-zinc-400 mt-1">{t.reason}</div>
                    <div className="flex gap-2 mt-1.5">
                      <button onClick={() => { if (t.repo) void restartDevTask(t.id, t.agent, t.repo).then(onRefresh).catch(() => onRefresh()); }} disabled={!t.repo} className="hud-press hud-mono text-[10px] px-2 py-0.5 border border-sky-400/50 rounded text-sky-200 hover:bg-sky-400/10 disabled:opacity-40">もう一度動かす</button>
                      <button onClick={() => { void abandonDevTask(t.id).then(onRefresh); }} className="hud-press hud-mono text-[10px] px-2 py-0.5 border border-zinc-500/40 rounded text-zinc-300 hover:bg-white/5">やめる</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {snapshot && tab === 'development' && (() => {
            const devRuns = snapshot.runs.filter((r) => !(r.taskTitle ?? '').startsWith('自己開発'));
            if (devRuns.length === 0) return <Empty>開発の実行はまだありません。</Empty>;
            // 始めて 2 秒以内に止まったものは、押して止めたのではなく、起動できなかった試し（記録の名前が違っていた）。
            const failedStart = (r: typeof devRuns[number]) =>
              r.stopReason === 'spawn_failed' || (r.stopReason === 'stopped_by_user' && !!r.endedAt && Date.parse(r.endedAt) - Date.parse(r.startedAt) < 2000);
            const isRecent = (r: typeof devRuns[number]) => r.state === 'running' || (Date.now() - Date.parse(r.startedAt) < 3 * 86_400_000 && !failedStart(r));
            const recent = devRuns.filter(isRecent).slice(0, 8);
            const older = devRuns.filter((r) => !recent.includes(r));
            const card = (r: typeof devRuns[number]) => {
              const running = r.state === 'running';
              const done = r.stopReason === 'completed';
              return (
                <div key={r.id} className="px-3 py-2.5 rounded border border-[var(--hud-line)]">
                  <div className="flex items-center gap-2">
                    {running ? <Chip tone="live">実行中</Chip> : done ? <Chip tone="ok">完了</Chip> : failedStart(r) ? <Chip tone="warn">起動できなかった</Chip> : <Chip tone="bad">{STOP_REASON[r.stopReason ?? ''] ?? '停止'}</Chip>}
                    <span className="text-[13px] text-zinc-100 truncate">{r.taskTitle ?? '（題名なし）'}</span>
                    <span className="hud-mono text-[10px] text-zinc-600 ml-auto flex-shrink-0">{ago(r.startedAt)}</span>
                  </div>
                  <div className="hud-mono text-[10px] text-zinc-600 mt-1 flex flex-wrap gap-x-3">
                    <span>{r.agent}</span>
                    {r.branch && <span>{r.branch}</span>}
                    <span>{duration(r.startedAt, r.endedAt)}</span>
                    <span>{r.usd === null ? '費用は読めず' : `$${r.usd.toFixed(2)}`}</span>
                  </div>
                </div>
              );
            };
            return (
              <>
                {recent.length === 0 && <div className="text-[13px] text-zinc-400">ここ 3 日の実行はありません。</div>}
                {recent.map(card)}
                {older.length > 0 && (
                  <details className="pt-1">
                    <summary className="cursor-pointer select-none text-[12px] text-zinc-500">古い実行・起動できなかった試し（{older.length}）</summary>
                    <div className="mt-1.5 space-y-1.5">{older.map(card)}</div>
                  </details>
                )}
              </>
            );
          })()}
          {snapshot && tab === 'development' && snapshot.runs.some((r) => (r.taskTitle ?? '').startsWith('自己開発')) && (
            <div className="text-[12px] text-zinc-500">IRIS 自身の修正の実行 {snapshot.runs.filter((r) => (r.taskTitle ?? '').startsWith('自己開発')).length} 件は、「改善」にまとめています。</div>
          )}

          {snapshot && tab === 'improve' && (() => {
            const awaiting = snapshot.selfDev.findings.filter((f) => f.status === 'awaiting_approval');
            const others = snapshot.selfDev.findings.filter((f) => f.status !== 'awaiting_approval');
            const failing = snapshot.selfDev.checks?.results.filter((r) => !r.ok) ?? [];
            return (
              <div className="space-y-3">
                {awaiting.length === 0
                  ? <div className="text-[13px] text-zinc-400">確認してもらうものはありません。</div>
                  : <div className="text-[12px] text-zinc-500">IRIS が自分の不具合を直しました。反映してよいか、見てください。</div>}
                {awaiting.map((f) => <FindingCard key={f.id} f={f} onChanged={onRefresh} onDismiss={(id) => { void dismissFinding(id).then(onRefresh); }} />)}
                <div className="text-[12px] text-zinc-500">
                  {snapshot.selfDev.checks
                    ? failing.length === 0 ? '動作チェックは、すべて通っています。' : `動作チェックで通らないもの: ${failing.map((r) => CHECK_LABELS[r.name] ?? r.name).join('、')}`
                    : '動作チェックは、まだ行っていません。'}
                </div>
                {(others.length > 0 || snapshot.selfDev.recentlyDone.length > 0) && (
                  <details className="text-[12px]">
                    <summary className="cursor-pointer select-none text-zinc-500">調査中・見送りなど（{others.length + snapshot.selfDev.recentlyDone.length}）</summary>
                    <div className="mt-1.5 space-y-0.5">
                      {others.map((f) => <FindingCard key={f.id} f={f} onChanged={onRefresh} onDismiss={(id) => { void dismissFinding(id).then(onRefresh); }} />)}
                      {snapshot.selfDev.recentlyDone.map((f) => <FindingCard key={f.id} f={f} onChanged={onRefresh} onDismiss={() => {}} />)}
                    </div>
                  </details>
                )}
                {(snapshot.selfDev.enabled || snapshot.selfDev.paused) && (
                  <button onClick={() => { void pauseSelfDev(snapshot.selfDev.enabled).then(onRefresh); }} className="text-[11px] text-zinc-600 hover:text-zinc-300 underline underline-offset-2">
                    {snapshot.selfDev.enabled ? '自動で直す作業を止める' : '自動で直す作業を再開する'}
                  </button>
                )}
              </div>
            );
          })()}

          {snapshot && tab === 'approvals' && (
            snapshot.approvals.length === 0 ? <Empty>承認待ちはありません。</Empty> : snapshot.approvals.map((a) => (
              <button
                key={a.id}
                onClick={() => onOpenConversation(a.conversationId)}
                className="hud-press w-full text-left px-3 py-2.5 rounded border border-[var(--hud-line)] hover:bg-white/[0.03]"
              >
                <div className="text-[13px] text-zinc-100">{a.toolName}</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">{a.conversationTitle ?? '会話'} で待っています。押すと承認の画面へ。</div>
              </button>
            ))
          )}

          {snapshot && tab === 'system' && (
            !snapshot.system ? <Empty>状態を読めませんでした。</Empty> : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Chip tone={snapshot.system.status === 'healthy' ? 'ok' : 'warn'}>{snapshot.system.status === 'healthy' ? '稼働中' : snapshot.system.status === 'degraded' ? '一部に問題' : snapshot.system.status}</Chip>
                  <span className="text-[13px] text-zinc-300">応答に使っているモデル: {snapshot.system.activeProvider ?? '不明'}</span>
                </div>
                {(snapshot.providers?.length ?? 0) > 0 && (
                  <section>
                    <div className="hud-label mb-1">使えるモデル</div>
                    <ul className="space-y-1">
                      {snapshot.providers!.map((p) => (
                        <li key={p.key} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                          <Chip tone={p.available ? 'ok' : 'warn'}>{p.available ? '使える' : '止まっている'}</Chip>
                          <span className="text-zinc-200">{PROVIDER_LABEL[p.key] ?? (p.key.startsWith('gemini') ? 'Gemini（控え）' : p.key)}</span>
                          <span className="text-zinc-500">{p.model}</span>
                          {!p.available && (
                            <span className="text-amber-200">{REASON_LABEL[p.reason ?? ''] ?? p.message ?? '理由は不明'}{p.retryAt ? `（${new Date(p.retryAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} ごろ再開）` : ''}</span>
                          )}
                          {(p.spentTodayUsd > 0 || p.capUsd !== null) && (
                            <span className="text-zinc-500">今日 ${p.spentTodayUsd.toFixed(2)}{p.capUsd !== null ? ` ／ 上限 $${p.capUsd}` : ''}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                    <div className="text-[12px] text-zinc-500 mt-1.5">Max の月のクレジット（$100／$200）は、月末に失効します。残りは Anthropic Console の Billing（platform.claude.com/settings/billing）で確認できます。</div>
                  </section>
                )}
                {snapshot.system.problems.length > 0 && (
                  <section>
                    <div className="hud-label mb-1 text-amber-300">使えない連携（3 分以上続いたもの）</div>
                    <div className="text-[12px] text-zinc-500 mb-1.5">ネットが切れた直後や、スリープから戻った直後に出て、自然に消えることが多いものです。続いているなら、まず「いま確かめ直す」を。</div>
                    <button onClick={() => { void recheckCenter().then(onRefresh); }} className="hud-press text-[12px] px-3 py-1 border border-zinc-500/40 rounded-lg text-zinc-200 hover:bg-white/5 mb-2">いま確かめ直す</button>
                    <ul className="space-y-1">
                      {snapshot.system.problems.map((p: any) => (
                        <li key={p.id} className="text-[12px] text-zinc-400">
                          <span className="text-zinc-200">{p.label}</span>（{p.state}）{p.reason ? ` ${p.reason}` : ''}{p.guidance ? ` — ${p.guidance}` : ''}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {snapshot.system.usage && (
                  <section>
                    <div className="hud-label mb-1">今週使った割合</div>
                    <div className="grid grid-cols-2 gap-2 text-[12px] text-zinc-400">
                      <div>Claude 今週 <span className="text-zinc-100">{snapshot.system.usage.claude.week ?? '—'}%</span> ／ 5 時間 <span className="text-zinc-100">{snapshot.system.usage.claude.session5h ?? '—'}%</span></div>
                      <div>Codex 今週 <span className="text-zinc-100">{snapshot.system.usage.codex.week ?? '—'}%</span></div>
                    </div>
                  </section>
                )}
                <section>
                  <div className="hud-label mb-1">直近 1 時間に応答が止まった回数</div>
                  <div className="text-[12px] text-zinc-400">
                    {snapshot.system.stallsLastHour?.count ?? 0} 回（最長 {((snapshot.system.stallsLastHour?.longestMs ?? 0) / 1000).toFixed(1)} 秒）
                  </div>
                </section>
              </div>
            )
          )}

          {snapshot && tab === 'log' && (
            <>
              <div className="flex gap-1 pb-1">
                {(['all', 'warn', 'error'] as const).map((l) => (
                  <button
                    key={l}
                    onClick={() => setLevel(l)}
                    className={`hud-mono text-[10px] px-2 py-0.5 border rounded transition ${level === l ? 'text-sky-300 border-sky-400/40' : 'text-zinc-500 border-zinc-600/40 hover:text-zinc-300'}`}
                  >
                    {l === 'all' ? '全て' : l === 'warn' ? '警告' : 'エラー'}
                  </button>
                ))}
              </div>
              {snapshot.activity.filter((e) => level === 'all' || e.level === level).length === 0 ? <Empty>該当する記録はありません。</Empty> : (
                <ul className="space-y-0.5">
                  {snapshot.activity.filter((e) => level === 'all' || e.level === level).map((e, i) => (
                    <li key={`${e.at}-${i}`} className="hud-mono text-[11px] flex gap-2 leading-snug">
                      <span className="text-zinc-700 flex-shrink-0">{new Date(e.at).toLocaleTimeString()}</span>
                      <span className={e.level === 'error' ? 'text-rose-300' : e.level === 'warn' ? 'text-amber-300' : 'text-zinc-500'}>{EVENT_LABELS[e.event] ?? e.event}</span>
                      {e.message && <span className="text-zinc-400 truncate">{e.message}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
