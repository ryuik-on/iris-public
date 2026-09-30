import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Markdown } from './markdown';
import { NebulaCore, CoreState } from './NebulaCore';
import { useConversationDraft } from './useConversationDraft';
import { CopyAnswer } from './components/CopyAnswer';
import { ResponseStatus } from './components/ResponseStatus';
import { LanePicker } from './components/LanePicker';


/**
 * What the tools' arguments are called, for someone who did not write them.
 *
 * Only the ones that actually appear in an approval. A key with no entry falls
 * back to its own name, which is worse than a translation and better than a
 * guess at one.
 */
/**
 * A value that might be a sentence or might be an essay.
 *
 * An argument is whatever the caller put there, and one of them turned out to
 * be a multi-paragraph brief. Printed whole it buries every other field, and
 * truncated without recourse it hides the thing being agreed to. So: the first
 * few lines, and a way to see the rest.
 *
 * `whitespace-pre-wrap` because these arrive with their line breaks intact and
 * collapsing them turns a structured brief into one unreadable run — which is
 * what it looked like the first time.
 */
function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 180;
  if (!long) return <span className="whitespace-pre-wrap">{text}</span>;
  return (
    <div>
      <span className="whitespace-pre-wrap">{open ? text : text.slice(0, 180) + '…'}</span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ml-1.5 hud-mono text-[10px] text-sky-400/70 hover:text-sky-300"
      >
        {open ? '畳む' : `全文 ${text.length}字`}
      </button>
    </div>
  );
}

/**
 * The canvas, not the visible ring — the outer halo needs a margin of empty
 * canvas or it is clipped, and a clipped circle shows a flat chord. The ring
 * comes out at roughly 64% of this, so the visible core is a little over half
 * the short edge: large enough to be the subject of the screen, with the
 * centre still clear of the header and the input.
 */
/**
 * コアの差し渡し。**式は一つ。**
 *
 * 最初の値と、窓が変わったときの値が別々に書いてあり、**下限だけ 320 と 280
 * で食い違っていた。**同じものを二箇所で決めていると、片方だけ直す日が来る。
 *
 * 0.86 から 1.15 へ、上限も 1200 から 1600 へ（利用者、2026-09-07
 * 「コアもっと大きくして」）。**一より大きいのは意図的。**縁が地へ溶けていく
 * 絵なので、収まりきらない方が「切れている」ではなく「続いている」に見える。
 * 入力バーはその上に浮く —— 見本の絵もそうなっている。
 */
function coreSideFrom(width: number, height: number): number {
  return Math.round(Math.max(320, Math.min(1600, Math.min(width, height) * 1.15)));
}

function coreSizeFor(): number {
  if (typeof window === 'undefined') return 900;
  return coreSideFrom(window.innerWidth, window.innerHeight);
}
import {
  sendChatMessage,
  streamChatMessage,
  rememberToken,
  forgetToken,
  approveToolAction,
  fetchSettings,
  setLane,
  fetchRecentConversation,
  fetchConversation,
  listConversations,
  createConversation,
  ConversationSummary,
  StoredMessage,
  fetchContext,
  fetchSpeechStatus,
  fetchPendingApprovals,
  fetchOpeners,
  OpenerView,
  fetchRouting,
  fetchTts,
  fetchProactive,
  fetchBudget,
  fetchCliUsage,
  fetchFdpTasks,
  startListening,
  stopListening,
  drainTranscripts,
  speakText,
  stopSpeaking,
  acceptSuggestion,
  dismissSuggestion,
  ContextSnapshot,
  SpeechStatus,
  RoutingStatus,
  TtsStatus,
  ProactiveState,
  BudgetState,
  CliUsageState,
  FdpTasksReading,
  deleteConversation,
  searchMessages,
  SearchHit,
} from './api';
import {
  ContextPanel, SpeechPanel, RoutingPanel, VoicePanel, SuggestionsPanel,
  AccessPanel, DelegationPanel, TasksPanel, SchedulePanel, FinancePanel,
} from './components/Telemetry';
import {
  Send, ShieldAlert, Plus, MessageSquare, AlertTriangle, Volume2, Terminal, X,
  Mic, ArrowUp, Sparkles, History, SlidersHorizontal, Search,
} from 'lucide-react';

interface ViewMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  executedTools?: Array<{ name: string }>;
  /** Optimistic messages are replaced by the server's persisted copy. */
  pending?: boolean;
}


function toViewMessages(messages: StoredMessage[]): ViewMessage[] {
  return messages.map((m) => ({ id: m.id, role: m.role, content: m.content }));
}

/**
 * `?task=` は読み込み時に一度だけ読んで、URL からは消す。
 *
 * `useState` の初期化子で読んでいたが、App が組み直されると二度目は空に
 * なる（実測 2026-09-11：`task-T011` が見つからず、状態パネルも開かなかった）。
 * 部品の外で一度読めば、組み直しに左右されない。
 */
const TASK_FROM_URL: string | null = (() => {
  try {
    const id = new URLSearchParams(window.location.search).get('task');
    if (id) window.history.replaceState(null, '', window.location.pathname);
    return id;
  } catch {
    return null;
  }
})();

/**
 * 開く会話。盤のレールの「IRIS から」を押すと `?conversation=<id>` で来る。
 *
 * 読んだら URL から消す。**残すと、再読み込みのたびにその会話へ戻される。**
 * `task` と同じく部品の外で一度だけ読む（組み直しで二度目が空になるので）。
 */
const CONVERSATION_FROM_URL: string | null = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('conversation');
    if (id) {
      params.delete('conversation');
      const rest = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
    }
    return id;
  } catch {
    return null;
  }
})();

export default function App() {
  const [theme, setTheme] = useState<'mist' | 'night'>(() => {
    try { return localStorage.getItem('iris-theme') === 'night' ? 'night' : 'mist'; }
    catch { return 'mist'; }
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('iris-theme', theme); } catch {}
    window.dispatchEvent(new Event('iris-theme-change'));
  }, [theme]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  /** 「消す」に変わっている履歴。二段で確かめるための一段目。 */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** どちらの判断を押したか。押した釦だけが言葉を変えるため。 */
  const [deciding, setDeciding] = useState<boolean | null>(null);
  const { draft: input, setDraft: setInput, storageFailed: draftStorageFailed } = useConversationDraft(conversationId);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [pendingApproval, setPendingApproval] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  /** 出し先を選ぶ小窓が開いているか。 */
  const [lanesOpen, setLanesOpen] = useState(false);
  /**
   * Errors are surfaced transiently and never enter the message list.
   * They are persisted server-side in activity_logs, not in conversation
   * history, so a failed call cannot pollute what the model later reads back.
   */
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 144)}px`;
    document.documentElement.style.setProperty('--iris-composer-extra', `${Math.max(0, Math.min(field.scrollHeight, 144) - 24)}px`);
  }, [input]);

  // The ambient layer. Polled rather than pushed: these are all cheap reads of
  // in-process state, and a websocket for four small panels would be more
  // moving parts than the problem deserves.
  const [context, setContext] = useState<ContextSnapshot | null>(null);
  const [fdpTasks, setFdpTasks] = useState<FdpTasksReading | null>(null);
  // Parking a task changes the reading, and the reading is otherwise on a
  // five-minute clock — too slow to look like the button did anything.
  const reloadTasksRef = useRef<() => void>(() => {});
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  /**
   * A rough measure of how much is being heard, for the core to react to.
   *
   * The microphone is a helper process on the machine and its levels never
   * reach the browser, so amplitude is not available here. The partial
   * transcript growing is, and it is a real signal about a real thing rather
   * than an animation pretending to listen. It decays on its own, so a
   * transcript that stops growing settles rather than freezing at full.
   */
  /**
   * Which rail, if either, is open. Only one at a time — two open rails is the
   * old layout with extra steps.
   */
  const [chrome, setChrome] = useState<'none' | 'threads' | 'state'>('none');
  /**
   * `?task=T011` で開かれたとき、着地させる課題。
   *
   * 盤（⌥⌘D）の行を押すと番号付きの URL で IRIS が開く。**その番号を web は
   * 一度も読んでいなかった** —— 着いた先で探し直す作りだった（実測 2026-09-11）。
   * 読んだら消す：再読み込みのたびに同じ課題へ飛ばされるのは、開いた本人が
   * 望んだことではない。
   */
  const [focusTask, setFocusTask] = useState<string | null>(TASK_FROM_URL);
  /**
   * 読んでいる列を閉じたか。
   *
   * 「会話開くと閉じれない」（利用者、2026-09-07）。Escape の処理には
   * **「読んでいる面も含めて閉じる」と書いてあったが、閉じていたのは
   * 答えの欄だけ**で、コアの上に流れる会話そのものには誰も触っていなかった。
   * 一度開くと、履歴から別のものを開くか新しい履歴を始める以外に消す道が
   * 無い。どちらも「閉じる」ではない —— 別のものを開くのと、記録を一つ
   * 増やすこと。
   *
   * **消すのではなく、伏せるだけ。**会話は履歴に残り、次に打てば続きになる。
   */
  const [readingClosed, setReadingClosed] = useState(false);
  /**
   * 履歴の中を探す。
   *
   * 索引はサーバに前からあって（162通）、**どの画面も呼んでいなかった。**
   * 会話が百を超えると、題名の一覧から目で探すのは効かなくなる。
   *
   * `hits` が `null` は「まだ探していない」で、空配列は「探して0件」。
   * **混ぜると、打ち込む前から「見つかりません」と出る。**
   */
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);

  /**
   * The core is sized from the window, not fixed.
   *
   * It was 560px, which on a 2000px display is a detail in the middle of a lot
   * of nothing — 「画面比で小さすぎる」. Half the short edge makes it the
   * subject of the screen at any size, and the clamp keeps it from swallowing
   * a laptop display or vanishing on a phone.
   */
  const [coreSize, setCoreSize] = useState(() => coreSizeFor());
  /**
   * Narrow enough that a rail cannot take a column.
   *
   * On a desktop the rails push the conversation aside and there is room for
   * both. At 375px a 224px rail leaves 151px, which does not hold a core —
   * so on a phone they come over the top instead. Read from the same resize
   * listener the core size uses rather than a second one.
   */
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  const visor = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusTask) setChrome('state');
  }, [focusTask]);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /**
   * The core is sized from the clear space, not from the window.
   *
   * Taking it from `window.innerWidth` was what let it run under a column: the
   * number said there was room that the layout had already given away.
   * Observed rather than computed from the widths above, because the observer
   * also fires for the width transition and for anything that changes the
   * space without going through this component.
   */
  useEffect(() => {
    const element = visor.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      setCoreSize(coreSideFrom(width, height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [heardActivity, setHeardActivity] = useState(0);
  const lastPartialRef = useRef(0);
  const [routing, setRouting] = useState<RoutingStatus | null>(null);
  const [tts, setTts] = useState<TtsStatus | null>(null);
  const [proactive, setProactive] = useState<ProactiveState | null>(null);
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [cliUsage, setCliUsage] = useState<CliUsageState | null>(null);

  /**
   * The reply as it is being written.
   *
   * Held apart from `messages`, which is the record and only ever contains
   * what the server persisted. This is a view of a reply in flight; when the
   * turn finishes it is dropped and the same text is read back out of the
   * record, so there is one source of truth for anything durable and this
   * never becomes a second one.
   */
  const [streamText, setStreamText] = useState<string | null>(null);
  /**
   * What the run is doing, while it is doing it.
   *
   * Reported over the reply stream rather than polled: a tool call lasts a
   * couple of seconds and a two-second poll would report it roughly never.
   */
  const [runPhase, setRunPhase] = useState<'thinking' | 'tool_execution'>('thinking');
  const [lastProgress, setLastProgress] = useState(Date.now);
  const [sending, setSending] = useState(false);
  const responseStatusHost = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = responseStatusHost.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--iris-status-height', `${host.getBoundingClientRect().height}px`);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--iris-status-height');
    };
  }, []);
  /** Whether the reader has asked for the answer to take over the screen. */
  /**
   * Put away by hand, until there is something new to say.
   *
   * The panel had a width control and no way out: `answer` is the last
   * assistant message, so once anything had been said the column stayed for
   * the rest of the session and the core lived in what was left. Asked for
   * directly — "右の扉ってしまえないの？" — and the honest answer was no.
   *
   * Reset by a new reply rather than by a timer, because dismissing means
   * "I have read this", not "never show me answers".
   *
   * Starts closed. `answer` is the last thing the record holds, so opening
   * IRIS used to raise a column about whatever was said last time — an answer
   * to a question nobody remembers asking, taking a third of the screen away
   * from the thing you came to look at. It opens on the next reply, which is
   * the moment there is something new in it.
   */

  /**
   * Set when the server has refused this device for want of a token.
   *
   * Never set on the machine itself, where loopback is trusted and no part of
   * this appears. It is a phone, or another computer, being told to identify
   * itself once.
   */
  const [locked, setLocked] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState('');
  const [micBusy, setMicBusy] = useState(false);
  /** Off by default: an assistant that starts talking unprompted is a choice. */
  const [speakReplies, setSpeakReplies] = useState(false);

  const refreshConversationList = useCallback(async () => {
    try {
      const { conversations } = await listConversations();
      setConversations(conversations);
    } catch {
      /* sidebar is non-critical */
    }
  }, []);

  // Restore the most recently active thread on load (decision 8.2).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        /*
         * 頼まれた会話があればそれを。消えていたら（404）いつもどおり直近へ。
         * **開けなかったことを、別の会話を黙って出してごまかさない** —— 直近を
         * 出すのは同じだが、頼まれたものが無かったことは上に出す。
         */
        let view = null as Awaited<ReturnType<typeof fetchRecentConversation>> | null;
        if (CONVERSATION_FROM_URL) {
          try {
            view = await fetchConversation(CONVERSATION_FROM_URL);
            try {
              const seen = new Set(JSON.parse(localStorage.getItem('iris-openers-seen') ?? '[]'));
              seen.add(CONVERSATION_FROM_URL);
              localStorage.setItem('iris-openers-seen', JSON.stringify([...seen].slice(-100)));
            } catch { /* 覚えられなくても開ける */ }
          } catch (err: any) {
            if (err?.status === 401) throw err;
            setError('頼まれた会話が見つかりませんでした（消されたかもしれません）。直近の会話を出しています。');
          }
        }
        if (!view) view = await fetchRecentConversation();
        if (cancelled) return;
        if (view.conversation) {
          setConversationId(view.conversation.id);
          setMessages(toViewMessages(view.messages));
          setPendingApproval(view.pendingApproval);
        }
      } catch (err: any) {
        if (cancelled) return;
        /**
         * A refusal is a different thing from a failure.
         *
         * This is the first call the page makes, so it is where a device that
         * has not identified itself finds out. A stored token that has stopped
         * working is dropped here rather than left to fail every request
         * silently for the rest of the session.
         */
        if (err.status === 401) {
          /**
           * Only a token the server actively rejected is discarded.
           *
           * It used to be dropped on any 401 at all, including `missing` —
           * which is what the server says when nothing was presented. That
           * turned one request arriving without the header into a permanent
           * loss of the credential, and the person on the other end saw only
           * that they were being asked again.
           */
          if (err.code === 'wrong') forgetToken();
          setLocked(err.code === 'wrong' ? 'そのトークンは一致しませんでした。' : '');
          return;
        }
        setError(`状態の復元に失敗しました: ${err.message}`);
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    fetchSettings().then(setSettings).catch(() => {});
    refreshConversationList();
    return () => {
      cancelled = true;
    };
  }, [refreshConversationList]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Telemetry poll. Failures are swallowed on purpose — a panel that cannot
  // load is a missing panel, never an error banner over the conversation.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const [ctx, sp, rt, tt, pro, bud, cli] = await Promise.all([
        fetchContext().catch(() => null),
        fetchSpeechStatus().catch(() => null),
        fetchRouting().catch(() => null),
        fetchTts().catch(() => null),
        fetchProactive().catch(() => null),
        fetchBudget().catch(() => null),
        fetchCliUsage().catch(() => null),
      ]);
      if (cancelled) return;
      setContext(ctx);
      setSpeech(sp);
      setRouting(rt);
      setTts(tt);
      setProactive(pro);
      setBudget(bud);
      setCliUsage(cli);
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  /**
   * The task ledger, on its own much slower clock.
   *
   * It is not in the telemetry poll above because that runs every two seconds
   * and this one leaves the machine: it is a Google Sheet, fifteen seconds of
   * timeout away, holding rows that change on the order of days. Polling it at
   * the speed of a microphone indicator would be a request every two seconds
   * for a number that moves weekly.
   *
   * A network failure becomes `ok: false` rather than `null`. The two mean
   * different things to the panel — `null` is "not read yet" and shows a
   * spinner, `ok: false` says it could not be read and why. Swallowing this
   * one into `null` would leave the panel spinning forever, which reads as
   * "still loading" rather than "broken".
   */
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const reading = await fetchFdpTasks().catch((err: Error) => ({
        ok: false as const,
        error: err?.message ?? '課題台帳に接続できませんでした。',
        readAt: new Date().toISOString(),
      }));
      if (!cancelled) setFdpTasks(reading);
    };
    load();
    reloadTasksRef.current = load;
    const timer = setInterval(load, 300_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    const length = speech?.partial?.length ?? 0;
    const grew = Math.max(0, length - lastPartialRef.current);
    lastPartialRef.current = length;
    if (grew > 0) setHeardActivity((v) => Math.min(1, v + Math.min(0.6, grew / 12)));
  }, [speech?.partial]);

  useEffect(() => {
    const decay = setInterval(() => setHeardActivity((v) => (v < 0.01 ? 0 : v * 0.72)), 160);
    return () => clearInterval(decay);
  }, []);

  // ⌘\ for the threads, ⌘' for the state. Escape closes whatever is open,
  // the reading column included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The reading surface first — column on a desktop, layer on a phone.
        // It is the thing covering the most, and pressing Escape twice to
        // clear two layers is what people expect.
        // 読んでいる列も。ここが抜けていたので、上のコメントが嘘になっていた。
        setReadingClosed(true);
        return setChrome('none');
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '\\') { e.preventDefault(); setChrome((c) => (c === 'threads' ? 'none' : 'threads')); }
      if (e.key === "'") { e.preventDefault(); setChrome((c) => (c === 'state' ? 'none' : 'state')); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * Draining moved to the server, and this must not do it too.
   *
   * The rule it enforced — only what is addressed becomes a request — is
   * unchanged and now lives in `VoiceLoop`. What could not stay is the loop
   * itself: `speech.drain()` empties a queue, so two callers racing for it
   * means each utterance goes to whichever asked first. A sentence spoken to
   * IRIS would reach the server's loop or this one, unpredictably, and the half
   * that landed here would only work while a browser happened to be open.
   *
   * The window shows what the server heard instead. Same events, one consumer.
   */
  const [heard, setHeard] = useState<{ type: string; text?: string; reply?: string } | null>(null);
  useEffect(() => {
    if (speech?.state !== 'listening') return;
    let cancelled = false;
    const timer = setInterval(() => {
      fetch('/api/speech/voice')
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setHeard(d?.last ?? null); })
        .catch(() => {});
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [speech?.state]);

  /**
   * Approvals waiting in conversations other than this one.
   *
   * The approval dialog only appears as the result of a turn in the
   * conversation being looked at, which is right for the turn that raised it
   * and wrong for every other one. A dispatch queued from elsewhere — or from
   * the resident band — leaves a decision waiting that this screen never
   * mentions. The band said "承認待ちが2件あります" while the window it points
   * at showed nothing at all.
   */
  const [waiting, setWaiting] = useState<Array<{ id: string; toolName: string; conversationId: string; conversationTitle?: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchPendingApprovals()
        .then((d) => { if (!cancelled) setWaiting(d.pendingApprovals ?? []); })
        .catch(() => { if (!cancelled) setWaiting([]); });
    };
    load();
    const timer = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pendingApproval]);

  const [stripHeight, setStripHeight] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/hud/strip')
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setStripHeight(Number(d?.height) || 0); })
        .catch(() => { if (!cancelled) setStripHeight(0); });
    load();
    const timer = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const openConversation = async (id: string) => {
    /*
     * **押して何も起きない、を作らない。**
     *
     * 返事を待っているあいだは黙って戻っていたので、右上の「承認待ち」を
     * 押しても何も切り替わらなかった（利用者、2026-09-30）。いまの会話の
     * 返事が流れている途中で別の会話へ移ると、流れてきた文が行き場を失うので
     * 移らないのは正しいが、**移らない理由は言う。**
     */
    if (id === conversationId) { setReadingClosed(false); return; }
    if (loading) {
      setError('いまの返事を待っているあいだは、ほかの会話へ移れません。返事が出てから、もう一度押してください。');
      return;
    }
    setError(null);
    try {
      const view = await fetchConversation(id);
      setConversationId(id);
      // 開いたのだから、伏せた状態は解く。
      setReadingClosed(false);
      setMessages(toViewMessages(view.messages));
      setPendingApproval(view.pendingApproval);
    } catch (err: any) {
      setError(err.message);
    }
  };

  /**
   * IRIS から話しかけられたとき。
   *
   * 「そもそも IRIS 側から俺に聞いて欲しい」「IRIS との会話みたいな形が理想」
   * （利用者、2026-09-30）。サーバは提案が出ると IRIS の一言で会話を一本開く
   * （`server/core/opener.ts`）。ここはそれを**画面に出す側。**
   *
   * **手が空いていれば、その会話に切り替える。**打っている途中・返事を
   * 待っている途中・承認の途中・この一分に触っていたときは、切り替えずに
   * 入力欄の上に知らせを出す —— 読んでいるものを横から奪わない。
   *
   * 一度出したものは覚えておく（この端末で）。**同じ話で二度画面を奪わない。**
   */
  const [incoming, setIncoming] = useState<OpenerView | null>(null);
  const lastTouched = useRef(Date.now());
  const busy = useRef(false);
  busy.current = loading || sending || streamText !== null || input.trim().length > 0 || !!pendingApproval;
  const openRef = useRef(openConversation);
  openRef.current = openConversation;
  const speakRef = useRef(speakReplies);
  speakRef.current = speakReplies;
  const SEEN_KEY = 'iris-openers-seen';
  const seenOpeners = (): Set<string> => {
    try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')); } catch { return new Set(); }
  };
  const markOpenerSeen = (conversationId: string) => {
    try {
      const seen = [...seenOpeners(), conversationId].slice(-100);
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch { /* 覚えられなくても出すことはできる。次にもう一度出るだけ。 */ }
  };
  useEffect(() => {
    const touch = () => { lastTouched.current = Date.now(); };
    window.addEventListener('keydown', touch);
    window.addEventListener('pointerdown', touch);
    return () => {
      window.removeEventListener('keydown', touch);
      window.removeEventListener('pointerdown', touch);
    };
  }, []);
  useEffect(() => {
    if (restoring) return;
    let cancelled = false;
    let first = true;
    const load = () => {
      fetchOpeners()
        .then(({ openers }) => {
          if (cancelled) return;
          const seen = seenOpeners();
          const fresh = openers.find((o) => !o.replied && !seen.has(o.conversationId));
          if (!fresh) { setIncoming(null); return; }
          /*
           * 開いた直後は、まだ何も始めていないので空いているとみなす。
           * 以降は、この一分に触っていなければ空いている。
           */
          const idle = !busy.current && (first || Date.now() - lastTouched.current > 60_000);
          if (idle) {
            markOpenerSeen(fresh.conversationId);
            setIncoming(null);
            void openRef.current(fresh.conversationId);
            if (speakRef.current && fresh.text) void speakText(fresh.text).catch(() => {});
          } else {
            setIncoming(fresh);
          }
        })
        // 取れなくても会話は使える。**知らせが出ないだけで、話は消えていない**（履歴に残っている）。
        .catch(() => {})
        .finally(() => { first = false; });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoring]);

  /**
   * 履歴を一件消す。
   *
   * 消えたら履歴の一覧から外し、**いま開いているものだったら新しい履歴へ
   * 移る** — 消したものを開いたまま残すと、次に何か打ったときに戻せない
   * 場所へ書くことになる。
   */
  /**
   * 打つたびに探しに行かない。**止まってから。**
   *
   * 一文字ごとに投げると、索引に三度当たって最後の一回しか使わない。
   * 三文字未満はサーバが `tooShort` を返すので、こちらでは弾かない ——
   * **理由を出すのはサーバの側**で、ここで黙って捨てると「なぜ出ないか」が
   * 消える。
   */
  useEffect(() => {
    const text = query.trim();
    if (!text) { setHits(null); setSearchNote(null); return; }
    let active = true;
    setHits([]);
    setSearchNote('検索中…');
    const timer = setTimeout(() => {
      searchMessages(text)
        .then((r) => {
          if (!active) return;
          setHits(r.hits ?? []);
          setSearchNote(r.note ?? (r.hits?.length ? null : '一致する会話はありません。'));
        })
        .catch((e) => { if (active) { setHits([]); setSearchNote(e?.message ?? String(e)); } });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);

  const removeConversation = async (id: string) => {
    setConfirming(null);
    try {
      await deleteConversation(id);
    } catch {
      // 消せなかったなら、一覧はそのまま。**消えたように見せない。**
      return;
    }
    setConversations((list) => list.filter((c) => c.id !== id));
    if (id === conversationId) await startNewConversation();
  };

  const startNewConversation = async () => {
    if (loading) return;
    setError(null);
    try {
      const view = await createConversation();
      setConversationId(view.conversation!.id);
      setMessages([]);
      setPendingApproval(null);
      refreshConversationList();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSend = async (e?: React.FormEvent, spokenText?: string) => {
    if (e) e.preventDefault();
    // `spokenText` bypasses the input box: a voice request was already
    // addressed to IRIS by name, so it does not wait in the box for a press.
    const outgoing = (spokenText ?? input).trim();
    if (!outgoing || loading || restoring || pendingApproval) return;
    // 打てば読む。伏せたまま返事が来ると、届いていないように見える。
    setReadingClosed(false);

    const userText = outgoing;
    setError(null);
    /**
     * Asking opens the surface the answer will arrive on.
     *
     * It starts closed so that opening IRIS does not raise last week's reply,
     * and nothing reopened it — so an instruction sent from a phone was
     * answered into a panel with no way to see it. Measured: the message
     * landed at 13:36 and the reply was written at 13:37, and the screen
     * showed neither. Sending is the unambiguous moment somebody wants to
     * read what comes back.
     */
    /**
     * The question does not stay on screen.
     *
     * It used to be echoed back as a bubble the moment it was sent, which is
     * what a chat application does — and it made the centre a transcript with
     * the core behind it rather than the core being the thing you are talking
     * to. What was asked is in the record and in the threads rail; what is on
     * screen is IRIS, and then what IRIS said.
     */
    setStreamText('');
    setSending(true);
    setRunPhase('thinking');
    setLastProgress(Date.now());
    setLoading(true);

    try {
      // Only the current turn is sent; the server owns history and persistence.
      const res = await streamChatMessage(userText, conversationId, spokenText ? 'voice' : 'text', {
        accepted: () => { setSending(false); setLastProgress(Date.now()); },
        delta: (text) => { setLastProgress(Date.now()); setStreamText((prev) => (prev ?? '') + text); },
        // An attempt failed and is being retried; what it had written is void.
        reset: () => { setLastProgress(Date.now()); setStreamText(''); },
        phase: (name) => { setLastProgress(Date.now()); setRunPhase(name); },
      });
      if (spokenText === undefined) setInput('');
      setConversationId(res.conversationId);

      setMessages((prev) => {
        const persisted: ViewMessage[] = (res.persisted || []).map((m: StoredMessage) => ({
          id: m.id,
          role: m.role,
          content: m.content,
        }));
        const assistant = persisted.find((m) => m.role === 'assistant');
        if (assistant && res.executedTools?.length) {
          assistant.executedTools = res.executedTools;
        }
        return [...prev, ...persisted];
      });
      // The record now holds the finished text, so the in-flight copy goes.
      setStreamText(null);

      if (res.status === 'requires_approval') {
        setPendingApproval({ ...res.pendingApproval, sessionId: res.sessionId });
      }

      // Reading aloud is fire-and-forget: the reply is already on screen, so a
      // synthesis failure must not look like the message failed.
      // Spoken in, spoken out. Asking by voice and being answered in silence
      // is the interaction failing to complete; typing and being read at is
      // the opposite mistake. The toggle still forces it on for typed turns.
      if (speakReplies || spokenText) {
        const reply = (res.persisted || []).find((m: StoredMessage) => m.role === 'assistant');
        if (reply?.content) void speakText(reply.content).catch(() => {});
      }

      refreshConversationList();
    } catch (err: any) {
      // Whatever was streamed is not an answer; the turn is durable server-side.
      setStreamText(null);
      setError(spokenText === undefined
        ? `${err.message} 入力は残しています。送信済みの可能性もあるため、会話を確認してから再送してください。`
        : err.message);
      if (conversationId) {
        fetchConversation(conversationId)
          .then((view) => setMessages(toViewMessages(view.messages)))
          .catch(() => {});
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDecision = async (approved: boolean) => {
    if (!pendingApproval) return;
    setLastProgress(Date.now());
    setRunPhase('tool_execution');
    setLoading(true);
    setError(null);
    try {
      const res = await approveToolAction(pendingApproval.sessionId, approved);
      setPendingApproval(null);
      const persisted: ViewMessage[] = (res.persisted || []).map((m: StoredMessage) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        executedTools: res.executedTools,
      }));
      setMessages((prev) => [...prev, ...persisted]);
      if (res.status === 'requires_approval') {
        setPendingApproval({ ...res.pendingApproval, sessionId: res.sessionId });
      }
      refreshConversationList();
    } catch (err: any) {
      setError(err.message);
      // A stale approval means server state already moved on — resync.
      if (err.code === 'stale_approval') {
        setPendingApproval(null);
        if (conversationId) {
          fetchConversation(conversationId)
            .then((view) => {
              setMessages(toViewMessages(view.messages));
              setPendingApproval(view.pendingApproval);
            })
            .catch(() => {});
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const toggleMic = async () => {
    setMicBusy(true);
    setError(null);
    try {
      setSpeech(speech?.state === 'listening' ? await stopListening() : await startListening());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setMicBusy(false);
    }
  };

  const handleAccept = async (id: string) => {
    setError(null);
    try {
      const res = await acceptSuggestion(id, conversationId);
      if (res.ran && res.result) {
        setConversationId(res.result.conversationId);
        const persisted: ViewMessage[] = (res.result.persisted || []).map((m: StoredMessage) => ({
          id: m.id, role: m.role, content: m.content,
        }));
        setMessages((prev) => [...prev, ...persisted]);
        refreshConversationList();
      }
      setProactive(await fetchProactive().catch(() => null));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDismiss = async (id: string) => {
    try {
      await dismissSuggestion(id);
      setProactive(await fetchProactive().catch(() => null));
    } catch { /* the panel refreshes on the next tick anyway */ }
  };

  /**
   * What IRIS is doing, as one value.
   *
   * Four separate booleans were already on screen in four separate panels —
   * listening here, speaking there, a spinner somewhere else. Collapsing them
   * into one state is what lets a single element in the middle say all of it,
   * and it is the difference between a dashboard reporting flags and something
   * that looks like it is doing something.
   */
  const stream = useRef<HTMLDivElement | null>(null);
  const followStream = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    followStream.current = true;
    setShowLatest(false);
    const host = stream.current;
    if (host) host.scrollTop = host.scrollHeight;
  }, [conversationId, readingClosed]);
  const readingHost = useRef<HTMLDivElement | null>(null);

  /** 置き去りの確認を残さない。四秒で元に戻す。 */
  // 承認の欄が消えたら、押した記録も戻す。次に出たときに残っていない。
  useEffect(() => {
    if (!pendingApproval) setDeciding(null);
  }, [pendingApproval]);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  useEffect(() => {
    const host = stream.current;
    if (!host || !followStream.current) return;
    host.scrollTop = host.scrollHeight;
  }, [messages, streamText, readingClosed]);

  /**
   * いま最初に答えるもの。入力バーの「自動 · …」に出す。
   *
   * 順番は `provider_router` が決めていて、**使えないものは飛ばす。**
   * 一番目を出すのではなく**最初に使えるもの**を出すのは、gemini が枠切れの
   * 日に「自動 · Gemini」と書くと嘘になるから。読めなければ `null` で、
   * そのときは欄ごと出さない。
   */
  const firstAvailableProvider = (() => {
    // 会話の列を読む。既定の router は裏方の順番で、**会話の相手ではない。**
    const list: Array<{ vendor: string; available: boolean; priority: number }> =
      settings?.lanes?.text?.providers ?? routing?.providers ?? [];
    const live = list.filter((p) => p.available).sort((a, b) => a.priority - b.priority)[0];
    if (!live) return null;
    return live.vendor.charAt(0).toUpperCase() + live.vendor.slice(1);
  })();

  const chromeWidth = !narrow && chrome === 'threads' ? 224 : 0;
  const statePanelWidth = !narrow && chrome === 'state' ? 344 : 0;

  const coreState: CoreState =
    // Waiting on a person outranks everything: it is the one state where
    // nothing moves until they act.
    pendingApproval ? 'approval_required'
    : speech?.state === 'unavailable' ? 'offline'
    // The run says which of the two it is in; `loading` only says that one is
    // happening at all.
    : loading ? runPhase
    : tts?.speaking ? 'speaking'
    : speech?.state === 'listening' ? 'listening'
    : 'idle';
  // `tool_execution` is defined and drawable but never derived here: the run
  // reports which tools it used after the fact, and there is no signal for a
  // tool being in flight. Wiring it would mean the orchestrator emitting one.
  // Left unclaimed rather than approximated from `loading`, which would make
  // the ring say something it does not know.

  if (locked !== null) {
    /**
     * The whole interface, replaced by the one thing that has to happen first.
     *
     * Not a banner over a working screen: nothing behind this can load, so
     * showing it would be showing an empty shell with an explanation on top.
     * The token is on the Mac — the SYSTEM rail there prints it — and is typed
     * or pasted here once.
     */
    return (
      <div className="hud-field flex h-screen items-center justify-center font-sans text-[var(--hud-text)] px-6">
        <div className="hud-glow" />
        <form
          className="relative w-full max-w-[420px] flex flex-col items-center gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            const value = tokenDraft.trim();
            if (!value) return;
            rememberToken(value);
            // A reload rather than a retry: every panel starts its own polling
            // at mount and the simplest way to have them all try again is to
            // let them mount again.
            window.location.reload();
          }}
        >
          <div className="hud-mono text-[19px] tracking-[0.5em] text-sky-100/70" style={{ textIndent: '0.5em' }}>
            IRIS
          </div>
          <p className="text-[13px] leading-relaxed text-zinc-400 text-center">
            この端末からは、アクセストークンが必要です。
            <br />
            Mac の IRIS を開き、SYSTEM の一番下に表示されているものを入力してください。
          </p>
          <div className="hud-panel w-full flex items-center px-4 py-3 focus-within:border-sky-400/60 transition">
            {/* Sixteen pixels here too: this is the first field anyone
                touches on a phone, and Safari zooming the page at that moment
                is the worst possible first impression. */}
            <input
              type="password"
              autoFocus
              className="flex-1 bg-transparent border-none text-[16px] text-zinc-100 placeholder-zinc-600 focus:outline-none"
              placeholder="アクセストークン"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
            />
          </div>
          <button type="submit" className="hud-mono text-[12px] tracking-[0.3em] text-sky-300/70 hover:text-sky-200">
            接続
          </button>
          {locked !== '' && <p className="text-[12px] text-rose-300/80">{locked}</p>}
        </form>
      </div>
    );
  }

  return (
    <div
      className="hud-field flex h-screen font-sans text-[var(--hud-text)] overflow-hidden"
      /*
        Room for the resident band, when there is one.
        
        It floats above every window and macOS reserves nothing for it, so the
        top of this page would otherwise sit underneath — which is where the
        header lives. Asked for rather than assumed: the band reports its own
        height and stops reporting when it closes.
      */
      style={{ paddingTop: stripHeight ? `${stripHeight}px` : undefined }}
    >
      <div className="hud-glow" />
      {/*
        A way back to an answer that was put away.
        
        Dismissing is "I have read this", and the next reply brings the
        surface back on its own — but between those two moments there was no
        way to look again at what was already said. A single mark, in the same
        vocabulary as the two on the surface itself, at the edge it went to.
      */}
      {messages.length > 0 && readingClosed && (
        <button
          type="button"
          onClick={() => { followStream.current = true; setReadingClosed(false); }}
          title="会話を再開"
          aria-label="会話を再開"
          className="hud-fixed z-30 right-4 top-16 rounded-full px-3 py-2 text-[13px] bg-[var(--hud-panel)] text-[var(--hud-text)]"
        >
          会話を再開
        </button>
      )}

      {/*
        Behind everything, in the middle of the visor.

        A helmet HUD keeps the centre clear and pushes telemetry to the edges,
        which is the opposite of what this screen used to do: an empty middle
        with five bordered boxes around it. The conversation floats over this
        rather than beside it.
      */}
      <div
        ref={visor}
        className="hud-visor"
        style={{
          left: chromeWidth,
          right: statePanelWidth,
          transition: 'left 260ms cubic-bezier(0.4,0,0.2,1), right 260ms cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        <div
          className="relative flex items-center justify-center"
          /*
            Dimmed by the reading layer, not by having spoken.
            
            It used to fall to a quarter as soon as the conversation had any
            content, which is from when the middle of the screen was a
            transcript and the core was behind it. Now the core is what you are
            talking to and it stays lit through a conversation; it steps back
            only when a surface has come up in front of it and reading is the
            point.
          */
          /* And it stays lit. A quarter of an opacity is a way of removing
             something while pretending not to. */
          style={{
            opacity: 1,
            transition: 'opacity 520ms',
          }}
        >
          <NebulaCore state={coreState} activity={heardActivity} size={coreSize} />
          {/*
            The name lives here and nowhere else.

            It was in the top-left corner, which put the brand in the chrome
            and left the thing the brand refers to unlabelled — a header
            wordmark beside a model name reads as an app that runs a model. In
            the hollow it names what is actually on screen, and it is the only
            place it appears.

            The state under it is small and quiet on purpose: what state IRIS
            is in should be legible from the field before it is legible from
            the word, and the word is there for when it is not.

            One faint arc, and only one. The hollow has to hold two lines of
            text and it just got smaller; anything more than a single ring
            starts competing with them for a space that is already tight.
          */}
          {/* Hidden outright once a reading surface is up, rather than left to
              the ground above it to cover. On a tall screen the surface starts
              higher relative to the core and the name showed through the
              paragraphs — and it is redundant there anyway: nobody reading an
              answer needs to be told whose it is. */}
          {/*
            中央には何も置かない（2026-09-05）。

            名前も外した。**輪だけが印になる。**

            部品を消し、二行目を消し、最後に名前も消した — 順に外していって
            残ったのは、外していく判断の方が毎回正しかったという事実。中心に
            置いたものはどれも、置いた瞬間に「輪の上に貼られたもの」になって
            いた。空洞は**輪が囲んでいる静けさ**であって、何かを入れる場所
            ではない。

            消したのではなく `false &&` で止めてある。名前の書式も、状態の
            行も、そのまま下に残っている。
          */}
          {/*
           * 中央には何も置かない。**そう決めた**（利用者、2026-09-05）。
           *
           * ここには名前と状態の行があった。名前は四度作り直している ——
           * 部品と二行の文字、粒で書いたもの、書体を打ったもの、作図して
           * 場の光で塗ったもの。どれも中央に馴染まなかった。
           *
           * 止めるだけにして `false &&` で残していたが、**止めたものを
           * 残しておくと、次に見た者が「なぜ止まっているのか」から始める。**
           * 消す。作図の実装は `Core.tsx` の履歴にあり、要るときは
           * `ad5befd` から取れる（`Core.tsx` 自体も履歴にだけある —— `ab9eedf`）。
           */}
        </div>
      </div>
      {/*
        Both rails are hidden by default now.

        They were a 224px column of thread titles and a 288px column of five
        bordered panels, always on, always at the same weight as each other and
        as the conversation. That is what made the screen read as a generated
        dashboard: nothing was more important than anything else, because
        everything was equally present. A helmet keeps the middle clear.

        Nothing is removed — both are one key away, and the conversation is
        still the thing in front of you when they are closed.
      */}
      {/* A scrim, on a phone only. A rail over the conversation needs
          somewhere to press that means "close", and on a narrow screen the
          rail covers most of the way to the edge. */}
      {narrow && chrome !== 'none' && (
        <div
          className="fixed inset-0 z-30 bg-black/50"
          onClick={() => setChrome('none')}
          aria-hidden="true"
        />
      )}
      <aside
        id="iris-history-panel"
        aria-hidden={chrome !== 'threads'}
        aria-label="会話履歴"
        className={`iris-side-panel flex flex-col border-r border-[var(--hud-line)] overflow-hidden bg-[var(--hud-bg)] ${
          narrow ? 'inset-y-0 left-0 z-40' : 'flex-shrink-0'
        }`}
        style={
          narrow
            ? {
                /* Inline, because `.hud-field > * { position: relative }` in
                   the stylesheet outranks a Tailwind `.fixed` class. The rail
                   took its overlay width and stayed in the flow, pushing the
                   conversation off the side of a 375px screen — the worst of
                   both arrangements. */
                position: 'fixed' as const,
                width: 'min(84vw, 320px)',
                transform: chrome === 'threads' ? 'translateX(0)' : 'translateX(-100%)',
                transition: 'transform 260ms cubic-bezier(0.4,0,0.2,1)',
                paddingTop: 'env(safe-area-inset-top)',
                paddingBottom: 'env(safe-area-inset-bottom)',
              }
            : { width: chrome === 'threads' ? 224 : 0, transition: 'width 260ms cubic-bezier(0.4,0,0.2,1)' }
        }
      >
        <div className="h-16 px-3 flex items-center justify-between border-b border-[var(--hud-line)]">
          <span className="hud-label">履歴</span>
          <div className="flex items-center gap-1">
            <button
              onClick={startNewConversation}
              title="新しい履歴を始める"
              aria-label="新しい履歴を始める"
              className="hud-press p-1 text-zinc-500 hover:text-sky-400 transition"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            {/*
              A way out, on the surface that has none.
              
              On a phone this rail covers most of the screen and slides in
              from the left; the only way back was the dimmed strip beside it,
              which does not look like a control. The rail is the thing in
              front, so the control belongs on it.
            */}
            {narrow && (
              <button
                onClick={() => setChrome('none')}
                title="閉じる"
                aria-label="閉じる"
                className="p-1 text-zinc-500 hover:text-sky-400 transition"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
        {/*
          履歴の中を探す口。
          
          題名の一覧だけでは、会話が百を超えると目で探せない。索引はサーバに
          前からあり（162通）、**呼ぶ側が無かっただけ。**
        */}
        <div className="px-2 pt-2">
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-white/[0.03] focus-within:bg-white/[0.05] transition">
            <Search className="w-3 h-3 text-zinc-600 flex-shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="話した中を探す"
              aria-label="会話履歴を検索"
              type="search"
              className="flex-1 bg-transparent border-none text-[12px] text-zinc-200 placeholder-zinc-600 focus:outline-none min-w-0"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="検索をクリア"
                className="text-zinc-600 hover:text-zinc-300 transition flex-shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {/*
            探しているあいだは、履歴の一覧を出さない。**二つの一覧が同じ場所に
            並ぶと、どちらを見ているのか分からなくなる。**
          */}
          {hits !== null ? (
            <>
              {/* サーバの言い分をそのまま出す。「0件」と「短すぎる」は別のこと。 */}
              {searchNote && (
                <div className="hud-mono text-[11px] text-zinc-600 px-1 py-1.5">{searchNote}</div>
              )}
              {hits.map((h) => (
                <button
                  key={h.messageId}
                  onClick={() => { void openConversation(h.conversationId); setQuery(''); }}
                  className="hud-press w-full text-left px-2 py-1.5 rounded hover:bg-white/[0.03] transition"
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="hud-mono text-[10px] text-sky-400/50 flex-shrink-0">
                      {h.role === 'user' ? '›' : '‹'}
                    </span>
                    <span className="text-[11px] text-zinc-500 truncate">
                      {h.conversationTitle || '無題'}
                    </span>
                    <span className="hud-mono text-[10px] text-zinc-700 ml-auto flex-shrink-0">
                      {h.createdAt.slice(5, 10).replace('-', '/')}
                    </span>
                  </div>
                  {/*
                    合った語はサーバが « » で囲って返す。印だけ外して、
                    その語を強める —— どこで当たったのかが分からないと、
                    開くかどうか決められない。
                  */}
                  <div className="text-[12px] text-zinc-300 leading-snug mt-0.5">
                    {h.snippet.split(/«([^»]*)»/).map((part, i) =>
                      i % 2 === 1
                        ? <mark key={i} className="bg-transparent text-sky-300">{part}</mark>
                        : <span key={i}>{part}</span>
                    )}
                  </div>
                </button>
              ))}
            </>
          ) : (
            <>
          {conversations.length === 0 && (
            <div className="hud-mono text-[12px] text-zinc-700 px-1 py-2">記録なし</div>
          )}
          {/*
            中身の無い履歴は出さない。
            
            「無題」が並んでいたので題名を付け損ねたのかと思ったが、**六件とも
            0メッセージ**だった — 「新しい履歴」を押して何も打たなかったもの。
            **戻る先が無いものを、戻る先の一覧に置かない。**

            いま開いているものだけは残す。作った直後に消えると、これから
            打とうとしている場所が視界から消える。
          */}
          {conversations
            .filter((c) => c.messageCount > 0 || c.id === conversationId)
            .map((c) => {
            const active = c.id === conversationId;
            const asking = confirming === c.id;
            return (
              <div
                key={c.id}
                className={`group relative border-l-2 ${
                  active
                    ? 'border-sky-400 bg-sky-400/5'
                    : 'border-transparent hover:bg-white/[0.02]'
                }`}
              >
                <button
                  onClick={() => openConversation(c.id)}
                  className={`hud-press w-full text-left px-2 py-1.5 pr-7 text-[13px] transition ${
                    active ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <MessageSquare className="w-3 h-3 flex-shrink-0 opacity-50" />
                    <span className="truncate">{c.title || '無題'}</span>
                  </div>
                  <div className="hud-mono mt-0.5 text-[9px] text-zinc-700 truncate pl-4.5">
                    {c.messageCount} · {new Date(c.updatedAt).toLocaleDateString()}
                  </div>
                </button>
                {/*
                  消すのは二段。**一段では、開こうとした指が消してしまう。**
                  一度目で釦が「消す」に変わり、二度目で消える。四秒で戻る
                  ので、置き去りの確認が残らない。
                */}
                <button
                  onClick={() => (asking ? removeConversation(c.id) : setConfirming(c.id))}
                  title={asking ? 'もう一度押すと消えます' : 'この履歴を消す'}
                  aria-label={asking ? 'もう一度押すと消えます' : 'この履歴を消す'}
                  className={`hud-press absolute right-1 top-1.5 px-1 py-0.5 rounded text-[10px] transition ${
                    asking
                      ? 'text-[var(--hud-warn)] opacity-100'
                      : 'text-zinc-600 hover:text-zinc-300 opacity-0 group-hover:opacity-100 focus:opacity-100'
                  }`}
                >
                  {asking ? '消す' : '×'}
                </button>
              </div>
            );
          })}
            </>
          )}
        </div>
      </aside>

      {/*
        Beside Threads, not opposite it.

        Both were chrome and they sat on opposite edges, so the core had a
        column taken off each side and the reply came up on top of what was
        left. One side holds everything that is *about* the conversation; the
        other holds the reply itself; the middle is left for the core and
        nothing is allowed into it.
      */}
      <aside
        id="iris-state-panel"
        aria-hidden={chrome !== 'state'}
        aria-label="IRISの状態"
        className={`iris-side-panel order-last border-l border-[var(--hud-line)] overflow-y-auto overflow-x-hidden space-y-3 bg-[var(--hud-bg)] ${
          chrome === 'state' ? 'p-3' : 'p-0'
        } ${
          narrow ? 'inset-y-0 right-0 z-40' : 'flex-shrink-0'
        }`}
        style={
          narrow
            ? {
                position: 'fixed' as const,
                width: 'min(88vw, 340px)',
                transform: chrome === 'state' ? 'translateX(0)' : 'translateX(100%)',
                transition: 'transform 260ms cubic-bezier(0.4,0,0.2,1)',
                paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)',
                paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)',
              }
            : { width: statePanelWidth, paddingRight: chrome === 'state' ? 68 : 0, transition: 'width 260ms cubic-bezier(0.4,0,0.2,1)' }
        }
      >
        {/*
          Progress, money and the coding-tool allowance are not here any more.

          They were in this rail and on the dashboard at once, which meant one
          copy was always the stale one — and the dashboard is a keystroke away
          and floats over every application, so opening this window to see the
          same numbers was never the shorter route. What stays is what exists
          nowhere else: the conversation's own context, topics, voice, routing,
          the delegation terms and the access token.
        */}
        {/*
          A way out, on the rail itself.
          
          The history rail got one and this did not, and on a phone it covers
          almost the whole screen — so the panel that shows what IRIS has been
          delegated was the one with no way back. The close sits inside the
          scrolling column rather than above it because this rail has no
          header to put it in; it is the first thing in the list, which is
          where a thumb arrives.
        */}
        {narrow && chrome === 'state' && (
          <div className="flex items-center justify-between pb-1">
            <span className="hud-label">状況</span>
            <button
              onClick={() => setChrome('none')}
              title="閉じる"
              aria-label="閉じる"
              className="p-1 text-zinc-500 hover:text-sky-400 transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <ContextPanel snapshot={context} />
        {/*
          予定は課題の上。**今日これから何があるかの方が、期限が先の課題より
          先に読まれる。**サーバの `/api/schedule` は最初からあったのに、
          画面が一度も呼んでいなかった。
        */}
        <SchedulePanel />
        <SuggestionsPanel state={proactive} onAccept={handleAccept} onDismiss={handleDismiss} />
        <TasksPanel reading={fdpTasks} onChanged={() => reloadTasksRef.current()} focusId={focusTask} onFocused={() => setFocusTask(null)} />
        {/*
          家計。**サーバには最初からあった集計を、初めて読む。**
          個別の取引は読まない — そちらは `local_only` の印が付いていて、
          画面にも模型にも渡さないと決めてある側。
        */}
        <details className="iris-secondary-settings">
          <summary className="cursor-pointer py-3 text-[13px] text-[var(--hud-text)]">その他の設定・情報</summary>
          <div className="space-y-3">
        <DelegationPanel />
        <AccessPanel />
        <FinancePanel />
        <SpeechPanel status={speech} onStart={toggleMic} onStop={toggleMic} busy={micBusy} />
        <VoicePanel tts={tts} onStop={() => { void stopSpeaking(); }} />
        <RoutingPanel routing={routing} />
          </div>
        </details>
      </aside>

      {/* Centre: the conversation. */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* The notch, and one line for every control. The three buttons were
            56, 48 and 22 tall at three different heights, which on a wide
            screen is untidy and at 375px reads as broken. */}
        <header
          className="iris-toolbar px-3 sm:px-5 flex items-center justify-between border-b border-[var(--hud-line)] flex-shrink-0"
          style={{ height: 'calc(3.5rem + env(safe-area-inset-top))', paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div className="flex items-center gap-2.5">
            {/* The rails are one press away and say which press. A shortcut
                nobody can see is a feature nobody has. */}
            {/*
              The rails are one press away and say which press. A shortcut
              nobody can see is a feature nobody has.

              The mark stays small and the target does not: these were 24x20
              and needed aiming at. The glyph is unchanged; the button around
              it is now large enough to hit without looking, which is the
              difference between a control and a decoration. Threads is the one
              reached for, so it gets the larger of the two.
            */}
            <button
              onClick={() => setChrome((c) => (c === 'threads' ? 'none' : 'threads'))}
              aria-label="会話履歴"
              aria-expanded={chrome === 'threads'}
              aria-controls="iris-history-panel"
              title="履歴　⌘\\"
              className={`hud-mono text-[14px] w-12 h-12 flex items-center justify-center transition ${
                chrome === 'threads' ? 'text-sky-300' : 'text-zinc-600 hover:text-zinc-400'
              }`}
            >
              <History className="w-[18px] h-[18px]" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setChrome((c) => c === 'state' ? 'none' : 'state')}
              title="IRISの状態　⌘'"
              aria-label="IRISの状態"
              aria-expanded={chrome === 'state'}
              aria-controls="iris-state-panel"
              className="w-12 h-12 flex items-center justify-center text-[var(--hud-muted)]"
            >
              <SlidersHorizontal className="w-[18px] h-[18px]" />
            </button>
            <button
              type="button"
              onClick={() => setTheme(t => t === 'mist' ? 'night' : 'mist')}
              aria-label={theme === 'mist' ? '夜の配色に切り替える' : '明るい配色に切り替える'}
              title={theme === 'mist' ? '夜の配色に切り替える' : '明るい配色に切り替える'}
              className="w-12 h-12 flex items-center justify-center text-[18px] text-[var(--hud-muted)]"
            >
              {theme === 'mist' ? '☾' : '☀'}
            </button>
            {/* Reading replies aloud is opt-in, and says so rather than being
                a hidden preference. */}
            <button
              onClick={() => setSpeakReplies((v) => !v)}
              title={speakReplies ? '応答の読み上げを止める' : '応答を読み上げる'}
              className={`w-12 h-12 flex items-center justify-center transition ${speakReplies ? 'text-sky-400' : 'text-zinc-700 hover:text-zinc-500'}`}
            >
              <Volume2 className="w-4 h-4" />
            </button>
            {/*
              Money, only when it is not fine.
              
              This used to sit here permanently, which put the running cost of
              the machinery above the thing the machinery is for. But hiding it
              outright would put an overspend behind a drawer nobody has open —
              the precise shape of failure this project keeps finding. So it is
              absent while the verdict is ok and appears on its own the moment
              it is not, which is the only time it was ever worth the space.
            */}
            {/*
              A decision someone owes, in the one place that is always on
              screen. It sits before the money and the model because those are
              conditions to notice and this is a thing to do.
            */}
            {waiting.filter((w) => w.conversationId !== conversationId).length > 0 && (
              <button
                onClick={() => {
                  const first = waiting.find((w) => w.conversationId !== conversationId);
                  if (first) void openConversation(first.conversationId);
                }}
                title="承認を待っている操作があります。押すとその会話を開きます。"
                className="hud-mono text-[12px] px-2 py-1 border transition"
                style={{
                  borderColor: 'color-mix(in srgb, var(--hud-pending) 55%, transparent)',
                  color: 'var(--hud-pending)',
                }}
              >
                承認待ち {waiting.filter((w) => w.conversationId !== conversationId).length}
              </button>
            )}
            {budget && budget.verdict !== 'ok' && (
              <span
                className="hud-mono text-[13px] tracking-wide"
                title={budget.message}
                style={{
                  color: budget.verdict === 'deny' ? 'var(--hud-danger)' : 'var(--hud-warn)',
                }}
              >
                ${(budget.windows.find((w) => w.window === 'day')?.spentUsd ?? 0).toFixed(3)}
                <span className="text-zinc-700">
                  /${budget.windows.find((w) => w.window === 'day')?.limitUsd.toFixed(0)}
                </span>
              </span>
            )}

            {/*
              Codex's weekly allowance, beside the money but not mixed into it.
              One is dollars IRIS spent through its own keys and the other is a
              share of a flat-rate plan; side by side with a separator makes
              them two readings rather than one sum.

              Claude Code is absent here on purpose. It records no allowance
              anywhere local, so there is no equivalent number, and a blank is
              more honest than tokens dressed up as a limit. Its counts are in
              the state rail where there is room to say what they are.
            */}
            {/* Not on a phone: a number worth a glance on a wide screen and
                the brightest thing on a narrow one, where the rail is a tap
                away. */}
            {/*
              使用量は上の帯から外した。**レールにある。**

              `CODEX 16%/週 CLAUDE 8%/週` を出していたが、同じ数字がレールの
              輪と数字にもある。**同じ値が二箇所にあると、古い方がどちらか
              分からなくなる** — この一日で直してきたのがその形で、web に
              だけ残っていた。レールは常に画面にいるので、写しを置く理由が無い。
            */}
            {/*
              Which model served, only when that has become a question.
              
              IRIS routes across three vendors and the name of whichever one
              answered is an implementation detail — putting it permanently
              above the assistant's own name says the model is the product. But
              the router fails over silently, so when it has had to route
              around something, that stops being a detail and the name earns
              its place. Not connected at all earns it too.
            */}
            {(() => {
              const troubled = routing?.providers?.some((p) => !p.available || p.reason !== null);
              if (settings && !troubled) return null;
              return (
                <div className="flex items-center gap-1.5">
                  <span
                    className={`w-1.5 h-1.5 ${settings ? 'bg-amber-400 hud-pulse' : 'bg-zinc-700'}`}
                    style={{ borderRadius: 1 }}
                  />
                  <span
                    className="hud-mono text-[13px] tracking-wide text-zinc-500"
                    title={troubled ? '経路に問題があります。状態画面で確認できます。' : undefined}
                  >
                    {settings ? String(settings.activeModel) : '接続中'}
                  </span>
                </div>
              );
            })()}
          </div>
        </header>

        {/*
          The answer, and only the answer.

          What used to be here was a transcript: every turn as a bubble,
          alternating sides, stacked over the core. That is what a chat
          application looks like, and it made the core scenery behind a log.
          The record still holds every turn and the threads rail still reaches
          every conversation — but the middle of the screen is the thing you
          are talking to and the last thing it said.

          One piece of content in one component, with only the container
          around it changing between levels. That is what keeps the text from
          jumping, reflowing to the top, or disappearing at the moment it
          crosses from short to long — which it does mid-stream, while someone
          is reading it.
        */}
        <div ref={readingHost} className={`iris-reading-host flex-1 relative min-h-0 ${!readingClosed && (messages.length > 0 || streamText !== null) ? 'iris-reading-active' : ''}`}>
          {/*
            The conversation, over the core.

            Only the last reply was ever drawn, and never the question — so the
            screen showed an answer with nothing to say what it answered, and
            opening IRIS showed the previous conversation's reply with no way
            to tell. What was asked is half of what was said.

            `messages` has held the whole thing all along; nothing but the
            rendering was missing.

            No bubbles and no names. The user's own words sit smaller and
            dimmer with a mark in front, the reply reads at full size — which
            is the same difference a person makes between what they said and
            what they were told, and it costs no chrome.
          */}
          {/*
            伏せる押し場所。**Escape だけでは見つからない。**

            上のバーには ☰ と明るさと音しか無く、会話を開いた人が最初に探すのは
            そこ。鍵の組み合わせは知っている人にしか無いのと同じなので、
            画面に出す。**消えるのは表示だけ**で、会話は履歴に残る。
          */}
          {!readingClosed && (messages.length > 0 || streamText !== null) && (
            <button
              onClick={() => setReadingClosed(true)}
              title="会話を伏せる（Esc）"
              aria-label="会話を伏せる"
              className="hud-press absolute right-4 top-3 z-10 p-1.5 text-zinc-600 hover:text-sky-400 transition"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          {!readingClosed && (messages.length > 0 || streamText !== null) && (
            <div
              ref={stream}
              className="hud-scroll absolute inset-0 overflow-y-auto px-6"
              onScroll={(e) => {
                const el = e.currentTarget;
                const atLatest = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                followStream.current = atLatest;
                setShowLatest(!atLatest);
              }}
              style={{ paddingTop: 28, paddingBottom: 28 }}
            >
              <div className="mx-auto max-w-[720px] flex flex-col gap-5">
                {/*
                  最初が IRIS の発言なら、**誰が話しかけたのか**を一行で言う。
                  問いに答えた返事と同じ形で出ると、何を聞いたのか探すことになる。
                */}
                {messages[0]?.role === 'assistant' && (
                  <div className="hud-mono text-[11px] tracking-[0.06em] -mb-2" style={{ color: 'var(--hud-accent)' }}>
                    IRIS から
                  </div>
                )}
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="flex gap-2 text-[13px] leading-[1.7] text-zinc-500">
                      <span className="hud-mono text-sky-400/50 select-none">›</span>
                      <span className="whitespace-pre-wrap">{m.content}</span>
                    </div>
                  ) : (
                    /*
                      返事は `Markdown` を通す。`whitespace-pre-wrap` の生文字で
                      出したら、**`**` や `###` がそのまま画面に出た** — 右の欄が
                      ずっと通していたものを、こちらで素通ししていた。
                    */
                    <div key={m.id} className="text-[15px] leading-[1.85] text-zinc-200">
                      <Markdown text={m.content} />
                      <CopyAnswer text={m.content} />
                    </div>
                  )
                )}
                {/* 流れてきている途中の返事も、同じ場所に同じ形で。 */}
                {streamText !== null && streamText !== '' && (
                  <div className="text-[15px] leading-[1.85] text-zinc-200">
                    <Markdown text={streamText} />
                  </div>
                )}
              </div>
            </div>
          )}

          {restoring && (
            <div className="absolute inset-x-0 top-4 text-center hud-mono text-[12px] text-zinc-600">
              状態を復元中…
            </div>
          )}
          {showLatest && !readingClosed && (
            <button type="button"
              onClick={() => {
                followStream.current = true;
                setShowLatest(false);
                const host = stream.current;
                if (host) host.scrollTop = host.scrollHeight;
              }}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 rounded-full px-4 py-2 text-[13px] bg-[var(--hud-panel)] text-[var(--hud-text)] border border-[var(--hud-line)] shadow-sm">
              ↓ 最新へ
            </button>
          )}

        </div>


        {/* Clear of the home indicator. `viewport-fit=cover` puts the page
            under it by design, so the bar it sits in has to add that inset
            back or the field is partly beneath it. */}
        <form
          onSubmit={handleSend}
          className="hud-input-link absolute inset-x-0 bottom-0 z-20 px-4 pointer-events-none"
          style={{ paddingBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}
        >
          <div ref={responseStatusHost} className="flow-root mx-auto w-full max-w-[720px] pointer-events-auto">
      {incoming && incoming.conversationId !== conversationId && (
        <div className="mb-2 flex items-center gap-1.5" role="status">
          <button
            type="button"
            onClick={() => {
              markOpenerSeen(incoming.conversationId);
              setIncoming(null);
              void openConversation(incoming.conversationId);
            }}
            className="hud-press flex-1 min-w-0 flex items-center gap-2 rounded-full px-4 py-2 text-left text-[13px] bg-[var(--hud-panel)] text-[var(--hud-text)] border border-[var(--hud-line)] hover:border-[var(--hud-line-strong)]"
          >
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--hud-accent)' }} />
            <span className="hud-mono text-[11px] shrink-0" style={{ color: 'var(--hud-accent)' }}>IRIS から</span>
            <span className="truncate">{incoming.title ?? '話があります'}</span>
            <span className="ml-auto shrink-0 text-[var(--hud-muted)]">›</span>
          </button>
          <button
            type="button"
            aria-label="あとで見る"
            title="あとで見る（履歴には残ります）"
            onClick={() => { markOpenerSeen(incoming.conversationId); setIncoming(null); }}
            className="hud-press shrink-0 w-8 h-8 grid place-items-center rounded-full text-[var(--hud-muted)] hover:text-[var(--hud-text)]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {pendingApproval && (
        <div className="iris-approval mb-3" role="region" aria-labelledby="approval-heading">
          <div className="hud-panel rounded-[22px] w-full p-4 sm:p-5 flex flex-col gap-3 max-h-[min(48dvh,420px)]">
            <div className="flex items-center gap-2.5" style={{ color: 'var(--hud-pending)' }}>
              <ShieldAlert className="w-5 h-5" />
              <h3 id="approval-heading" className="text-[15px] font-medium text-[var(--hud-text)]">{(pendingApproval as any).heading ?? 'この操作を実行しますか？'}</h3>
            </div>
            <div className="space-y-3 overflow-y-auto hud-scroll min-h-0">
              {/*
                本文は**人に聞く文**（サーバの `approval_text.ts`）。道具の説明は模型に
                向けた取扱説明で、「provenance は user / measured / … から選び」のような
                文が承認する人の前に出ていた（利用者「人間が読む用の文章じゃない」、
                2026-09-30）。説明と生の引数は技術情報の中にだけ置く。
              */}
              <p className="text-[15px] text-[var(--hud-text)] leading-relaxed">
                {(pendingApproval as any).summary ?? `${pendingApproval.toolName} を実行しようとしています。`}
              </p>
              {Array.isArray((pendingApproval as any).facts) && (pendingApproval as any).facts.length > 0 && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                  {(pendingApproval as any).facts.map((f: { label: string; value: string }) => (
                    <React.Fragment key={f.label}>
                      <dt className="text-[var(--hud-muted)] whitespace-nowrap">{f.label}</dt>
                      <dd className="text-[var(--hud-text)] leading-relaxed break-words min-w-0"><LongText text={f.value} /></dd>
                    </React.Fragment>
                  ))}
                </dl>
              )}
              <details className="hud-mono text-[11px]">
                <summary className="cursor-pointer text-[var(--hud-muted)] hover:text-zinc-400">
                  技術情報
                </summary>
                {pendingApproval.description && (
                  <p className="mt-2 font-sans text-[12px] text-[var(--hud-muted)] leading-relaxed">
                    <span className="hud-mono">{pendingApproval.toolName}</span>：{pendingApproval.description}
                  </p>
                )}
                <pre className="mt-2 text-[var(--hud-muted)] overflow-x-auto p-2 bg-black/40 text-[11px] leading-relaxed">
                  {JSON.stringify({ tool: pendingApproval.toolName, risk: pendingApproval.riskLevel, args: pendingApproval.args }, null, 2)}
                </pre>
              </details>
            </div>
            <div className="flex justify-end gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => { setDeciding(false); handleDecision(false); }}
                disabled={loading || deciding !== null}
                className="hud-press hud-mono min-h-11 rounded-xl px-4 py-2 border border-white/10 text-zinc-400 hover:text-zinc-200 text-[13px] disabled:opacity-40"
              >
                {deciding === false ? '見送っています…' : '今回は見送る'}
              </button>
              <button
                type="button"
                onClick={() => { setDeciding(true); handleDecision(true); }}
                disabled={loading || deciding !== null}
                className="iris-approval-primary hud-press hud-mono min-h-11 rounded-xl px-4 py-2 border border-sky-500/50 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 text-[13px] disabled:opacity-40"
              >
                {deciding === true ? '処理中…' : pendingApproval.toolName === 'create_development_task' ? '登録する' : '承認して実行'}
              </button>
            </div>
          </div>
        </div>
      )}
            {loading && (
              <ResponseStatus
                phase={runPhase === 'tool_execution' ? 'tool_execution' : streamText ? 'responding' : sending ? 'sending' : 'thinking'}
                lastProgress={lastProgress}
              />
            )}
            {error && (
              <p role="alert" className="mb-2 rounded-xl bg-[var(--hud-bg)] px-3 py-2 text-[13px] leading-relaxed text-[var(--hud-danger)]">{error}</p>
            )}
          </div>
          {/*
            浮いて見えるのは、丸みと、後ろが透けることと、影の三つ。
            どれか一つでは板が置いてあるようにしか見えない。
          */}
          {/*
            二段にした。**打つところと、押すところを分ける。**

            一本の丸い溝に文字と送信を詰めていたので、**打てる場所がそこしか
            無いように見えて**、声も、いま何が答えるのかも、別の袖（⌘'）に
            隠れていた。押す物を横に増やすと文字の幅が削られるので、下へ。

            ここに置いたものは**全部すでに在る機能**で、飾りの押し場所は
            置いていない —— 押せるのに何も起きない物は、無い物より悪い。
          */}
          <div className="hud-float hud-panel pointer-events-auto mx-auto w-full max-w-[720px] rounded-[22px] px-4 pt-3.5 pb-2.5 focus-within:border-sky-400/60 transition">
            <div className="flex items-start gap-2">
              <span className="hud-mono text-sky-400/60 text-[13px] mt-[3px] select-none">›</span>
              <textarea
                ref={inputRef}
                rows={1}
                aria-label="メッセージまたは指示"
                className="flex-1 min-w-0 resize-none max-h-36 overflow-y-auto bg-transparent border-none text-[16px] leading-6 text-zinc-100 placeholder-zinc-600 focus:outline-none"
                placeholder={pendingApproval ? '承認待ち…' : 'メッセージまたは指示'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                disabled={loading || restoring || !!pendingApproval}
              />
            </div>
            {draftStorageFailed && (
              <p role="status" className="mt-2 text-[12px] text-[var(--hud-warn)]">
                下書きを保存できません。再読み込み前に文章をコピーしてください。
              </p>
            )}

            <div className="mt-2.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={startNewConversation}
                  title="新しい履歴を始める"
                  aria-label="新しい履歴を始める"
                  className="hud-press grid place-items-center w-7 h-7 rounded-full border border-white/10 text-zinc-500 hover:text-sky-300 hover:border-sky-400/40 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                {/*
                  声。**袖の中にしか無かった。**呼びかけて話すのがこの機械の
                  入口の一つなのに、押し場所は ⌘' の奥にあった。聞いている
                  あいだは色を持つ —— 聞いているかどうかは、押した本人にしか
                  分からないことなので。
                */}
                <button
                  type="button"
                  onClick={toggleMic}
                  disabled={micBusy}
                  title={speech?.state === 'listening' ? '聞くのをやめる' : '声で話す'}
                  aria-label={speech?.state === 'listening' ? '聞くのをやめる' : '声で話す'}
                  className={`hud-press grid place-items-center w-7 h-7 rounded-full border transition disabled:opacity-40 ${
                    speech?.state === 'listening'
                      ? 'border-sky-400/60 text-sky-300 bg-sky-400/10'
                      : 'border-white/10 text-zinc-500 hover:text-sky-300 hover:border-sky-400/40'
                  }`}
                >
                  <Mic className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-2.5">
                {/*
                  いま何が答えるのか。**読むだけで、押せない。**

                  順番を決めているのは `provider_router` で、ここから選ばせる
                  口は無い。選べるように見せると、押しても変わらない物になる。
                  読めなければ**何も出さない** —— 「自動」とだけ書くと、
                  読めていないことが読めているように見える。
                */}
                {routing?.routing && firstAvailableProvider && (
                  <div className="relative hidden sm:block">
                    <button
                      type="button"
                      onClick={() => setLanesOpen((v) => !v)}
                      aria-expanded={lanesOpen}
                      className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition"
                    >
                      <Sparkles className="w-3 h-3 text-sky-400/50" />
                      自動 · {firstAvailableProvider}
                    </button>
                    {lanesOpen && settings?.lanes && (
                      <LanePicker
                        lanes={settings.lanes}
                        onPick={async (lane, provider) => {
                          try {
                            await setLane(lane, provider);
                            setSettings(await fetchSettings());
                          } catch {
                            // 失敗は握りつぶさない。読み直せば、変わっていない
                            // ことが画面に出る。
                            setSettings(await fetchSettings().catch(() => settings));
                          }
                        }}
                        onClose={() => setLanesOpen(false)}
                      />
                    )}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={loading || restoring || !input.trim() || !!pendingApproval}
                  aria-label="送る"
                  className="hud-press grid place-items-center w-8 h-8 rounded-full bg-sky-400/90 text-[#0C0E12] hover:bg-sky-300 disabled:bg-white/[0.06] disabled:text-zinc-600 transition"
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>


      {/*
        What the microphone last turned into a turn.
        
        The window used to do the turning, so it always knew. Now the server
        does, and a person speaking with this open should still see that they
        were heard — silence after speaking is indistinguishable from not having
        been heard at all.
      */}
      {heard && speech?.state === 'listening' && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-30 hud-mono text-[11px] px-3 py-1.5 border"
          style={{
            bottom: 96,
            borderColor: 'var(--hud-line)',
            background: 'var(--hud-panel)',
            color: heard.type === 'voice.failed' ? 'var(--hud-danger)' : 'var(--hud-muted)',
          }}
        >
          {heard.type === 'voice.overheard'
            ? '聞こえましたが、名前が無いので送っていません。'
            : heard.type === 'voice.failed'
              ? `届きませんでした。${heard.reply ?? ''}`
              : `「${heard.text ?? ''}」`}
        </div>
      )}

    </div>
  );
}
