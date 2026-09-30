import { execFileSync, execFile } from 'child_process';
import express, { Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { existsSync as fsExistsSync, readdirSync as fsReaddirSync, readFileSync as fsReadFileSync, mkdirSync as fsMkdirSync, writeFileSync as fsWriteFileSync } from 'fs';
import os from 'os';

dotenv.config();

import { CONFIG } from './config.js';
import { decideAccess, presentedToken, isLoopback, COOKIE_NAME } from './core/access.js';
import { loadAccessToken } from './services/access_token.js';
import { readTranscript } from './services/agent_meter.js';
import { CliUsageService } from './services/cli_usage.js';
import { AgyUsageService } from './services/agy_usage.js';
import { refreshCodexAllowance } from './services/codex_refresh.js';
import { defaultToolRegistry } from './tools/registry.js';
import { defaultWorkspace } from './tools/workspace.js';
import { createFilesystemTools } from './tools/filesystem.js';
import { createSystemTools } from './tools/system.js';
import { createDevelopmentTools } from './tools/development.js';
import { createAgentDispatchTools } from './tools/agent_dispatch.js';
import { createPortfolioTools } from './tools/portfolio.js';
import { createFinanceTools } from './tools/finance.js';
import { VoiceLoop } from './services/voice_loop.js';
import { readSessions } from './services/sessions.js';
import { readWeather, onWeatherOutcome } from './services/weather.js';
import { sweepProbeTranscripts } from './services/probe_cleanup.js';
import { LockStore } from './services/locks.js';
import { readScheduleExams, readScheduleLectures, alreadyKnown } from './services/schedule_exams.js';
import { findLectureDivergence } from './core/lecture_divergence.js';
import { guardAgainstRepeats, coverage, explainHits } from './core/repeat_guard.js';
import { LoopWatch } from './core/loop_watch.js';
import { FreshEnough } from './core/fresh_enough.js';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { toLectureEvents } from './core/lecture_events.js';
import { subject } from './services/event_title.js';
import { freeForDay, sliceByDay, asPlainText } from './services/free_time.js';
import { roomLeftToday, describeRoom } from './core/day_room.js';
import { readPlaces, resolveAddress } from './services/travel.js';
import { readClaudeUsage } from './services/claude_usage.js';
import { refreshAllowance, allowanceRefreshState, PROBE_PROMPT } from './services/allowance_refresh.js';
import { startRepoBackup, repoBackupReading, backUpRepository } from './services/repo_backup.js';
import { DelegatedRunStore } from './services/delegated_runs.js';
import { ProactiveRuleStore } from './services/proactive_rules_sqlite.js';
import { ProactiveOpenerStore } from './services/proactive_openers_sqlite.js';
import { openerFor, railLabel } from './core/opener.js';
import { nextExam, looksLikeExam } from './services/exam.js';
import { type SessionUsageRead } from './services/session_usage.js';
import { buildPrompt, tidyTitle } from './services/conversation_title.js';
import { AllowanceHistory } from './services/allowance_history.js';
import {
  decide as decideAllowance,
  readBaseline,
  writeBaseline,
  DEFAULT_BUDGET,
} from './core/allowance_gate.js';
import { chooseAgent } from './core/agent_choice.js';
import { attendedNetwork, asAgentKind, modelForRole } from './core/agent_runner.js';
import { PortfolioService, ledgerRoot, repositoriesUnder } from './services/portfolio.js';
import { DelegationStore } from './services/delegation_store.js';
import { decideDelegation, defaultGrant } from './core/delegation.js';
import { SqliteDevTaskStore } from './services/dev_tasks_sqlite.js';
import { DevelopmentService, DevTaskNotFoundError, AgentRunNotFoundError } from './core/development_service.js';
import { SqliteFutureFeatureStore, FeatureNotFoundError, ImmutableFeatureError } from './services/future_features_sqlite.js';
import { FutureFeatureService, NonActionableFeatureError } from './core/future_features_service.js';
import { createRegisterTools } from './tools/register.js';
import { SqliteTopicStore, TopicNotFoundError } from './services/topics_sqlite.js';
import { TopicService } from './core/topic_service.js';
import { createTopicTools } from './tools/topics.js';
import { PRICING_LAST_VERIFIED, formatCost } from './core/usage.js';
import { validateConfiguration, classifyProviderError, ConfigIssue } from './core/provider_errors.js';
import { discoverAll, checkConfiguredModel, checkConfigured, ModelCheckStore } from './services/model_discovery.js';
import { openDatabase, getSchemaVersion, LATEST_SCHEMA_VERSION } from './services/db.js';
import { SqliteApprovalStore } from './services/approval_sqlite.js';
import { SqliteConversationStore } from './services/conversation_sqlite.js';
import { SqliteActivityLogStore } from './services/activity_log_sqlite.js';
import { JarvisOrchestrator, StaleApprovalError } from './core/orchestrator.js';
import { ChatService, ConversationNotFoundError } from './core/chat_service.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GeminiProvider } from './providers/gemini.js';
import { OpenAIProvider } from './providers/openai.js';
import { ProviderRouter, resolvePriority } from './core/provider_router.js';
import { PreferenceStore } from './services/preferences_sqlite.js';
import { findWorkplace } from './core/fdp_workplace.js';
import { sessionsFor } from './core/fdp_session_link.js';
import { readGciLedger } from './core/gci_ledger.js';
import { buildIcs, type IcsEvent } from './core/ics.js';
import { randomBytes } from 'node:crypto';
import { SpeechBridge, SpeechHelperMissingError } from './services/speech_bridge.js';
import { ContextEngine } from './core/context_engine.js';
import { LifeStateService, renderLifeState } from './core/life_state.js';
import { summarize, credentialUsable, missingFrom, IntegrationProbe } from './core/integration_health.js';
import { renderHandoffMarkdown } from './core/handoff.js';
import { AgentProcessService } from './services/agent_process.js';
import { AgentScheduleStore } from './services/agent_schedule_sqlite.js';
import { categorise as categoriseSpending } from './core/finance_category.js';
import { FinanceStore } from './services/finance_sqlite.js';
import { BackupService } from './services/backup_service.js';
import { enforce as enforcePermissions, PermissionTarget } from './core/local_permissions.js';
import { detectWakeWord, WAKE_WORDS } from './core/wake_word.js';
import { GmailClient, GmailUnavailableError } from './services/gmail_client.js';
import { GoogleOAuth, GOOGLE_SERVICE_SCOPES } from './services/google_oauth.js';
import { parseEmail, EMAIL_TEMPLATES } from './core/finance_email.js';
import { parseCsv, decode, FORMATS, detectFormat, splitCsvLine } from './core/finance_csv.js';
import { RunRole } from './services/dev_tasks_sqlite.js';
import { DEFAULT_POLICY, AgentPolicy, AgentKind, AGENTS } from './core/agent_runner.js';
import { ProactiveService, renderContextForPrompt } from './core/proactive_service.js';
import { SqliteContextStore } from './services/context_sqlite.js';
import { TelemetryService } from './core/telemetry_service.js';
import { SearchService } from './services/search.js';
import { McpClientService, mcpServersFromEnv } from './services/mcp_client.js';
import { OAuthStore } from './services/oauth_store.js';
import { GrantHealthService, grantWarning, type GrantHealth } from './services/grant_health.js';
import { IrisOAuthProvider, GOOGLE_MCP_SCOPES } from './services/oauth_provider.js';
import { CalendarService, CalendarUnavailableError, upcomingEvents } from './services/calendar.js';
import { GoogleCalendarClient } from './services/google_calendar.js';
import { findDivergence, type SourceReading } from './core/calendar_divergence.js';
import {
  buildPrompt as buildEventPrompt,
  parseDraft as parseEventDraft,
  describeDraft as describeEventDraft,
} from './core/event_draft.js';
import { CaldavCalendarClient } from './services/caldav_calendar.js';
import { FdpSheets } from './services/fdp_sheets.js';
import { FdpTasksService } from './services/fdp_tasks.js';
import { FdpHoldStore } from './services/fdp_holds_sqlite.js';
import { FdpLedgerStore } from './services/fdp_ledger_sqlite.js';
import { FdpSheetWriter } from './services/fdp_sheet_writer.js';
import { DailyFocusService } from './core/daily_focus.js';
import { BudgetService, limitsFromEnv } from './core/budget_service.js';
import { PronunciationStore, applyPronunciations } from './services/pronunciation.js';
import { normalizeForSpeech } from './services/speech_text.js';
import { SpeechAgent } from './services/speech_agent.js';
import { MemoryStore } from './services/memory_sqlite.js';
import { renderMemoryForPrompt } from './core/memory.js';
import { createMemoryTools } from './tools/memory.js';
import { Concerns, createConcernTools, CONCERN_KIND } from './core/concerns.js';
import { createLifeStateTools } from './tools/life_state.js';
import { DecisionStore } from './services/decisions_sqlite.js';
import { ExperienceStore } from './services/experiences_sqlite.js';
import { shouldBargeIn } from './core/barge_in.js';
import { isOwnVoice } from './core/own_voice.js';
import { pressingTasks, describePressing } from './core/fdp_verdict.js';
import { auditPronunciation, describeAudit, PronunciationAudit } from './core/pronunciation_audit.js';
import {
  DeviceTtsEngine, OpenAiTtsEngine, ElevenLabsTtsEngine, GoogleTtsEngine, TtsService,
} from './services/tts.js';
import { ReviewService, NoIndependentReviewerError, ReviewAlreadyRunningError } from './core/review_service.js';
import { SkillAdvisorService } from './services/skill_advisor.js';
import { createSkillTools } from './tools/skills.js';

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = path.join(process.cwd(), 'jarvis_memory.db');
const db = openDatabase(dbPath, { verbose: true });

const approvalStore = new SqliteApprovalStore(db);
const conversationStore = new SqliteConversationStore(db);
const activityLog = new SqliteActivityLogStore(db);

/**
 * Where the token lives, and the gate that uses it.
 *
 * The gate covers the API and not the static files. The bundle and the HTML
 * carry nothing — every piece of data comes through /api — and leaving them
 * open is what lets a phone load the page in order to be asked for the token
 * at all. Protecting them would mean the only way in was to already be in.
 */
const accessToken = loadAccessToken(
  path.join(os.homedir(), 'Library/Application Support/IRIS/access-token')
);

/*
 * 要求が輪を握っている間は、その道の名前で名乗る。
 *
 * 周期の仕事だけに名前を付けても、停止の半分は「不明」のまま残った（実測
 * 2026-09-28）。**止めるのは周期の仕事に限らない** —— 要求の処理そのものが
 * 同期で重ければ、同じだけ全員を待たせる。
 */
app.use((req, res, next) => {
  /*
   * 要求の**始まりから終わりまで**を計る。
   *
   * 最初は `next()` を囲んだだけで、それでは足りなかった —— 非同期の処理は
   * `next()` が返ったあとに走るので、4.2秒 の停止が「不明」として残った
   * （実測 2026-09-28）。`finish` まで開けておけば、時間を使った道は分かる。
   */
  const end = loopWatch.begin(`http ${req.method} ${req.path}`);
  res.on('finish', end);
  res.on('close', end);
  next();
});

app.use('/api', (req, res, next) => {
  const verdict = decideAccess({
    remoteAddress: req.socket.remoteAddress,
    presented: presentedToken(req.headers as Record<string, any>),
    expected: accessToken.token,
  });
  if (verdict.allow) {
    /**
     * Once a device has proved itself, it stops having to.
     *
     * Set on every allowed non-loopback request rather than at a login step,
     * because there is no login step — the first request carries the header
     * and every one after it can carry this instead. Renewed each time, so a
     * device in daily use never reaches the expiry.
     *
     * `httpOnly` because no script here needs to read it, and a credential a
     * script cannot read is one an injected script cannot take. Not `secure`:
     * this server speaks plain HTTP over a private network, and a cookie
     * marked secure would simply never be sent.
     */
    if (!isLoopback(req.socket.remoteAddress) && accessToken.token) {
      res.cookie(COOKIE_NAME, accessToken.token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 365 * 24 * 60 * 60 * 1000,
        path: '/',
      });
    }
    return next();
  }

  /**
   * Logged, because this is the one place where being refused is worth
   * knowing about. Someone else's device trying the door is exactly the event
   * this was built for, and it would otherwise leave no trace at all.
   */
  activityLog.warn('access.refused', {
    message: verdict.reason,
    detail: { from: req.socket.remoteAddress ?? null, path: req.path, code: verdict.code },
  });
  res.status(401).json({ error: verdict.reason, code: verdict.code });
});

const topicStore = new SqliteTopicStore(db);
const topics = new TopicService(topicStore, conversationStore, activityLog);

const devTaskStore = new SqliteDevTaskStore(db);
// Nothing can legitimately be running at boot, so anything that claims to be
// was interrupted. Left alone it would sit "running" forever.
const orphanedRuns = devTaskStore.reconcileOrphanedRuns();
for (const orphan of orphanedRuns) {
  console.log(`  ! 中断された run を回収: ${orphan.agent} / ${orphan.role} (${orphan.id.slice(0, 8)})`);
  activityLog.warn('dev.run_orphaned', {
    message: `${orphan.agent} / ${orphan.role} がサーバ再起動により中断されました。`,
    detail: { runId: orphan.id, taskId: orphan.taskId, startedAt: orphan.startedAt },
  });
}
const development = new DevelopmentService(devTaskStore, activityLog, defaultToolRegistry);
const register = new FutureFeatureService(new SqliteFutureFeatureStore(db), activityLog, development);
const seedResult = register.seedFromHandoffs();

// Production tool surface. Risk levels drive the approval boundary:
// READ auto-executes, WRITE/DESTRUCTIVE always pause for user approval.
defaultToolRegistry.registerAll(createSystemTools(defaultWorkspace));
defaultToolRegistry.registerAll(createFilesystemTools(defaultWorkspace));
defaultToolRegistry.registerAll(createDevelopmentTools(development));

/**
 * The MED-AI Builder Lab ledger, read but never written.
 *
 * Its own operating rules make its Markdown the single authority for Projects,
 * Decisions and approved specifications. IRIS keeps no copy — every read goes
 * to the files, so the two cannot drift apart.
 *
 * The watched list is every git working copy under the Codex directory rather
 * than a fixed list, because the interesting case is the repository nobody
 * remembered to register, and a fixed list could only contain repositories
 * somebody remembered.
 */
const portfolio = new PortfolioService(
  ledgerRoot(),
  repositoriesUnder(path.join(os.homedir(), 'Documents/Codex'), 2)
);
defaultToolRegistry.registerAll(createPortfolioTools(portfolio));
defaultToolRegistry.registerAll(createRegisterTools(register));
// Topics say which conversations belong together; search says what was
// actually said, including in threads nobody tagged.
const searchService = new SearchService(db);
defaultToolRegistry.registerAll(createTopicTools(topics, searchService));

/**
 * External tool servers.
 *
 * Nothing is configured by default: an MCP server is a surface of tools that
 * can act, and one appearing because a variable happened to be set is not
 * something that should be possible. Connection is deliberately not awaited at
 * startup — IRIS without Google Sheets is still IRIS, and a server that is
 * slow to answer must not delay the first message.
 */
const oauthStore = new OAuthStore(db);
const modelChecks = new ModelCheckStore(db);
const memories = new MemoryStore(db);
const concerns = new Concerns(db);
defaultToolRegistry.registerAll(createConcernTools(concerns));
const decisions = new DecisionStore(db);
const experiences = new ExperienceStore(db);

// Registered here rather than with the others because the stores are built
// here. Reading is free; writing a memory is a WRITE, since a memory outlives
// the conversation and a wrong one is applied silently afterwards.
defaultToolRegistry.registerAll(createMemoryTools(memories, decisions, experiences));

/**
 * Where Google sends the user back.
 *
 * Must match a redirect URI registered on the OAuth client exactly, including
 * the port — a mismatch is refused by Google before IRIS is involved, which is
 * the most common way this fails.
 */
const OAUTH_REDIRECT =
  process.env.IRIS_OAUTH_REDIRECT ?? `http://localhost:${CONFIG.port}/api/mcp/oauth/callback`;

const oauthProviders = new Map<string, IrisOAuthProvider>();

function providerFor(serverId: string): IrisOAuthProvider | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  const existing = oauthProviders.get(serverId);
  if (existing) return existing;

  const provider = new IrisOAuthProvider({
    serverId,
    clientId,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim(),
    redirectUri: OAUTH_REDIRECT,
    // Read-only wherever a read-only variant exists. Anything outbound stays
    // behind the approval boundary rather than behind a one-time consent.
    scopes: GOOGLE_MCP_SCOPES[serverId] ?? [],
    // Google-specific, and the difference between a credential that lasts and
    // one that expires in an hour. See IrisOAuthOptions.authorizationParams.
    authorizationParams: { access_type: 'offline', prompt: 'consent' },
    store: oauthStore,
    onEvent: ({ type, detail }) => activityLog.log({ level: 'info', event: type, detail }),
  });
  oauthProviders.set(serverId, provider);
  return provider;
}

const mcpConfigs = mcpServersFromEnv().map((c) => ({
  ...c,
  authProvider: c.token ? undefined : providerFor(c.id),
}));

const mcp = new McpClientService(mcpConfigs, ({ type, detail }) => {
  const level = type === 'mcp.connect_failed' ? 'warn' : 'info';
  activityLog.log({ level, event: type, detail });
});

void mcp.connectAll().then((connections) => {
  const live = connections.filter((c) => c.connected);
  if (live.length === 0) return;
  const tools = mcp.asIrisTools();
  defaultToolRegistry.registerAll(tools);
  console.log(
    `🔌 MCP: ${live.map((c) => `${c.id}(${c.toolCount})`).join(', ')} — ` +
      `${tools.length} ツールを取り込み（すべて UNTRUSTED、READ 以外は承認必須）`
  );
});

/**
 * Confirms the configured models still exist, on a timer.
 *
 * Discovery has always been available; nothing ran it. The check happened when
 * somebody opened the models page, which means the first notice of a retired
 * model was a run failing — and the run that matters is the one at six in the
 * morning that nobody is watching.
 *
 * Deliberately not blocking startup and deliberately not fatal. A provider
 * that cannot be reached is not evidence that a model is gone, and refusing to
 * start over a network blip would be a worse failure than the one being
 * guarded against.
 */
const MODEL_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function verifyConfiguredModels(reason: string) {
  try {
    const checks = checkConfigured(await discoverAll());
    for (const check of checks) modelChecks.record(check);

    const missing = checks.filter((c) => c.present === false);
    const unknown = checks.filter((c) => c.present === undefined);

    if (missing.length > 0) {
      for (const c of missing) {
        // Warn, not error: nothing has failed yet. What has happened is that
        // the next request to this provider will 404, and there is time to
        // change it before that happens.
        activityLog.log({
          level: 'warn',
          event: 'model.retired',
          message: `${c.setting}=${c.configured} は提供されていません。${c.suggestion ? `候補: ${c.suggestion}` : ''}`,
          detail: { provider: c.provider, setting: c.setting, configured: c.configured, suggestion: c.suggestion },
        });
        console.log(`  ! モデル [${c.setting}] ${c.configured} は提供モデル一覧にありません`);
        if (c.suggestion) console.log(`      → 候補: ${c.suggestion}`);
      }
    }
    activityLog.log({
      level: 'info',
      event: 'model.verified',
      detail: { reason, checked: checks.length, missing: missing.length, unchecked: unknown.length },
    });
  } catch (err: any) {
    activityLog.log({
      level: 'warn',
      event: 'model.verify_failed',
      message: err?.message ?? String(err),
      detail: { reason },
    });
  }
}

// Not awaited: a slow provider must not delay the first message.
void verifyConfiguredModels('startup');
setInterval(() => void loopWatch.around('models.verify', () => verifyConfiguredModels('interval')), MODEL_CHECK_INTERVAL_MS).unref();

// Configuration is checked before any request is made, so a placeholder key or
// a retired model id is reported at startup rather than as an opaque runtime
// error on the user's first message.
const configIssues: ConfigIssue[] = validateConfiguration();
for (const issue of configIssues) {
  const prefix = issue.severity === 'error' ? '  ✗ 設定エラー' : '  ! 設定の警告';
  console.log(`${prefix} [${issue.setting}] ${issue.message}`);
  console.log(`      → ${issue.guidance}`);
  activityLog.log({
    level: issue.severity === 'error' ? 'error' : 'warn',
    event: 'config.issue',
    message: `${issue.setting}: ${issue.message}`,
    detail: issue,
  });
}

const providers: Record<string, any> = {};
if (process.env.ANTHROPIC_API_KEY) {
  providers['anthropic'] = new AnthropicProvider(process.env.ANTHROPIC_API_KEY);
  // A second Anthropic model, so review is possible with one vendor
  // configured. Weaker than a different vendor, and reported as such.
  const reviewModel =
    process.env.ANTHROPIC_REVIEW_MODEL ||
    (providers['anthropic'].currentModel === 'claude-opus-5' ? 'claude-sonnet-5' : 'claude-opus-5');
  if (reviewModel !== providers['anthropic'].currentModel) {
    providers['anthropic-review'] = new AnthropicProvider(process.env.ANTHROPIC_API_KEY, reviewModel);
  }
  /*
   * 速い方の相手。**声で返すときに使う。**
   *
   * 実測 2026-09-11、最初の言葉が出るまで Haiku 4.5 が 0.91〜1.10秒、
   * Sonnet 5 が 1.50秒、それまで会話を担っていた Gemini flash が 2.57秒。
   * 声で 2.5秒待たされるのは沈黙で、**「考えている」と出ていても会話には
   * ならない。**
   *
   * 値段も半分（入力 $1 / 出力 $5 対 $2 / $10）だが、**選んだ理由は速さ。**
   * 費用は利用者の使用量では既に誤差（一往復 0.2〜0.4円）。
   */
  const fastModel = process.env.IRIS_FAST_MODEL?.trim() || 'claude-haiku-4-5';
  if (fastModel !== providers['anthropic'].currentModel) {
    providers['anthropic-fast'] = new AnthropicProvider(process.env.ANTHROPIC_API_KEY, fastModel);
  }
}
if (process.env.GEMINI_API_KEY) {
  // GEMINI_MODEL was being read by nobody: the provider defaulted and the env
  // var sat there looking effective. It matters more now that Gemini is first
  // in the order, since the free allowance is per-model.
  providers['gemini'] = new GeminiProvider(
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_MODEL?.trim() || undefined,
    // Tools Gemini cannot be given must be findable afterwards. A capability
    // that disappears with nothing in the log is indistinguishable from one
    // the model simply chose not to use.
    ({ type, detail }) => activityLog.log({ level: 'warn', event: type, detail })
  );
}
if (process.env.OPENAI_API_KEY) {
  providers['openai'] = new OpenAIProvider(process.env.OPENAI_API_KEY);
}

/**
 * Routing order, not a single provider.
 *
 * Gemini's free daily allowance is worth nothing unless it is actually spent,
 * so it goes first and the paid providers catch what is left. The router owns
 * the failover: when the allowance runs out mid-conversation the turn
 * continues on the next provider rather than dying.
 */
/**
 * Spending limits.
 *
 * Metered APIs bill in real time, and the failure that cannot be undone is a
 * loop nobody watched. Two limits by severity (warn, then stop) and two by
 * mechanism (estimate before a call, billed total after it), so a stale price
 * table or a provider that stops reporting usage still leaves one guard
 * standing.
 */
const budget = new BudgetService(db, limitsFromEnv());
/**
 * Reads Claude Code's and Codex's own files. Nothing is sent anywhere and no
 * credential is involved — these are already on disk because the tools put
 * them there.
 */
const history = new AllowanceHistory(db);
/**
 * Antigravity の残量。三つ目の目盛りで、唯一ソケット越しに読むもの。
 *
 * 相手のアプリが動いているあいだしか読めない。読めないことは読めないと
 * 言い、0% とは書かない。
 */
const agyUsage = new AgyUsageService();

/**
 * 止まった瞬間と、そのとき何が走っていたか。
 *
 * 外から測れば「止まった」までは分かるが、周期の仕事は十数あるので**時刻から
 * 当てるのは当て物**になる（実測 2026-09-28、3.9秒 の停止が 240秒 に一度）。
 * 当て物をやめるための計器。読むのは `GET /api/health/stalls`。
 */
const loopWatch = new LoopWatch();
loopWatch.start();

/*
 * ごみ集めも輪を止める。**名乗る相手がいないので、ここで名乗らせる。**
 *
 * どの仕事にも属さない停止が残るなら、次の疑いはここ（大きな山を一度に片づける
 * ときは秒単位になる）。疑いのままにせず、測れる形にしておく。
 */
try {
  const gc = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      loopWatch.record(`gc.${(entry as any).detail?.kind ?? 'unknown'}`, entry.duration, entry.startTime + performance.timeOrigin);
    }
  });
  gc.observe({ entryTypes: ['gc'] });
} catch (err: any) {
  activityLog.log({ level: 'warn', event: 'loopwatch.gc_unavailable', detail: { message: err?.message ?? String(err) } });
}

/**
 * 使用量の掃き直しは、別プロセスで。
 *
 * `read()` は掃き直しを `setTimeout(0)` に預けていた。頼んだ人は待たないが、
 * **同じ一本の輪なので他の全員が待つ。**実測 2026-09-28: 外から 100ms ごとに
 * 叩いて、180秒のうち最大 1.7秒 の遅れが二度。遅れた回の往復そのものが遅れの
 * 全部で、後続はその後ろに並んだだけ —— 塞いでいたのは掃き直しだった。
 *
 * 読む量は 7 日ぶんの転記 197 本・4.7 GB で、うち一本は書きかけの 108 MB。
 * `scripts/sessions-scan.ts` を子プロセスへ出したのと同じ話で、同じ形で直す。
 */
let cliUsageRefresh: Promise<void> | null = null;
function refreshCliUsage(): Promise<void> {
  if (cliUsageRefresh) return cliUsageRefresh;
  cliUsageRefresh = new Promise<void>((resolve) => {
    const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
    execFile(
      tsx, ['scripts/cli-usage-scan.ts', os.homedir()],
      { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
      (err, stdout) => {
        cliUsageRefresh = null;
        if (err) {
          activityLog.log({ level: 'warn', event: 'usage.sweep_failed', detail: { message: String(err.message).slice(0, 300) } });
          return resolve();
        }
        try {
          loopWatch.during('usage.parse', () => cliUsage.accept(JSON.parse(stdout)));
        } catch (e: any) {
          activityLog.log({ level: 'warn', event: 'usage.sweep_unreadable', detail: { message: e?.message } });
        }
        resolve();
      }
    );
  });
  return cliUsageRefresh;
}

/**
 * プロジェクト別の内訳。**要求の中で走らせない。**
 *
 * `readSessionUsage` は 7 日ぶんの転記 197 本・4.7 GB を同期で読む。
 * `GET /api/allowance/breakdown` はそれを毎回、キャッシュ無しで呼んでいて、
 * 実測 2026-09-28 で一回の要求が **10.2秒** サーバ全体を止めていた。
 *
 * 日数ごとに別の答えなので、日数を鍵にして持つ。新しさは 5 分 —— 転記は
 * その速さでしか増えない。
 */
const sessionUsageCaches = new Map<number, FreshEnough<SessionUsageRead>>();
function sessionUsage(days: number): FreshEnough<SessionUsageRead> {
  const held = sessionUsageCaches.get(days);
  if (held) return held;
  const cache = new FreshEnough<SessionUsageRead>(5 * 60_000, () =>
    new Promise<SessionUsageRead>((resolve, reject) => {
      const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
      execFile(
        tsx, ['scripts/session-usage-scan.ts', os.homedir(), String(days)],
        { cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
        (err, stdout) => {
          if (err) return reject(err);
          try {
            // 解くのはここなので、ここも名乗る。
            resolve(loopWatch.during('allowance.breakdown.parse', () => JSON.parse(stdout) as SessionUsageRead));
          } catch (e) {
            reject(e);
          }
        }
      );
    })
  );
  sessionUsageCaches.set(days, cache);
  return cache;
}

/**
 * 作業場所の探索は、課題ごとに覚えておく。
 *
 * `findWorkplace` はフォルダを同期で walk する。課題が七つあると七回で、
 * `GET /api/fdp/tasks` の同期の塞ぎ（実測 2026-09-28、最悪 525ms）はこれ。
 * **場所は分の単位で動かない**ので、5 分覚えておけば足りる。
 */
const workplaceMemo = new Map<string, { at: number; value: ReturnType<typeof findWorkplace> }>();
function workplaceOf(task: any): ReturnType<typeof findWorkplace> {
  const key = `${task?.id ?? ''}|${task?.title ?? ''}`;
  const held = workplaceMemo.get(key);
  if (held && Date.now() - held.at < 5 * 60_000) return held.value;
  const value = findWorkplace(task, FDP_WORK_ROOTS);
  workplaceMemo.set(key, { at: Date.now(), value });
  return value;
}

const cliUsage = new CliUsageService(
  os.homedir(),
  (path) => {
    const reading = readTranscript(path);
    return { usage: reading.usage, model: reading.model, messages: reading.messages };
  },
  undefined,
  () => { void refreshCliUsage(); }
);
{
  const l = budget.getLimits();
  console.log(
    `💰 上限: 1実行 $${l.perRunUsd} / 日 $${l.dailyUsd} / 月 $${l.monthlyUsd}` +
      `（${Math.round(l.warnAt * 100)}% で警告）`
  );
}

const routed = resolvePriority(providers, process.env.IRIS_PROVIDER_PRIORITY);
const router =
  routed.length > 0
    ? new ProviderRouter(routed, {
        quotaResetTimeZone: process.env.IRIS_QUOTA_RESET_TZ || 'America/Los_Angeles',
        // Consulted per request, so a limit reached mid-conversation applies
        // to the next turn. Over the limit the chain narrows to free
        // providers rather than the turn failing.
        paidAllowed: () => budget.paidCallsAllowed(),
        freeKeys: (process.env.IRIS_FREE_PROVIDERS || 'gemini').split(',').map((s) => s.trim()),
        onEvent: (event) => {
          const level =
            event.type === 'router.provider_unavailable' || event.type === 'router.all_unavailable'
              ? 'warn'
              : 'info';
          activityLog.log({ level, event: event.type, detail: event });
        },
      })
    : null;

/**
 * 会話の出し先を、返す先で変える。
 *
 * 「実際の会話なら速さが欲しいけど、パソコン内で話すだけなら精度のほうが
 * 必要」（利用者、2026-09-11）。**同じ問いでも、返す先で正解が違う。**
 * 声は待たされた時間がそのまま沈黙になり、文字は一秒の差より判断の確かさが
 * 効く。
 *
 * 裏方（会話の題名付け、分類、要約）は `router` のまま —— 無料枠が先頭で、
 * **口調も速さも要らない仕事に払う理由がない。**
 *
 * どちらの列も最後まで無料枠を残す。router がいちばん嫌う失敗は「枠が尽きて
 * 会話が文の途中で死ぬ」ことなので、**払える相手が全部倒れても話は続く。**
 */
function conversationRouter(label: string, order: string[], fallback: ProviderRouter | null) {
  const picked = resolvePriority(providers, undefined, order);
  if (picked.length === 0) return fallback;
  return new ProviderRouter(picked, {
    quotaResetTimeZone: process.env.IRIS_QUOTA_RESET_TZ || 'America/Los_Angeles',
    paidAllowed: () => budget.paidCallsAllowed(),
    freeKeys: (process.env.IRIS_FREE_PROVIDERS || 'gemini').split(',').map((s) => s.trim()),
    onEvent: (event) => activityLog.log({ level: 'info', event: event.type, detail: { ...event, lane: label } }),
  });
}

const preferences = new PreferenceStore(db);

/**
 * その列がいま誰に頼むか。
 *
 * 画面で選ばれていればそれ、無ければ環境変数、それも無ければ組み込みの既定。
 * **順番ではなく「先頭を誰にするか」だけを選ばせる。**残りは控えとして必ず
 * 後ろに付く —— 選択肢を「順番の編集」にすると、無料枠を末尾から外して
 * しまえるようになり、**枠が尽きたときに会話が死ぬ**道を利用者が自分で
 * 作れてしまう。
 */
function laneOrder(lane: 'voice' | 'text'): string[] {
  const fallbackOrder =
    lane === 'voice'
      ? (process.env.IRIS_VOICE_PRIORITY || 'anthropic-fast,anthropic,gemini,openai')
      : (process.env.IRIS_TEXT_PRIORITY || 'anthropic,anthropic-fast,gemini,openai');
  const base = fallbackOrder.split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = preferences.get(`lane.${lane}`);
  if (!chosen || !providers[chosen]) return base;
  return [chosen, ...base.filter((k) => k !== chosen)];
}

/** 同じ順番の router を作り直さない。順番の文字列で引く。 */
const laneRouters = new Map<string, ProviderRouter | null>();
function laneRouter(lane: 'voice' | 'text'): ProviderRouter | null {
  const order = laneOrder(lane);
  const key = order.join(',');
  if (!laneRouters.has(key)) laneRouters.set(key, conversationRouter(lane, order, router));
  return laneRouters.get(key) ?? router;
}

const VOICE_ORDER = (process.env.IRIS_VOICE_PRIORITY || 'anthropic-fast,anthropic,gemini,openai')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TEXT_ORDER = (process.env.IRIS_TEXT_PRIORITY || 'anthropic,anthropic-fast,gemini,openai')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

void VOICE_ORDER;
void TEXT_ORDER;

let activeProvider: any = router;
const primaryProviderId = routed[0]?.key ?? 'none';
let orchestrator: JarvisOrchestrator | null = null;
let chatService: ChatService | null = null;

if (router) {
  console.log(`🔀 プロバイダ優先順: ${router.keys().join(' > ')}`);
  console.log('   無料枠を先に消費し、尽きたら自動的に次へ切り替えます。');
}

// Independent review needs a model other than the implementer's; the service
// refuses rather than self-reviewing when none exists. With routing, "the
// implementer" is whoever actually served the work, so it is asked for at
// review time rather than fixed at startup.
const review = new ReviewService(development, activityLog, providers, primaryProviderId, () =>
  router ? providers[router.lastServedKey()] : undefined
);

if (activeProvider) {
  // Timeouts, retries and deadline breaches are operational events, not
  // conversation content, so they go to the activity log (decision 8.6).
  orchestrator = new JarvisOrchestrator(
    activeProvider,
    defaultToolRegistry,
    approvalStore,
    CONFIG.maxToolLoops,
    (event) => {
      const level =
        event.type === 'tool.timeout' ||
        event.type === 'run.deadline_exceeded' ||
        event.type === 'tool.refused_for_origin'
          ? 'warn'
          : 'info';
      activityLog.log({ level, event: event.type, detail: event });

      // The second, independent limit. The pre-call estimate can be wrong —
      // a stale price table, an unusually long answer — and this reads what
      // was actually billed. One call late, but it cannot be fooled by a bad
      // estimate.
      if (event.type === 'run.spend_limit') {
        activityLog.warn('budget.run_limit', {
          message: `1実行の上限に達したため停止しました（$${event.usd.toFixed(4)} / $${event.limitUsd}）。`,
          detail: event,
        });
      }

      if (event.type === 'run.usage') {
        const state = budget.checkAfterCall();
        if (state.verdict !== 'ok') {
          activityLog.log({
            level: state.verdict === 'deny' ? 'error' : 'warn',
            event: `budget.${state.verdict}`,
            message: state.message,
            detail: state,
          });
        }
      }
    },
    // The model is told what IRIS believes about the moment, with the age and
    // confidence of every claim, so it can decline to be certain — and what it
    // remembers, with where each item came from.
    //
    // Only shareable memories go in: this string is sent to a provider, which
    // is exactly the boundary `local_only` exists for. How many were held back
    // is stated, because a shorter list with no explanation cannot be
    // questioned.
    () => {
      const situation = renderContextForPrompt(context.current());
      const shareable = memories.recall({ shareableOnly: true, limit: 25 });
      const all = memories.recall({ limit: 200 });
      const remembered = renderMemoryForPrompt(shareable.filter(m => m.kind !== CONCERN_KIND), all.length - shareable.length);
      return [renderClockForPrompt(), situation, remembered, concerns.render()]
        .filter((s) => s && s.trim())
        .join('\n\n');
    },
    // 返す先で相手を変える。無ければ既定の相手のまま。
    (channel) => (router ? laneRouter(channel === 'voice' ? 'voice' : 'text') : null) ?? undefined
  );
  chatService = new ChatService(
    orchestrator,
    conversationStore,
    approvalStore,
    activityLog,
    defaultToolRegistry,
    {
      /**
       * Names a thread with the cheapest model configured, once.
       *
       * Routed straight at a provider rather than through the orchestrator:
       * a title needs no tools, no history, no approval boundary, and running
       * it through the full path would put a filing task through the same
       * machinery as a request. It also must never consume the reasoning
       * budget of the turn it is naming.
       */
      async suggest(question: string, reply: string) {
        if (!router) return null;
        // No tools and an empty system instruction: a title needs neither, and
        // handing a filing task the full tool surface invites it to use one.
        const answer = await router.generateResponse(
          [{ role: 'user', content: buildPrompt(question, reply) }],
          [],
          '短い題名だけを返してください。'
        );
        return tidyTitle(answer?.content ?? '');
      },
    }
  );
}

/**
 * The clock, stated rather than fetched.
 *
 * Asked 「今日の予定は？」 by voice on 2026-08-20, the reply took 22 seconds.
 * The situation block carries what IRIS has observed — the next appointment,
 * whether anyone is in the room — but never carried the time, so the model
 * called get_current_time and the turn cost an extra provider round trip.
 * Measured at 3.5s on a good call and 18.1s on a bad one; either way it buys
 * nothing, because the answer is one line the process already holds.
 *
 * Kept out of the situation block on purpose. That block is labelled 推定 and
 * every line in it carries a confidence and an age. The clock has neither: it
 * is read from the machine at the moment of asking, and presenting it as an
 * estimate would teach the model to hedge about something certain.
 */
function renderClockForPrompt(): string {
  try {
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localized = new Intl.DateTimeFormat('ja-JP', {
      timeZone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(now);
    return [
      '# 現在時刻（推定ではなく確定値）',
      `- ${localized}（${timeZone}）`,
      `- ISO: ${now.toISOString()}`,
      'この値は正確です。日付や時刻を知るために道具を呼ぶ必要はありません。',
    ].join('\n');
  } catch {
    // A prompt without a clock is the behaviour that existed before this
    // function, and the model can still reach for the tool. Never a failed turn.
    return '';
  }
}

function requireChatService(res: express.Response): ChatService | null {
  if (!chatService) {
    res.status(503).json({ error: 'APIキーが設定されていません。.env を確認してください。' });
    return null;
  }
  return chatService;
}

/** Maps a thrown error onto an HTTP status and records it in the activity log. */
function handleError(res: express.Response, err: any, event: string, context: Record<string, any> = {}) {
  if (err instanceof ConversationNotFoundError) {
    activityLog.warn(event, { message: err.message, detail: context });
    return res.status(404).json({ error: err.message, code: 'conversation_not_found' });
  }
  if (err instanceof ReviewAlreadyRunningError) {
    // Refusing a duplicate is correct behaviour, not a fault.
    activityLog.warn(event, { message: err.message, detail: context });
    return res.status(409).json({ error: err.message, code: 'review_already_running', runId: err.runId });
  }
  if (err instanceof NoIndependentReviewerError) {
    // Refusing to fake independence is correct behaviour, not a fault.
    activityLog.warn(event, { message: err.message, detail: context });
    return res.status(409).json({ error: err.message, code: 'no_independent_reviewer' });
  }
  if (err instanceof ImmutableFeatureError || err instanceof NonActionableFeatureError) {
    // Refusing to dissolve a boundary is expected behaviour, not a fault.
    activityLog.warn(event, { message: err.message, detail: context });
    return res.status(403).json({ error: err.message, code: 'boundary_protected' });
  }
  if (err instanceof TopicNotFoundError) {
    return res.status(404).json({ error: err.message, code: 'topic_not_found' });
  }
  if (err instanceof FeatureNotFoundError) {
    return res.status(404).json({ error: err.message, code: 'not_found' });
  }
  if (err instanceof DevTaskNotFoundError || err instanceof AgentRunNotFoundError) {
    activityLog.warn(event, { message: err.message, detail: context });
    return res.status(404).json({ error: err.message, code: 'not_found' });
  }
  if (err instanceof StaleApprovalError) {
    return res.status(409).json({ error: err.message, code: 'stale_approval' });
  }
  if (!err?.logged) {
    activityLog.error(event, { message: err?.message || String(err), detail: context });
  }

  const timedOut = err?.name === 'TimeoutError' || err?.name === 'DeadlineExceededError';
  if (timedOut) {
    return res.status(504).json({ error: err.message, code: 'timeout' });
  }

  // A low-level provider fault is translated into what actually went wrong and
  // what to do about it; the original text stays in the activity log.
  const classified = classifyProviderError(err);
  if (classified.kind !== 'unknown') {
    return res.status(classified.configuration ? 503 : 502).json({
      error: classified.message,
      guidance: classified.guidance,
      code: classified.kind,
      configuration: classified.configuration,
    });
  }

  return res.status(500).json({ error: err?.message || 'Internal error' });
}

/**
 * What IRIS depends on, and whether it can currently answer.
 *
 * Cheap by construction: environment variables, one indexed row per OAuth
 * server, and the result the periodic calendar read already produced. Health
 * is polled, and a health check that makes network calls becomes a source of
 * the load it is meant to report on.
 */
function integrationProbes(): IntegrationProbe[] {
  const probes: IntegrationProbe[] = [];

  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID?.trim());
  const token = oauthStore.status('calendar');
  const credential = credentialUsable(token);
  // Contribution is the stronger evidence and is checked first: a token can be
  // present and the source still not be running. Only fall back to the
  // credential when no read has happened yet.
  const missing = lastCalendarRead
    ? missingFrom(googleConfigured ? ['google'] : [], lastCalendarRead.contributed)
    : [];

  probes.push({
    id: 'google_calendar',
    label: 'Google カレンダー',
    configured: googleConfigured,
    answered: !googleConfigured
      ? null
      : !credential.usable
        ? false
        : lastCalendarRead
          ? missing.length === 0
          : null,
    reason: !credential.usable
      ? credential.reason
      : missing.length > 0
        ? `直近の読み取り(${lastCalendarRead?.at})に寄与していません。認可はありますが源として動いていません。`
        : null,
    guidance: !credential.usable
      ? "POST /api/mcp/oauth/start に {\"server\":\"calendar\"} で認可をやり直してください。"
      : null,
  });

  const icloudConfigured = Boolean(
    process.env.ICLOUD_APPLE_ID?.trim() && process.env.ICLOUD_APP_PASSWORD?.trim()
  );
  probes.push({
    id: 'icloud_calendar',
    label: 'iCloud カレンダー (CalDAV)',
    configured: icloudConfigured,
    answered: !icloudConfigured
      ? null
      : lastCalendarRead
        ? lastCalendarRead.contributed.includes('icloud')
        : null,
    reason:
      icloudConfigured && lastCalendarRead && !lastCalendarRead.contributed.includes('icloud')
        ? `直近の読み取り(${lastCalendarRead.at})に寄与していません。`
        : null,
  });

  /**
   * A backup that stopped being taken leaves nothing behind either.
   *
   * The same shape as the calendar source that silently stopped contributing:
   * nothing errors, nothing is logged, and the only evidence is an absence
   * someone has to go looking for.
   */
  const newest = backups.list()[0];
  const ageHours = newest ? (Date.now() - newest.takenAt.getTime()) / 3_600_000 : null;
  probes.push({
    id: 'backups',
    label: 'バックアップ',
    configured: true,
    answered: ageHours === null ? false : ageHours < 48,
    reason:
      ageHours === null
        ? 'バックアップが1つもありません。'
        : ageHours >= 48
          ? `最後のバックアップから ${Math.floor(ageHours / 24)} 日経過しています。`
          : null,
    guidance: ageHours === null || ageHours >= 48 ? 'POST /api/backups で今すぐ取得できます。' : null,
  });

  /**
   * File permissions, which nothing else here would notice.
   *
   * The workspace rules and the privacy flag govern what IRIS hands out; a
   * world-readable backup is a copy of everything, obtained without asking
   * IRIS at all.
   */
  const exposed = PERMISSION_TARGETS.map(enforcePermissions).filter((t) => !t.ok);
  probes.push({
    id: 'permissions',
    label: 'ローカルデータの権限',
    configured: true,
    answered: exposed.length === 0,
    reason: exposed.length > 0 ? exposed.map((e) => `${e.path}: ${e.reason}`).join(' / ') : null,
    guidance: exposed.length > 0 ? 'chmod 700（ディレクトリ）/ 600（ファイル）で閉じられます。' : null,
  });

  for (const config of mcpConfigs) {
    const blocked = config.blockedTools?.length ?? 0;
    const connection = mcp.inventory().find((c: any) => c.id === config.id);
    probes.push({
      id: `mcp:${config.id}`,
      label: `MCP: ${config.id}`,
      configured: config.enabled !== false,
      answered: connection ? Boolean(connection.connected) : null,
      reason: connection && !connection.connected ? '接続できていません。' : null,
      guidance:
        blocked > 0
          ? `${blocked} 件のツールは意図的に遮断されています（.env の blockedTools）。`
          : null,
    });
  }

  return probes;
}

app.get('/api/health', (_req, res) => {
  let database = 'ok';
  let schemaVersion: number | null = null;
  try {
    schemaVersion = getSchemaVersion(db);
    if (schemaVersion !== LATEST_SCHEMA_VERSION) database = 'schema_mismatch';
  } catch (err: any) {
    database = 'error';
  }

  /**
   * Re-read rather than reused.
   *
   * This was a module-level constant computed once at startup, so a setting
   * that became wrong while the process ran could never appear here — which is
   * most of how a credential dies. It is a pure function of the environment
   * and costs nothing to call.
   */
  const currentIssues = validateConfiguration();
  const summary = summarize(integrationProbes());

  const core = Boolean(orchestrator) && database === 'ok';
  res.json({
    // Degraded when something that was set up cannot answer. Never for
    // something that was simply never configured.
    status: core ? (summary.degraded ? 'degraded' : 'healthy') : 'degraded',
    database,
    schemaVersion,
    expectedSchemaVersion: LATEST_SCHEMA_VERSION,
    activeProvider: activeProvider ? activeProvider.name : 'none',
    pendingApprovals: approvalStore.listPending().length,
    // Setup mistakes are surfaced here rather than waiting for a failed request.
    configIssues: currentIssues.map((i) => ({
      severity: i.severity,
      setting: i.setting,
      message: i.message,
      guidance: i.guidance,
    })),
    integrations: summary.integrations,
    failing: summary.failing.map((f) => `${f.label}: ${f.reason}`),
    calendarLastRead: lastCalendarRead,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------- conversations

app.get('/api/conversations', (_req, res) => {
  try {
    res.json({ conversations: conversationStore.listConversations() });
  } catch (err: any) {
    handleError(res, err, 'conversations.list_error');
  }
});

app.post('/api/conversations', (_req, res) => {
  try {
    const conversation = conversationStore.createConversation(null);
    activityLog.info('conversation.created', { conversationId: conversation.id });
    res.status(201).json({ conversation, messages: [], pendingApproval: null });
  } catch (err: any) {
    handleError(res, err, 'conversations.create_error');
  }
});

// Registered before /api/conversations/:id so "recent" is not read as an id.
app.get('/api/conversations/recent', (_req, res) => {
  try {
    const conversation = conversationStore.getMostRecentConversation();
    if (!conversation) {
      return res.json({ conversation: null, messages: [], pendingApproval: null });
    }
    res.json({
      conversation,
      messages: conversationStore.listMessages(conversation.id),
      pendingApproval: chatService ? chatService.pendingApprovalFor(conversation.id) : null,
    });
  } catch (err: any) {
    handleError(res, err, 'conversations.recent_error');
  }
});

app.get('/api/conversations/:id', (req, res) => {
  try {
    const conversation = conversationStore.getConversation(req.params.id);
    if (!conversation) throw new ConversationNotFoundError(req.params.id);
    res.json({
      conversation,
      messages: conversationStore.listMessages(conversation.id),
      pendingApproval: chatService ? chatService.pendingApprovalFor(conversation.id) : null,
      topics: topics.topicsForConversation(conversation.id),
    });
  } catch (err: any) {
    handleError(res, err, 'conversations.get_error', { id: req.params.id });
  }
});

app.delete('/api/conversations/:id', (req, res) => {
  try {
    const deleted = conversationStore.deleteConversation(req.params.id);
    if (!deleted) throw new ConversationNotFoundError(req.params.id);
    activityLog.warn('conversation.deleted', { conversationId: req.params.id });
    res.json({ deleted: true });
  } catch (err: any) {
    handleError(res, err, 'conversations.delete_error', { id: req.params.id });
  }
});

// ------------------------------------------------------------------------ chat

app.post('/api/chat', async (req, res) => {
  const service = requireChatService(res);
  if (!service) return;

  const { message, conversationId, channel } = req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message は必須です。', code: 'invalid_message' });
  }
  // Anything unrecognised reads as text. A malformed channel must shape the
  // reply wrongly at worst, never reject a turn the user is waiting on.
  const replyChannel = channel === 'voice' ? 'voice' : 'text';

  try {
    const result = await service.sendMessage({ conversationId, message, channel: replyChannel });
    // Deterministic, free, and stored as a heuristic — never as fact.
    try {
      topics.autoAssociate(result.conversationId, message);
    } catch {
      /* association must never fail a chat turn */
    }
    res.json({ ...result, topics: topics.topicsForConversation(result.conversationId).map((t) => ({
      slug: t.slug, name: t.name, source: t.link.source, confidence: t.link.confidence,
    })) });
  } catch (err: any) {
    handleError(res, err, 'chat.error', { conversationId });
  }
});

/**
 * The same turn, delivered as it is written.
 *
 * A separate route rather than a mode on /api/chat, and deliberately so: that
 * endpoint is used by the voice path, by tests and by anything else that wants
 * one answer, and none of them should have to change because a browser wanted
 * to watch. Nothing about the existing route moved.
 *
 * Server-sent events rather than a socket. This is one direction, one request,
 * and it reconnects by itself; a socket would be a second protocol to keep
 * alive for no capability that is needed here.
 *
 * Every outcome arrives as an event, including failure. A stream that ends
 * because the connection broke and a stream that ends because the model
 * refused look identical from the client, so the difference is stated rather
 * than inferred.
 */
app.post('/api/chat/stream', async (req, res) => {
  const service = requireChatService(res);
  if (!service) return;

  const { message, conversationId, channel } = req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message は必須です。', code: 'invalid_message' });
  }
  const replyChannel = channel === 'voice' ? 'voice' : 'text';

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Proxies that buffer would defeat the entire point of this route.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  /**
   * The client going away must stop the work, not just the writing.
   *
   * Watched on the response, not the request. `req`'s close event fires when
   * the request body has been read, which for a small POST is immediately —
   * long before the model has answered. Written against `req` this suppressed
   * every delta while letting `reset` through, because reset happens
   * synchronously before the event lands, and `done` through because it did
   * not consult the flag. The result was a stream that carried no stream, with
   * every individual file looking correct.
   *
   * A response closing before it ended is the client leaving. A response
   * closing after it ended is the normal case and means nothing.
   */
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) aborted = true;
  });

  try {
    const result = await service.sendMessage({
      conversationId,
      message,
      channel: replyChannel,
      stream: {
        delta: (text) => {
          if (!aborted) send('delta', { text });
        },
        // A retry starts the reply over; the reader has to be told to drop
        // whatever the failed attempt had already shown them.
        reset: () => {
          if (!aborted) send('reset', {});
        },
        phase: (name) => {
          if (!aborted) send('phase', { name });
        },
      },
    });

    try {
      topics.autoAssociate(result.conversationId, message);
    } catch {
      /* association must never fail a chat turn */
    }

    if (aborted) return;
    send('done', {
      ...result,
      topics: topics.topicsForConversation(result.conversationId).map((t) => ({
        slug: t.slug, name: t.name, source: t.link.source, confidence: t.link.confidence,
      })),
    });
  } catch (err: any) {
    activityLog.error('chat.stream_error', {
      conversationId,
      message: err?.message || String(err),
    });
    send('failed', { error: err?.message || String(err), code: err?.code ?? null });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.post('/api/chat/approve', async (req, res) => {
  const service = requireChatService(res);
  if (!service) return;

  const { sessionId, approved } = req.body ?? {};
  if (typeof sessionId !== 'string' || !sessionId) {
    return res.status(400).json({ error: 'sessionId は必須です。', code: 'invalid_session' });
  }
  if (typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'approved は boolean である必要があります。', code: 'invalid_decision' });
  }

  try {
    const result = await service.resolveApproval(sessionId, approved);
    res.json(result);
  } catch (err: any) {
    handleError(res, err, 'approval.error', { sessionId });
  }
});

// Globally discoverable pending approvals (decision 8.7).
app.get('/api/approvals/pending', (_req, res) => {
  try {
    const pending = approvalStore.listPending().map((record) => ({
      id: record.approvalId,
      sessionId: record.sessionId,
      conversationId: record.conversationId,
      conversationTitle: record.conversationId
        ? conversationStore.getConversation(record.conversationId)?.title ?? null
        : null,
      toolName: record.toolName,
      riskLevel: record.riskLevel,
      /**
       * What this call does, in a sentence.
       *
       * Recomputed rather than stored, because the tool is the authority on
       * what its arguments mean and a summary frozen at save time would drift
       * from the tool that will actually run. It travels with the list so a
       * surface that is not the chat window can still show a person what they
       * are agreeing to — which is the difference between offering an approval
       * button and offering a button.
       */
      summary: (() => {
        try {
          const tool = defaultToolRegistry.get(record.toolName);
          return tool?.summarise?.(JSON.parse(record.argsJson)) ?? null;
        } catch {
          return null;
        }
      })(),
      createdAt: record.createdAt,
    }));
    res.json({ pendingApprovals: pending });
  } catch (err: any) {
    handleError(res, err, 'approvals.list_error');
  }
});

// ----------------------------------------------------------------- development

app.post('/api/dev/tasks', async (req, res) => {
  try {
    const task = await development.createTask(req.body ?? {});
    res.status(201).json({ task });
  } catch (err: any) {
    if (/必須|指定してください/.test(err?.message || '')) {
      return res.status(400).json({ error: err.message, code: 'invalid_task' });
    }
    handleError(res, err, 'dev.task_create_error');
  }
});

app.get('/api/dev/tasks', (req, res) => {
  try {
    res.json({ tasks: development.listTasks({ status: req.query.status as any }) });
  } catch (err: any) {
    handleError(res, err, 'dev.task_list_error');
  }
});

// Registered before /:id so these are not read as task ids.
/**
 * 委任した実行の台帳。**再起動をまたいで残る分。**
 *
 * `state: 'running'` のまま残っている行は、**プロセスが死んだのに終わりが
 * 書かれなかった実行。**書き換えずにそのまま返す —— 「動いている」と
 * 「動いていたが分からなくなった」は別のことで、機械が後者を前者に
 * 書き換えるのは、記録ではなく作り話。
 */
app.get('/api/delegated/runs', (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '30'), 10) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = delegatedRuns.since(since);
  const live = new Set(agents.list().filter((r) => r.state === 'running').map((r) => r.id));
  res.json({
    days,
    runs: rows,
    /** 台帳では走っているが、いまのプロセスは知らないもの。 */
    orphaned: rows.filter((r) => r.state === 'running' && !live.has(r.id)).map((r) => r.id),
  });
});

app.get('/api/dev/runs/active', (_req, res) => {
  try {
    res.json({ runs: development.listActiveRuns() });
  } catch (err: any) {
    handleError(res, err, 'dev.runs_active_error');
  }
});

app.get('/api/dev/runs/stalled', (_req, res) => {
  try {
    res.json({ runs: development.listStalledRuns() });
  } catch (err: any) {
    handleError(res, err, 'dev.runs_stalled_error');
  }
});

app.get('/api/dev/tasks/:id', (req, res) => {
  try {
    res.json({ task: development.getTask(req.params.id) });
  } catch (err: any) {
    handleError(res, err, 'dev.task_get_error', { id: req.params.id });
  }
});

app.patch('/api/dev/tasks/:id', (req, res) => {
  try {
    res.json({ task: development.updateTask(req.params.id, req.body ?? {}) });
  } catch (err: any) {
    handleError(res, err, 'dev.task_update_error', { id: req.params.id });
  }
});

app.post('/api/dev/tasks/:id/decisions', (req, res) => {
  try {
    const { decision } = req.body ?? {};
    if (typeof decision !== 'string' || !decision.trim()) {
      return res.status(400).json({ error: 'decision は必須です。', code: 'invalid_decision' });
    }
    res.status(201).json({ task: development.appendDecision(req.params.id, decision.trim()) });
  } catch (err: any) {
    handleError(res, err, 'dev.decision_error', { id: req.params.id });
  }
});

/**
 * Generates the canonical handoff. `?format=markdown` returns the pasteable
 * form, which is the practical value until IRIS invokes agents itself.
 */
app.get('/api/dev/tasks/:id/handoff', async (req, res) => {
  try {
    const role = (req.query.role as any) || 'implement';
    const agent = (req.query.agent as string) || 'unassigned';
    if (req.query.format === 'markdown') {
      const markdown = await development.renderHandoff(req.params.id, role, agent);
      res.type('text/markdown; charset=utf-8').send(markdown);
      return;
    }
    res.json({ handoff: await development.buildHandoff(req.params.id, role, agent) });
  } catch (err: any) {
    handleError(res, err, 'dev.handoff_error', { id: req.params.id });
  }
});

app.post('/api/dev/tasks/:id/runs', async (req, res) => {
  try {
    const { agent, role } = req.body ?? {};
    if (typeof agent !== 'string' || !agent.trim()) {
      return res.status(400).json({ error: 'agent は必須です。', code: 'invalid_agent' });
    }
    const run = await development.startRun({
      taskId: req.params.id,
      agent: agent.trim(),
      role: role || 'implement',
    });
    res.status(201).json({ run });
  } catch (err: any) {
    handleError(res, err, 'dev.run_start_error', { id: req.params.id });
  }
});

app.get('/api/dev/runs/:id', (req, res) => {
  try {
    res.json({ run: development.getRun(req.params.id) });
  } catch (err: any) {
    handleError(res, err, 'dev.run_get_error', { id: req.params.id });
  }
});

app.post('/api/dev/runs/:id/heartbeat', (req, res) => {
  try {
    res.json({ run: development.heartbeat(req.params.id, req.body?.progress) });
  } catch (err: any) {
    handleError(res, err, 'dev.heartbeat_error', { id: req.params.id });
  }
});

app.post('/api/dev/runs/:id/block', (req, res) => {
  try {
    const { reason } = req.body ?? {};
    if (typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ error: 'reason は必須です。', code: 'invalid_reason' });
    }
    res.json({ run: development.blockRun(req.params.id, reason.trim()) });
  } catch (err: any) {
    handleError(res, err, 'dev.block_error', { id: req.params.id });
  }
});

app.post('/api/dev/runs/:id/result', (req, res) => {
  try {
    const { outcome, summary, detail } = req.body ?? {};
    if (!['success', 'partial', 'failure'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome は success/partial/failure です。', code: 'invalid_outcome' });
    }
    if (typeof summary !== 'string' || !summary.trim()) {
      return res.status(400).json({ error: 'summary は必須です。', code: 'invalid_summary' });
    }
    const run = development.recordResult({ runId: req.params.id, outcome, summary, detail });
    res.status(201).json({ run });
  } catch (err: any) {
    handleError(res, err, 'dev.result_error', { id: req.params.id });
  }
});

// -------------------------------------------------------------- memory & decisions

/**
 * What IRIS remembers, and what it may bring into a prompt.
 *
 * `shareable` is a query parameter rather than a default, because a caller
 * that has not thought about where the text is going should have to say so
 * rather than be handed the safe answer and never learn the question exists.
 */
app.get('/api/memory', (req, res) => {
  try {
    res.json({
      summary: memories.summary(),
      memories: memories.recall({
        kind: req.query.kind as string | undefined,
        shareableOnly: req.query.shareable === 'true',
        includeStale: req.query.stale === 'true',
        limit: Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200),
      }),
      note:
        '出所(provenance)が user / measured / inferred / external で、外部由来は事実として扱いません。' +
        'privacy=local_only の記憶は shareable=true では返りません。',
    });
  } catch (err) {
    handleError(res, err, 'memory.list_error');
  }
});

app.post('/api/memory', (req, res) => {
  try {
    const { stored, reason } = memories.remember(req.body ?? {});
    /*
     * 申告と違う形で入ったときは、それだけを一語で言う。
     *
     * 理由は前から `reason` に入っていたが、**格下げされたかどうかを見るのに
     * 日本語の文を読ませていた。**書き戻しは `curl -s` で投げっぱなしにされる
     * ので、誰も読まない。結果として 2026-09-07 の時点で 116 件中 88 件が
     * 推論になっており、そのうち何件かは出所に「実測」と書いてあった。
     *
     * `demoted` は申告した出所と入った出所が違うときだけ現れる。毎回出る欄は
     * 読み飛ばされる。
     */
    const asked = typeof req.body?.provenance === 'string' ? req.body.provenance : null;
    const demoted = stored && asked && stored.provenance !== asked ? { asked, storedAs: stored.provenance } : undefined;
    res.status(stored ? 201 : 400).json({ memory: stored, reason, demoted });
  } catch (err) {
    handleError(res, err, 'memory.remember_error');
  }
});

/**
 * Why things were decided the way they were.
 *
 * `unweighed` is where to look first when a choice turns out badly — not a
 * fault list, but "nothing else was considered" is the most common reason.
 */
/**
 * What any session on this machine should know before it starts.
 *
 * Three coding assistants run here — Claude, Codex, Gemini — and each one
 * begins every session knowing nothing. On 2026-08-23 that cost a full day:
 * one session pushed a fix to a repository that production does not deploy
 * from, another killed a working Gemini run after three minutes because
 * `-p` prints nothing until it finishes, and a third asked who had added
 * sixty megabytes of application documents to the product repository —
 * which had been done forty minutes earlier by a fourth. Every one of those
 * facts was already known somewhere on this machine.
 *
 * So this is one URL that answers "what do I need to know". It composes what
 * the stores already hold and invents nothing: the decisions that stand, the
 * measured facts about the tools, what each repository actually is, and how
 * much of each week's allowance is left. A session reads it at the start and
 * writes back what it learns, which is what makes the next session start
 * further along than this one did.
 *
 * Deliberately one request. A briefing spread over six endpoints is a
 * briefing nobody assembles.
 */
/**
 * The briefing as a value, so it can be served and also written down.
 *
 * Written down because the socket is not always reachable. Codex runs its
 * commands inside a seatbelt that refuses network access, and `127.0.0.1` is
 * not exempt: measured 2026-08-23, `curl http://127.0.0.1:3002/api/briefing`
 * from inside a Codex run returns 000, and 200 with the sandbox's network
 * flag set. A session that cannot reach this concluded IRIS was not running
 * and answered from stale local files instead — which is the exact failure
 * the briefing exists to prevent, reported as IRIS's fault.
 *
 * Reads outside the workspace are allowed in that sandbox, so a file gets
 * through where a socket does not. `generatedAt` travels with it, so a reader
 * can see how old it is rather than trusting it blindly.
 */
function briefingPayload(limit: number) {
  const usage = readClaudeUsage(os.homedir());
  const codexUsage = cliUsage.read()?.codex ?? null;

  // Shareable only. A briefing is read by three vendors' models, so
  // anything the memory store marked private stays where it is.
  const facts = memories
    .recall({ shareableOnly: true, limit: 60 })
    .filter((m) => ['tool_behaviour', 'finding', 'repository', 'environment'].includes(m.kind));

  return {
    generatedAt: new Date().toISOString(),
    iris: {
      base: `http://127.0.0.1:${PORT}`,
      note: 'IRIS はこの機械の常駐アシスタントです。分からないことはここに聞き、学んだことはここに書き戻してください。',
      offlineCopy: BRIEFING_FILE,
    },
    decisions: decisions.list({ limit }).map((d) => ({
      title: d.title,
      decided: d.decided,
      decidedBy: d.decidedBy,
      grounds: d.grounds,
    })),
    facts: facts.map((m) => ({
      kind: m.kind,
      content: m.content,
      provenance: m.provenance,
      source: m.source,
      confidence: m.confidence,
    })),
    repositories: agentPolicy.allowedRepos,
    /**
     * Named for what the number is, because the wording said the opposite.
     *
     * The field was `codexWeekPercent` with a note about 「残量」 — remaining —
     * while the value is the fraction *used*. On 2026-08-28 a session read
     * `codexWeekPercent: 0` as "no allowance left" and planned around not
     * using Codex, when nothing had been used at all. The two words mean
     * opposite things and both were in the same object.
     *
     * Backwards is worse than absent here: a session reading 90 as "90% left"
     * would send work to an agent that is nearly spent.
     */
    allowance: {
      claudeWeekUsedPercent: usage.week?.usedPercent ?? null,
      codexWeekUsedPercent: codexUsage?.usedPercent ?? null,
      note:
        'これは「使った割合」です。残量ではありません。0 は「まだ使っていない」で、' +
        '100 が「使い切った」です。委任先は使った割合が少ない方が選ばれます。' +
        'null は「読めなかった」で、0 ではありません。',
      /**
       * Volatile, and said so.
       *
       * The briefing is read once at the start of a session and kept, which is
       * right for a decision and wrong for a meter. Anything acting on these
       * numbers has to take them again.
       */
      freshness: 'この2つの数字は分単位で変わります。判断に使う直前に GET /api/usage/cli で取り直してください。',
    },
    /**
     * 切れている認可だけを出す。
     *
     * 生きている認可を毎回並べると、いつか壊れたものを載せる欄が「毎回同じことが
     * 書いてある欄」として読み飛ばされる。**言うことがある時だけ現れる。**
     *
     * `unknown`（測れなかった）は警告にしない。Google が落ちているのと Google に
     * 断られたのは別のことで、前者を後者として報告すると、要らない再認可に人を
     * 送ることになる。
     */
    credentials: (() => {
      const warning = grantWarning(lastGrantHealth);
      if (!warning) return undefined;
      return {
        warning,
        expired: lastGrantHealth
          .filter((g) => g.liveness === 'dead')
          .map((g) => ({ service: g.service, reason: g.reason, grantedAt: g.grantedAt })),
        checkedAt: grantHealthCheckedAt,
        howTo: 'POST /api/google/oauth/start {service} で再認可を始められます。',
      };
    })(),
    /*
     * 書き戻し方の案内。**evidence を必ず載せる。**
     *
     * ここが `evidence` の無い形を案内していたせいで、2026-09-07 の時点で
     * 記憶 116 件のうち 88 件が `inferred` になっていた。`admit()` は根拠を
     * 指せない `measured` を推論へ落とす（`server/core/memory.ts`）ので、
     * **案内どおりに書く限り、実測しても 100% 格下げされる。**格下げの理由は
     * 201 の応答に入るが、`curl -s` の出力は読まれないので誰も気づかず、
     * 「2026-09-07 実測（実際に飛ばした）」と出所に書かれた記憶が推論として
     * 一年分積み上がった。
     *
     * 規則そのものは正しい —— 根拠を指せない計測は、計測の服を着た主張。
     * **直すのは案内の側。**
     */
    writeBack: {
      fact:
        'POST /api/memory  {kind, content, provenance:"measured"|"user"|"external", source, confidence, evidence:[]}',
      decision: 'POST /api/decisions  {title, decided, decidedBy, grounds:[]}',
      note:
        '測ったことは measured、利用者が言ったことは user。推測は書かないでください。' +
        'measured には evidence（測った先のファイル:行、コマンド、URL）を必ず付けてください。' +
        '**空だと推論(confidence 0.7)へ落として記録されます。**',
    },
  };
}

const BRIEFING_FILE = path.join(os.homedir(), '.iris', 'briefing.json');

/**
 * Kept current on disk, for readers who cannot open a socket.
 *
 * Every five minutes rather than on every write: the allowance moves hourly
 * and a fact written now is worth reading in a few minutes, so a fresher copy
 * would cost writes without answering a question any better. Failures are
 * swallowed — a briefing that could not be written is not a reason to take
 * the process down, and the endpoint still answers.
 */
function writeBriefingFile(): void {
  try {
    fsMkdirSync(path.dirname(BRIEFING_FILE), { recursive: true });
    fsWriteFileSync(BRIEFING_FILE, JSON.stringify(briefingPayload(12), null, 2), 'utf-8');
  } catch (err: any) {
    activityLog.warn('briefing.file_write_failed', { message: err?.message || String(err) });
  }
}

app.get('/api/briefing', (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '12'), 10) || 12, 1), 50);
    res.json(briefingPayload(limit));
  } catch (err) {
    handleError(res, err, 'briefing.error');
  }
});

app.get('/api/decisions', (req, res) => {
  try {
    if (req.query.affecting) {
      res.json({ decisions: decisions.affecting(String(req.query.affecting)) });
      return;
    }
    if (req.query.unweighed === 'true') {
      res.json({
        decisions: decisions.unweighed(),
        note: '代替案を比較せずに決めたものです。誤りとは限りませんが、見直すならここから。',
      });
      return;
    }
    res.json({
      decisions: decisions.list({
        includeRevised: req.query.revised === 'true',
        decidedBy: req.query.by as string | undefined,
        limit: Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200),
      }),
    });
  } catch (err) {
    handleError(res, err, 'decisions.list_error');
  }
});

app.post('/api/decisions', (req, res) => {
  try {
    const { stored, reason } = decisions.record(req.body ?? {});
    /**
     * A correction marks what it corrects.
     *
     * The store has carried `revisedBy` from the start and nothing could set
     * it, so a decision that had been superseded still read as current — two
     * contradictory records, both looking equally live, with only their
     * timestamps to tell them apart. The old row is never edited or removed:
     * having believed something is part of the record, and the point is to
     * make the supersession visible rather than to hide the first answer.
     */
    let revised: string | null = null;
    const revises = typeof req.body?.revises === 'string' ? req.body.revises : null;
    if (stored && revises && decisions.revise(revises, stored.id)) revised = revises;
    res.status(stored ? 201 : 400).json({ decision: stored, reason, revised });
  } catch (err) {
    handleError(res, err, 'decisions.record_error');
  }
});

/**
 * What has been tried, and how it went.
 *
 * `recurring=true` is the list worth reading before starting anything: the
 * attempts that have gone wrong more than once in the same shape.
 */
app.get('/api/experiences', (req, res) => {
  try {
    if (req.query.recurring === 'true') {
      res.json({
        experiences: experiences.recurringFailures(),
        note: '同じ形で複数回失敗した試みです。',
      });
      return;
    }
    if (req.query.inconsistent === 'true') {
      res.json({
        experiences: experiences.inconsistent(),
        note: '成功と失敗の両方が観測された試みです。条件が違っています。',
      });
      return;
    }
    res.json({
      experiences: req.query.about
        ? experiences.lookup(String(req.query.about))
        : experiences.list(Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200)),
      note: '観測回数を確認してください。1回の成功は根拠であって法則ではありません。',
    });
  } catch (err) {
    handleError(res, err, 'experiences.list_error');
  }
});

app.post('/api/experiences', (req, res) => {
  try {
    const { stored, reason } = experiences.record(req.body ?? {});
    res.status(stored ? 201 : 400).json({ experience: stored, reason });
  } catch (err) {
    handleError(res, err, 'experiences.record_error');
  }
});

/**
 * これからやろうとしていることが、記録された失敗と同じ形か。
 *
 * `experience.ts` の冒頭が、この口が無かったことの結果をそのまま書いている
 * —— 同じ形で三度失敗した試みが三件あり、「Each was noticed, fixed, and then
 * repeated」。読む口（`GET /api/experiences?recurring=true`、MCP の `attempts`）
 * は前からあった。**読まれなかった。**
 *
 * だから読む側ではなく、**やる側から呼ぶ**。`scripts/repeat-guard.ts` が
 * Claude Code の PreToolUse から叩き、該当すれば命令が走る前に止まる。
 *
 * `coverage` を必ず返す。**0件は「問題なし」ではない** —— 判断についての失敗
 * （「テストが通ったから正しい」）は命令に現れないので述語では捕まえられず、
 * それを黙って落とすと、覚えていることと止められることの差が消える。
 */
/**
 * サーバが止まった瞬間と、そのとき走っていた仕事。
 *
 * 止まっていることは外からも分かるが、**何が止めたかは中でしか分からない。**
 * 2026-09-28 にこれを追うのに、周期の仕事を一つずつ当たって半日かけた。
 * 次は当たらずに読めるように。
 *
 * `during` が null の停止は「名乗っていない仕事」で、**無事ではない。**
 */
app.get('/api/health/stalls', (_req, res) => {
  res.json({
    stalls: loopWatch.recent(),
    summary: loopWatch.summary(),
    /** 長くかかった区間。停止が「不明」のときは、ここから辿る。 */
    slowest: loopWatch.slowest(),
    running: loopWatch.current(),
    note: 'during が null の停止は、名乗っていない仕事です（無事ではありません）。300ms 未満は残していません。',
  });
});

app.post('/api/experiences/check', (req, res) => {
  try {
    const recurring = experiences.recurringFailures().map((e) => ({
      attempt: e.attempt, learned: e.learned, observations: e.observations,
    }));
    const hits = guardAgainstRepeats({ command: typeof req.body?.command === 'string' ? req.body.command : undefined }, recurring);
    res.json({
      hits,
      explain: hits.length ? explainHits(hits) : null,
      coverage: coverage(recurring),
      note: '該当0件は「安全」ではありません。coverage.uncovered は覚えているが止められない失敗です。',
    });
  } catch (err) {
    handleError(res, err, 'experiences.check_error');
  }
});

// -------------------------------------------------------------- future features

app.get('/api/register', (req, res) => {
  try {
    res.json({
      counts: register.counts(),
      features: register.list({
        status: req.query.status as any,
        domain: req.query.domain as string | undefined,
      }),
    });
  } catch (err: any) {
    handleError(res, err, 'register.list_error');
  }
});

app.get('/api/register/boundaries', (_req, res) => {
  try {
    res.json({
      note: 'これらは IRIS 側からは変更できません。',
      boundaries: register.boundaries(),
    });
  } catch (err: any) {
    handleError(res, err, 'register.boundaries_error');
  }
});

app.get('/api/register/due-for-review', (req, res) => {
  try {
    const days = req.query.maxAgeDays ? parseInt(String(req.query.maxAgeDays), 10) : 90;
    res.json({ features: register.dueForReview(Number.isFinite(days) ? days : 90) });
  } catch (err: any) {
    handleError(res, err, 'register.review_error');
  }
});

app.get('/api/register/search', (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.status(400).json({ error: 'q は必須です。', code: 'invalid_query' });
    res.json({ features: register.search(q) });
  } catch (err: any) {
    handleError(res, err, 'register.search_error');
  }
});

app.get('/api/register/:key', (req, res) => {
  try {
    res.json({ feature: register.get(req.params.key) });
  } catch (err: any) {
    handleError(res, err, 'register.get_error', { key: req.params.key });
  }
});

app.post('/api/register', (req, res) => {
  try {
    res.status(201).json({ feature: register.create(req.body ?? {}) });
  } catch (err: any) {
    if (/必須/.test(err?.message || '')) {
      return res.status(400).json({ error: err.message, code: 'invalid_feature' });
    }
    handleError(res, err, 'register.create_error');
  }
});

app.patch('/api/register/:key', (req, res) => {
  try {
    res.json({ feature: register.update(req.params.key, req.body ?? {}) });
  } catch (err: any) {
    handleError(res, err, 'register.update_error', { key: req.params.key });
  }
});

app.post('/api/register/:key/reviewed', (req, res) => {
  try {
    res.json({ feature: register.markReviewed(req.params.key, req.body?.note) });
  } catch (err: any) {
    handleError(res, err, 'register.reviewed_error', { key: req.params.key });
  }
});

/** Turns a register entry into real work. Boundary entries are refused here. */
app.post('/api/register/:key/promote', async (req, res) => {
  try {
    const result = await register.promoteToTask(req.params.key, {
      successCriteria: req.body?.successCriteria,
    });
    res.status(201).json(result);
  } catch (err: any) {
    handleError(res, err, 'register.promote_error', { key: req.params.key });
  }
});

// ---------------------------------------------------------------------- topics

app.get('/api/topics', (req, res) => {
  try {
    res.json({ topics: topics.listTopics({ status: req.query.status as any }) });
  } catch (err: any) {
    handleError(res, err, 'topics.list_error');
  }
});

app.post('/api/topics', (req, res) => {
  try {
    res.status(201).json({ topic: topics.createTopic(req.body ?? {}) });
  } catch (err: any) {
    if (/必須|既に存在/.test(err?.message || '')) {
      return res.status(400).json({ error: err.message, code: 'invalid_topic' });
    }
    handleError(res, err, 'topics.create_error');
  }
});

app.get('/api/topics/:ref', (req, res) => {
  try {
    res.json({ topic: topics.getTopic(req.params.ref) });
  } catch (err: any) {
    handleError(res, err, 'topics.get_error', { ref: req.params.ref });
  }
});

app.patch('/api/topics/:ref', (req, res) => {
  try {
    res.json({ topic: topics.updateTopic(req.params.ref, req.body ?? {}) });
  } catch (err: any) {
    handleError(res, err, 'topics.update_error', { ref: req.params.ref });
  }
});

/** Linking by hand is the strongest claim there is, so it is recorded as such. */
app.post('/api/topics/:ref/conversations/:conversationId', (req, res) => {
  try {
    const link = topics.link({
      conversationId: req.params.conversationId,
      topicRef: req.params.ref,
      source: 'user',
      evidence: req.body?.reason ?? null,
    });
    res.status(201).json({ link });
  } catch (err: any) {
    handleError(res, err, 'topics.link_error', { ref: req.params.ref });
  }
});

app.delete('/api/topics/:ref/conversations/:conversationId', (req, res) => {
  try {
    res.json({ removed: topics.unlink(req.params.conversationId, req.params.ref) });
  } catch (err: any) {
    handleError(res, err, 'topics.unlink_error', { ref: req.params.ref });
  }
});

// ---------------------------------------------------------------------- review

app.get('/api/review/capability', (req, res) => {
  // Optionally asked about a specific task, so the answer reflects who would
  // actually be reviewing whose work rather than a startup assumption.
  const implementer = typeof req.query.taskId === 'string' ? implementerOfTask(req.query.taskId) : undefined;
  const reviewers = review.availableReviewers(implementer);
  res.json({
    canReview: review.canReview(),
    implementer: primaryProviderId,
    implementerModel: activeProvider?.currentModel ?? null,
    availableReviewers: reviewers.map(({ key, provider }) => ({
      id: key,
      vendor: provider.vendor,
      model: provider.currentModel,
    })),
    note: review.canReview()
      ? '実装モデルとは別のモデルでレビューできます。'
      : '実装モデル以外が未設定です。自己レビューは独立した第二意見にならないため実行しません。',
  });
});

/**
 * Starts a review. A code-bearing review can run for minutes, so the request
 * does not wait for it: the run record already exists to be polled, which is
 * what the agent-run model is for. `wait=true` blocks for callers that want
 * the old behaviour.
 */
/**
 * Who wrote the work under review, when it was not IRIS.
 *
 * A delegated run is written by a coding agent, and the vendor behind that
 * agent is what decides whether a reviewer is genuinely from somewhere else.
 * Without this the service assumed IRIS's own provider had implemented
 * everything — and with Gemini configured as that provider, Gemini was the
 * one candidate ruled out of reviewing work it had nothing to do with. The
 * strongest available independence was being discarded by a mismatch.
 */
const AGENT_VENDOR: Record<string, { model: string; vendor: string }> = {
  'claude-code': { model: 'claude-code', vendor: 'anthropic' },
  'codex-cli': { model: 'codex-cli', vendor: 'openai' },
};

function implementerOfTask(taskId: string): { model: string; vendor: string } | undefined {
  try {
    const runs = development.getTask(taskId).runs.filter((r) => r.role === 'implement');
    const last = runs[runs.length - 1];
    if (!last?.agent) return undefined;
    // `agent` is either a coding agent's label or `provider:model`.
    const known = AGENT_VENDOR[last.agent];
    if (known) return known;
    const [vendor, ...rest] = last.agent.split(':');
    return rest.length ? { model: rest.join(':'), vendor } : undefined;
  } catch {
    // A task with no implement run yet reviews against IRIS's own provider,
    // which is what the service did for everything before this existed.
    return undefined;
  }
}

app.post('/api/dev/tasks/:id/review', async (req, res) => {
  const taskId = req.params.id;
  const reviewerId = req.body?.reviewerId;

  if (req.query.wait === 'true') {
    try {
      res.status(201).json(
        await review.reviewTask(taskId, { reviewerId, implementer: implementerOfTask(taskId) })
      );
    } catch (err: any) {
      handleError(res, err, 'review.error', { id: taskId });
    }
    return;
  }

  try {
    // The run row is created synchronously, so the response can name it and a
    // client that polls immediately finds it. Reviewer availability and
    // duplicate rejection are resolved here too, rather than in the background
    // where the caller would never see them.
    const prepared = await review.prepareRun(taskId, { reviewerId });

    review.executePreparedRun(taskId, prepared).catch((err) => {
      activityLog.error('review.background_failed', {
        message: err?.message ?? String(err),
        detail: { taskId, runId: prepared.run.id },
      });
    });

    res.status(202).json({
      status: 'running',
      taskId,
      runId: prepared.run.id,
      reviewer: prepared.selected.provider.currentModel,
      independence: prepared.independence,
      note: `レビューを開始しました。GET /api/dev/runs/${prepared.run.id} で進捗と結果を確認できます。`,
    });
  } catch (err: any) {
    handleError(res, err, 'review.error', { id: taskId });
  }
});

// ----------------------------------------------------------------------- usage

/**
 * What IRIS has actually consumed. Costs are estimates from a local price
 * table, so the response always carries the date that table was last verified
 * — a stale price produces a wrong number rather than an error.
 */
app.get('/api/usage', (req, res) => {
  try {
    const days = req.query.days ? parseInt(String(req.query.days), 10) : 7;
    const since = Date.now() - (Number.isFinite(days) ? days : 7) * 24 * 60 * 60 * 1000;

    const entries = activityLog
      .list({ limit: 1000 })
      .filter((e) => e.event === 'run.usage' && Date.parse(e.createdAt) >= since);

    const byModel: Record<string, any> = {};
    // Grouped by model AND settings, because "was medium enough?" cannot be
    // answered from a per-model total alone.
    const bySetting: Record<string, any> = {};
    let totalUsd = 0;
    let unpriced = 0;

    for (const entry of entries) {
      const d = entry.detail ?? {};
      const model = d.model ?? 'unknown';
      const settingsKey = d.settings
        ? Object.entries(d.settings).map(([k, v]) => `${k}=${v}`).sort().join(' ')
        : 'unknown';
      const combo = `${model} [${settingsKey}]`;
      const comboBucket = (bySetting[combo] ??= { runs: 0, usd: 0, inputTokens: 0, outputTokens: 0 });
      comboBucket.runs += 1;
      comboBucket.usd += d.usd ?? 0;
      comboBucket.inputTokens += d.usage?.inputTokens ?? 0;
      comboBucket.outputTokens += d.usage?.outputTokens ?? 0;

      const bucket = (byModel[model] ??= {
        runs: 0,
        providerCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        usd: 0,
        priced: d.priced !== false,
      });
      bucket.runs += 1;
      bucket.providerCalls += d.calls ?? 0;
      bucket.inputTokens += d.usage?.inputTokens ?? 0;
      bucket.outputTokens += d.usage?.outputTokens ?? 0;
      bucket.cacheReadTokens += d.usage?.cacheReadTokens ?? 0;
      bucket.usd += d.usd ?? 0;
      totalUsd += d.usd ?? 0;
      if (d.priced === false) unpriced += 1;
    }

    for (const bucket of [...Object.values(byModel), ...Object.values(bySetting)] as any[]) {
      bucket.usd = Math.round(bucket.usd * 1_000_000) / 1_000_000;
      if (bucket.runs > 0) bucket.usdPerRun = Math.round((bucket.usd / bucket.runs) * 1_000_000) / 1_000_000;
    }

    res.json({
      windowDays: Number.isFinite(days) ? days : 7,
      runs: entries.length,
      totalUsd: Math.round(totalUsd * 1_000_000) / 1_000_000,
      totalDisplay: formatCost({ usd: totalUsd, model: 'all', priced: unpriced === 0, pricingLastVerified: PRICING_LAST_VERIFIED }),
      unpricedRuns: unpriced,
      pricingLastVerified: PRICING_LAST_VERIFIED,
      note: 'コストは内蔵の価格表による推定です。実際の請求は各プロバイダのダッシュボードを確認してください。',
      byModel,
      bySetting,
    });
  } catch (err: any) {
    handleError(res, err, 'usage.error');
  }
});

// -------------------------------------------------------------------- activity

app.get('/api/activity', (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
    res.json({
      entries: activityLog.list({
        conversationId: req.query.conversationId ? String(req.query.conversationId) : undefined,
        level: req.query.level as any,
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    });
  } catch (err: any) {
    handleError(res, err, 'activity.list_error');
  }
});

/**
 * What each provider actually serves, asked rather than assumed.
 *
 * A hardcoded model id rots silently — that is how a retired Anthropic model
 * sat in this codebase until a key was finally supplied. Discovery is the
 * remedy: never maintain the list, ask for it.
 */
/**
 * Cached, because each call reaches every configured provider. Cross-provider
 * review flagged this as an amplifier: an unauthenticated caller could drive
 * repeated upstream requests and read back model names and error detail.
 * IRIS binds to localhost, so the cache is the proportionate fix; a real auth
 * layer belongs with the surface-capability work, not here.
 */
let modelDiscoveryCache: { at: number; payload: any } | null = null;
const MODEL_DISCOVERY_TTL_MS = 10 * 60 * 1000;

app.get('/api/models', async (req, res) => {
  try {
    if (modelDiscoveryCache && Date.now() - modelDiscoveryCache.at < MODEL_DISCOVERY_TTL_MS && req.query.refresh !== 'true') {
      return res.json({ ...modelDiscoveryCache.payload, cached: true });
    }
    const discovery = await discoverAll();
    const checks = checkConfigured(discovery);
    for (const check of checks) modelChecks.record(check);

    const payload = {
      checkedAt: new Date().toISOString(),
      note: 'この一覧はプロバイダに問い合わせた実際の値です。内蔵リストではありません。',
      configured: checks,
      // What was known before this request, so "it was fine an hour ago" is
      // answerable after a restart.
      lastVerified: modelChecks.list(),
      providers: discovery.map((d) => ({
        provider: d.provider,
        available: d.available,
        error: d.error,
        modelCount: d.models.length,
        models: d.models.slice(0, 40).map((m) => m.id),
      })),
    };
    modelDiscoveryCache = { at: Date.now(), payload };
    res.json({ ...payload, cached: false });
  } catch (err: any) {
    handleError(res, err, 'models.discovery_error');
  }
});

/**
 * Why today's tokens were billed where they were.
 *
 * Routing that silently picks a provider is routing the user cannot audit, and
 * the whole point of the order is cost. This answers "is the free tier being
 * used, and if not, why not, and when does it come back".
 */
app.get('/api/providers/routing', (_req, res) => {
  if (!router) {
    res.json({ routing: false, note: 'プロバイダが設定されていません。' });
    return;
  }
  res.json({
    routing: true,
    order: router.keys(),
    note: '上から順に試し、無料枠やクォータが尽きたものは自動的に飛ばします。',
    quotaResetTimeZone: process.env.IRIS_QUOTA_RESET_TZ || 'America/Los_Angeles',
    providers: router.health(),
  });
});

/**
 * Clears a cooldown. A cooldown is an estimate made before the user fixed
 * anything; after a top-up or a corrected key, waiting it out is pointless.
 */
app.post('/api/providers/routing/reset', (req, res) => {
  if (!router) {
    res.status(400).json({ error: 'プロバイダが設定されていません。' });
    return;
  }
  const key = typeof req.body?.provider === 'string' ? req.body.provider : undefined;
  const cleared = router.reset(key);
  activityLog.info('router.cooldown_cleared', {
    message: key ?? 'all',
    detail: { cleared },
  });
  res.json({ cleared, providers: router.health() });
});

/**
 * On-device speech input.
 *
 * The helper is a separate process because the Speech framework is Swift-only,
 * and that split is the privacy story: audio stays inside the child, only text
 * comes out. Nothing here forwards a transcript to a provider — the words wait
 * until something explicitly takes them, because a microphone that talks to a
 * model on its own is the one arrangement this design refuses to build.
 */
/**
 * Where to look for the compiled Swift helper.
 *
 * The working directory is right for every documented way of starting the
 * server; IRIS_ROOT is the escape hatch for launchd, which does not have to
 * agree. A wrong value is not silent — the bridge reports the paths it
 * searched.
 */
const REPO_ROOT = process.env.IRIS_ROOT?.trim() || process.cwd();

/**
 * What IRIS believes about the present moment.
 *
 * Observations go in with their source, confidence and timestamp; the current
 * state is derived on demand. Nothing here is persisted: a durable log of when
 * someone was home is a different kind of record from a conversation, and
 * keeping one is a decision for the user rather than a default.
 */
const contextStore = new SqliteContextStore(db);
const context = new ContextEngine({
  store: contextStore,
  onEvent: ({ type, detail }) => activityLog.log({ level: 'info', event: type, detail }),
});

/**
 * Speech is uncalibrated on purpose.
 *
 * The transcriber is accurate at turning sound into words, but "a transcript
 * appeared" is not the same claim as "a person is here" — during the first
 * live run a finalized Japanese sentence came back from a room with nobody
 * deliberately speaking into the microphone. Until that rate is measured, its
 * confidence is capped and labelled rather than believed.
 */
context.registerSource({ id: 'speech', label: 'オンデバイス音声', calibration: 'uncalibrated' });
/** The microphone's own state is not an inference — we set it. */
context.registerSource({ id: 'iris', label: 'IRIS 自身の状態', calibration: 'calibrated' });

context.registerKind({
  kind: 'presence.occupied',
  description: '人がいるか',
  validForMs: 10 * 60_000,
  halfLifeMs: 5 * 60_000,
});
context.registerKind({
  kind: 'speech.last_utterance',
  description: '直近の確定発話',
  validForMs: 15 * 60_000,
});
context.registerSource({ id: 'calendar', label: 'カレンダー', calibration: 'calibrated' });

context.registerKind({
  kind: 'calendar.next_event',
  description: '次の予定',
  // Long enough to still be useful, short enough that a cache nobody
  // refreshed stops being presented as current.
  validForMs: 6 * 60 * 60_000,
});

context.registerKind({
  kind: 'input.speech_listening',
  description: 'マイクが開いているか',
  validForMs: 24 * 60 * 60_000,
});

/*
 * ここから下は、**見ていないと気づけないもの**（利用者が選んだ四つ、
 * 2026-09-09）。画面に出ているものは規則にしない —— 次の予定も週の枠も
 * もうレールに在り、声で言い直すのは提案ではなく反復。
 */
context.registerSource({ id: 'iris.watch', label: 'IRIS の見張り', calibration: 'calibrated' });

context.registerKind({
  kind: 'delegation.finished',
  description: '委任した実行が終わった',
  /*
   * 30分。**終わった直後にだけ言う値打ちがある。**
   *
   * 長く保つと、同じ完了について何度も規則が当たる（規則は「その kind に
   * ついて何か分かっているか」で発火するので、生きている限り真）。
   * 繰り返しを止めるのは `cooldownMs` だが、**そもそも古い完了で発火しない**
   * 方が正しい。
   */
  validForMs: 30 * 60_000,
});

context.registerKind({
  kind: 'grant.dead',
  description: '切れている認可の数',
  // 切れたままなら切れたまま。時間で消えてはいけない。
  validForMs: 7 * 24 * 60 * 60_000,
});

context.registerKind({
  kind: 'lectures.new_version',
  description: '講義日程表の新しい版を取り込んだ',
  // 一度気づけば足りる。**取り込みは一回、比較の結果は一回だけ言う。**
  validForMs: 3 * 24 * 60 * 60_000,
});
context.registerKind({
  kind: 'lectures.divergent',
  description: '講義日程表とカレンダーの食い違いの件数',
  validForMs: 24 * 60 * 60_000,
});

context.registerKind({
  kind: 'deadline.pressing',
  description: '期限が迫っている、または過ぎている課題',
  /*
   * 一日で消える。**消えても、翌日また観測される** —— 過ぎた期限は翌日も
   * 過ぎたままなので、一度言って終わりにはならない。
   */
  validForMs: 20 * 60 * 60_000,
});

// Anything the user chose to keep and that is still inside its validity
// window comes back, so a restart does not make the house look empty when the
// answer was on disk the whole time. Kinds nobody enabled restore nothing,
// because nothing was written.
const restored = context.restore();
if (restored.length > 0) {
  console.log(`🧠 状況観測を復元: ${restored.map((r) => `${r.kind}×${r.restored}`).join(', ')}`);
}

/**
 * The present, assembled — and finally reachable from a conversation.
 *
 * Built here rather than with the other services because it reads the Context
 * Engine, and the Context Engine is only complete once its kinds are
 * registered above. It holds nothing of its own, so constructing it is free
 * and it can never be stale.
 *
 * Registering the tool here is what closes the actual gap: until now the only
 * consumer of everything IRIS believes about the present was the proactive
 * service, so in a conversation the model could see a clock and its long-term
 * memory and nothing between them.
 */
const lifeState = new LifeStateService({ context, memories });
defaultToolRegistry.registerAll(createLifeStateTools(lifeState));

/**
 * Local calendar. The cache the FDP dashboard maintains when it can, EventKit
 * when that is reachable — the reader picks whichever can actually answer and
 * reports which one did.
 */
/**
 * The live calendar source, when there is a credential for one.
 *
 * Constructed unconditionally — `configured()` decides at read time whether it
 * has anything to offer, so authorizing does not require a restart.
 */
const googleCalendar = new GoogleCalendarClient({
  store: oauthStore,
  clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim(),
  onEvent: ({ type, detail }) =>
    activityLog.log({ level: type.endsWith('_failed') ? 'warn' : 'info', event: type, detail }),
});

/**
 * iCloud, over CalDAV.
 *
 * Added because Google could not see everything: 自宅 and 職場 live in iCloud
 * and held an appointment the daily focus was talking over. Reading them here
 * means nothing has to move — the calendars stay where they are and the phone
 * keeps working the way it did.
 */
const icloudCalendar = new CaldavCalendarClient({
  appleId: process.env.ICLOUD_APPLE_ID?.trim() ?? '',
  appPassword: process.env.ICLOUD_APP_PASSWORD?.trim() ?? '',
  onEvent: ({ type, detail }) => activityLog.log({ level: 'info', event: type, detail }),
});

const calendar = new CalendarService(() => speech.resolveBinary(REPO_ROOT), [
  { name: 'google', source: googleCalendar },
  { name: 'icloud', source: icloudCalendar },
]);

/**
 * The next appointment, refreshed periodically into the situation.
 *
 * Calibrated, because a calendar entry is a stated fact rather than an
 * inference — but only observed at the moment the cache was written, so the
 * observation carries that time rather than now. A stale cache therefore ages
 * out of the snapshot on its own instead of being presented as current.
 */
/**
 * What the last real calendar read actually saw.
 *
 * Kept because absence is not an error and therefore leaves no trace. A source
 * that stops being configured simply stops appearing in `contributions`, and
 * the only way to notice is to have written down which sources were expected
 * and compare. Recorded from the periodic read rather than probed on demand,
 * so asking for health costs nothing and never touches the network.
 */
let lastCalendarRead: { at: string; contributed: string[] } | null = null;
/** So a retry cannot schedule another retry, and the cycle stays the cycle. */
let calendarRetryPending = false;
/**
 * Whether each live source is configured at all.
 *
 * Read through functions rather than captured once: configuration can change
 * while the process runs, and an unconfigured source is not a missing one.
 */
const contributedExpectations: Record<string, (() => boolean) | undefined> = {
  google: () => Boolean(process.env.GOOGLE_CLIENT_ID?.trim()),
  icloud: () => Boolean(process.env.ICLOUD_APPLE_ID?.trim() && process.env.ICLOUD_APP_PASSWORD?.trim()),
};

async function observeCalendar() {
  try {
    const reading = await calendar.readBest(14);
    const contributed = ((reading as any).contributions ?? []).map((c: any) => String(c.source));

    /**
     * A source coming back invalidates the answer built while it was gone.
     *
     * The exam countdown is cached for an hour, and it can be answered from
     * the published schedule when the calendar has nothing. So after the
     * Google token was renewed on 2026-08-27 the calendar was live again while
     * `/api/exam/next` went on serving the schedule's answer — with its own
     * 「講義日程表より」 label — until the hour ran out.
     *
     * The harm was small that time because both agreed on the date. It is the
     * shape that matters: a recovered source being ignored in favour of the
     * fallback that replaced it, which is the failure this whole day was spent
     * finding elsewhere.
     *
     * Compared as a set. Order varies with which source answered first, and a
     * reordering is not a change.
     */
    const before = new Set<string>(lastCalendarRead?.contributed ?? []);
    const now = new Set<string>(contributed as string[]);
    const changed =
      lastCalendarRead !== null &&
      (before.size !== now.size || [...now].some((s) => !before.has(s)));
    if (changed) {
      examCache = null;
      activityLog.info('calendar.sources_changed', {
        message: `寄与する源が変わりました（${[...before].join('・') || 'なし'} → ${[...now].join('・') || 'なし'}）。試験のキャッシュを捨てます。`,
      });
    }

    lastCalendarRead = { at: new Date().toISOString(), contributed };

    /**
     * Why a source did not answer, which was being computed and thrown away.
     *
     * `readBest` collects the reason each live source failed, and this dropped
     * it on the floor — so health could say "not contributing" and never say
     * anything else. On 2026-08-26 both calendars showed as failing all day
     * and there was nothing anywhere to explain it; the activity log's only
     * calendar entry was a token refresh.
     *
     * The same shape as the weather: a reason handed to the caller and written
     * nowhere is a reason nobody has.
     */
    for (const fallback of ((reading as any).fellBackFrom ?? []) as Array<any>) {
      activityLog.warn('calendar.source_failed', {
        message: String(fallback.message ?? fallback.code ?? '理由なし'),
        detail: { source: fallback.from, code: fallback.code, hint: fallback.hint ?? null },
      });
    }

    /**
     * Measured again shortly, when a configured source did not answer.
     *
     * The first observation runs at start-up — twenty-six seconds after the
     * process began, the day this was written — and that is the moment a
     * Google token refresh and a CalDAV round trip are least likely to have
     * finished. Only the cache contributed, and because the next observation
     * is half an hour away, that snapshot was what health reported for the
     * following thirty minutes. Restart a few times and it is what health
     * reports all day, which is what happened.
     *
     * Retrying on the absence rather than delaying the first read: a delay
     * only moves the window, and would still be wrong on a slow morning. This
     * is right whatever the cause, because not contributing is the thing worth
     * reacting to.
     *
     * Once. A source that is genuinely down would otherwise be retried every
     * two minutes forever, and the thirty-minute cycle is the right cadence
     * for that case.
     */
    const expected = ['google', 'icloud'].filter((name) => contributedExpectations[name]?.());
    const missing = expected.filter((name) => !contributed.includes(name));
    if (missing.length > 0 && !calendarRetryPending) {
      calendarRetryPending = true;
      activityLog.info('calendar.retry_scheduled', {
        message: `${missing.join('・')} が寄与しなかったため、2分後に測り直します。`,
      });
      setTimeout(() => {
        calendarRetryPending = false;
        void observeCalendar();
      }, 2 * 60_000).unref?.();
    }
    const upcoming = upcomingEvents(reading.events);
    if (upcoming.length === 0) return;

    const observedAt =
      'syncedAt' in reading && reading.syncedAt
        ? new Date(reading.syncedAt).toISOString()
        : new Date().toISOString();

    context.observe({
      source: 'calendar',
      kind: 'calendar.next_event',
      value: { title: upcoming[0].title, start: upcoming[0].start, calendar: upcoming[0].calendar },
      confidence: 1,
      evidence: `${reading.source} / ${upcoming.length}件中の先頭`,
      observedAt,
    });
  } catch (err: any) {
    activityLog.info('calendar.unavailable', { message: err?.message });
  }
}
void observeCalendar();
const calendarTimer = setInterval(() => void loopWatch.around('calendar.observe', async () => observeCalendar()), 30 * 60_000);

/**
 * Claude の割合を三十分ごとに取り直す。
 *
 * これは帯が三十秒ごとに送ってくる「覆っている高さ」の報告に相乗りしていた。
 * つまり **HUD がどの形で出ているかに、数字の鮮度が依存していた** — 2026-08-31、
 * 帯を畳んで縦レールにしたその瞬間に取り直しが止まり、二時間かけて 91% が
 * 94% になるあいだ、画面はずっと 91% を出していた。**古い数字が現在の数字の
 * 顔をしていた**わけで、この計画が名前で嫌っている形そのもの。
 *
 * 表示の都合と、値の鮮度は、別々に持たなければならない。三十分はもとの拍と
 * 同じで、掃除の仕組み（probe_cleanup）もその前提で作ってある。
 */
const allowanceTimer = setInterval(() => loopWatch.during('allowance.refresh', () => refreshAllowance(os.homedir(), 30)), 30 * 60_000);
allowanceTimer.unref?.();
calendarTimer.unref();

/**
 * 認可が生きているかを、誰かが困る前に確かめる。
 *
 * 2026-09-02 に測ったところ、Gmail の更新トークンは 8/26 ごろから失効していて、
 * その間 IRIS は一度もそう言っていなかった。壊れていたのは報告の仕方ではなく、
 * **誰も訊かなかった**こと。認可は必要になった瞬間にしか使われないので、使わない
 * 機能の認可は、使おうとした人の前で初めて失敗する。
 *
 * OAuth クライアントが External かつ「テスト中」のあいだ、更新トークンは7日で
 * 失効する。つまりここの認可は例外なく時限式で、放っておけば必ず切れる。
 *
 * 六時間おき。切れるまで七日あるので、これで十分間に合う。
 */
const grantHealth = new GrantHealthService({
  store: oauthStore,
  clientId: process.env.GOOGLE_CLIENT_ID ?? '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
});

/**
 * ブリーフィングは同期で組み立てるので、測った結果はここに置いて読む。
 *
 * 空配列は「まだ測っていない」であって「認可がない」ではない。ブリーフィング側は
 * その二つを区別して出す。
 */
let lastGrantHealth: GrantHealth[] = [];
let grantHealthCheckedAt: string | null = null;

async function refreshGrantHealth() {
  try {
    lastGrantHealth = await grantHealth.all();
    grantHealthCheckedAt = new Date().toISOString();
    const warning = grantWarning(lastGrantHealth);
    if (warning) activityLog.warn('grant.expired', { detail: { warning } });
  } catch (err: any) {
    // 測れなかっただけ。前の結果を消すと「切れた」に見える。
    activityLog.info('grant.check_failed', { detail: { error: err?.message ?? String(err) } });
  }
}

/**
 * 起動直後には測らない。
 *
 * 最初はモジュール読み込みと同時に走らせていて、両方 `unknown`（時間内に応答が
 * ありませんでした）になった。Google が遅いのではなく、**起動処理がイベントループを
 * 掴んでいるあいだ、こちらの 15 秒が先に尽きていた**。落ち着いてから訊けば同じ
 * 呼び出しが 1 秒で返る。
 *
 * 測れなかった時に六時間待つと、失敗が一日じゅう「まだ測っていない」の顔で居座る。
 * `unknown` のあいだだけ十分おきに訊き直し、答えが出たら通常の間隔に戻す。
 */
const GRANT_SETTLE_MS = 60_000;
const GRANT_RETRY_MS = 10 * 60_000;
const GRANT_INTERVAL_MS = 6 * 60 * 60_000;

function scheduleGrantHealth(delayMs: number) {
  const timer = setTimeout(async () => {
    await refreshGrantHealth();
    const unresolved = lastGrantHealth.length === 0 || lastGrantHealth.some((g) => g.liveness === 'unknown');
    scheduleGrantHealth(unresolved ? GRANT_RETRY_MS : GRANT_INTERVAL_MS);
  }, delayMs);
  timer.unref?.();
}

if (process.env.GOOGLE_CLIENT_ID) scheduleGrantHealth(GRANT_SETTLE_MS);

// Retention is only a promise until something enforces it. Hourly, and once
// at startup for a machine that was off when the window passed.
contextStore.prune();
const pruneTimer = setInterval(() => loopWatch.during('memory.prune', () => {
  const pruned = contextStore.prune();
  if (pruned.length > 0) activityLog.info('context.pruned', { detail: { pruned } });
}), 60 * 60_000);
pruneTimer.unref();

/**
 * Speaking first.
 *
 * Ships with no rules. Proactivity is something a person turns on, not a
 * default an assistant arrives with — and a rule added here can only ever
 * produce a proposal, because an inferred run is forbidden from reaching an
 * irreversible tool by the orchestrator rather than by this configuration.
 */
const proactive = new ProactiveService(context, {
  onEvent: ({ type, detail }) => {
    activityLog.log({ level: 'info', event: type, detail });
    if (type === 'proactive.suggested' && detail?.suggestionId) speakFirst(String(detail.suggestionId));
  },
});

/**
 * 提案が出たら、IRIS の一言で会話を一本開く。
 *
 * 「そもそも IRIS 側から俺に聞いて欲しい」「IRIS との会話みたいな形が理想」
 * （利用者、2026-09-30）。文面の組み方と「二度言わない」の鍵は
 * `server/core/opener.ts`。
 *
 * **返事を待っている同じ規則の話が 24 時間以内にあれば、重ねて開かない。**
 * 根拠が少し変わっただけで二本目を開くと、返事をしていないあいだに同じ話の
 * 会話が積もっていく。答えてもらえれば、次に規則が発火したときにまた話す。
 */
const proactiveOpeners = new ProactiveOpenerStore(db);
function speakFirst(suggestionId: string): void {
  try {
    const suggestion = proactive.listPending().find((s) => s.id === suggestionId);
    if (!suggestion) return;
    const now = new Date();
    const opener = openerFor(suggestion, now);
    if (proactiveOpeners.has(opener.key)) return;
    const waiting = proactiveOpeners
      .recent(50)
      .find((o) => o.ruleId === suggestion.ruleId && !o.replied && now.getTime() - Date.parse(o.createdAt) < 24 * 3_600_000);
    if (waiting) {
      activityLog.log({
        level: 'info', event: 'proactive.opener_held',
        detail: { ruleId: suggestion.ruleId, waitingOn: waiting.conversationId },
      });
      return;
    }
    const conversation = conversationStore.createConversation(opener.title);
    conversationStore.addMessage(conversation.id, 'assistant', opener.text);
    proactiveOpeners.record({
      key: opener.key,
      conversationId: conversation.id,
      ruleId: suggestion.ruleId,
      suggestionId: suggestion.id,
      createdAt: now.toISOString(),
    });
    activityLog.log({
      level: 'info', event: 'proactive.opened',
      detail: { ruleId: suggestion.ruleId, suggestionId: suggestion.id, conversationId: conversation.id },
    });
  } catch (err: any) {
    // 話しかけられなかったことは記録に残す。**黙って落とさない。**
    activityLog.log({
      level: 'warn', event: 'proactive.open_failed',
      detail: { suggestionId, message: err?.message ?? String(err) },
    });
  }
}

/**
 * 規則を残す口と、起動時に読み戻す。
 *
 * 足す口は前からあったが、**足したものは再起動で消えていた** —— 規則が
 * 配列の中にしか無かったので。提案が一件も出たことがない理由の半分がこれ。
 */
const proactiveRules = new ProactiveRuleStore(db);
for (const rule of proactiveRules.enabled()) {
  try {
    proactive.addRule(rule);
  } catch (err: any) {
    // 通らない規則で起動を止めない。**黙って落とさず、記録に残す。**
    activityLog.log({
      level: 'warn', event: 'proactive.rule_rejected_on_boot',
      detail: { id: rule.id, message: err?.message ?? String(err) },
    });
  }
}

/**
 * On-demand discovery of skills that are worth considering on this machine.
 * It is intentionally not a startup job: registry/GitHub access is slow and
 * a recommendation is not permission to install anything.
 */
const skillAdvisor = new SkillAdvisorService({
  cwd: process.cwd(),
  cachePath: path.join(process.cwd(), '.iris/skill-recommendations.json'),
});
defaultToolRegistry.registerAll(createSkillTools(skillAdvisor));

/**
 * The helper as its own launchd job, when there is an installed bundle to run.
 *
 * Measured 2026-08-19: spawned as a child of this service the helper reports
 * `notDetermined` for the microphone; started as its own LaunchAgent — same
 * binary, same bundle identifier, and a TCC grant whose recorded code hash
 * matches the current build exactly — it reports `authorized`. TCC attributes
 * the decision to whoever launched the process, and nothing inside the child
 * can change that.
 *
 * Off unless the installed bundle exists, because the child-process path is
 * the one that works while developing.
 */
const speechAgentBinary =
  process.env.IRIS_SPEECH_BINARY?.trim() ||
  path.join(os.homedir(), 'Library/Application Support/IRIS/IrisSpeech.app/Contents/MacOS/IrisSpeech');

const speechAgent =
  process.env.IRIS_SPEECH_AGENT === 'false' || !fsExistsSync(speechAgentBinary)
    ? undefined
    : new SpeechAgent({
        binaryPath: speechAgentBinary,
        locale: process.env.IRIS_SPEECH_LOCALE || 'ja-JP',
        onEvent: ({ type, detail }) => activityLog.log({ level: 'info', event: type, detail }),
      });

const speech = new SpeechBridge({
  locale: process.env.IRIS_SPEECH_LOCALE || 'ja-JP',
  agent: speechAgent,
  onEvent: ({ type, detail }) => {
    const level = type.includes('error') || type.includes('unavailable') || type.includes('gave_up')
      ? 'warn'
      : 'info';
    activityLog.log({ level, event: type, detail });
  },
});

/**
 * Stops talking when someone else starts.
 *
 * Deliberately driven by `partial` rather than `final`: waiting for a
 * finalised transcript means waiting for the user to stop speaking, and an
 * assistant that talks over someone until they finish has not been
 * interrupted, it has merely been shouted at.
 *
 * The whole difficulty is that the microphone hears the speaker. Wired
 * naively, IRIS begins a sentence, its own voice arrives as a partial a moment
 * later, and it interrupts itself on the first word — every time. `shouldBargeIn`
 * is where that is separated out; this is only the wiring.
 *
 * Interrupting is never an error. Nothing is retried, nothing is reported as a
 * failure, and the utterance is recorded as cut short rather than delivered.
 */
/**
 * The assistant's own voice, coming back.
 *
 * Kept rather than discarded. Barge-in already compares every incoming partial
 * with the utterance in progress, to tell the user's voice from the
 * assistant's; it uses the answer as one bit and throws away where the two
 * diverged. That difference is a measurement of how the reading actually came
 * out — and unlike human speech, the correct text is known exactly.
 *
 * The longest echo wins. Recognition grows a partial as it goes, so the last
 * one before the utterance ends covers the most of it.
 */
let echo: { forText: string; heard: string } | null = null;
let lastAudit: (PronunciationAudit & { at: string }) | null = null;

function finishAudit() {
  if (!echo || !echo.heard.trim()) { echo = null; return; }
  const audit = auditPronunciation(echo.forText, echo.heard);
  lastAudit = { ...audit, at: new Date().toISOString() };
  echo = null;

  if (audit.skipped || audit.divergences.length === 0) {
    activityLog.info('tts.audit_clean', {
      detail: { coverage: audit.coverage, skipped: audit.skipped ?? null },
    });
    return;
  }
  // Reported, never applied. A divergence is the voice mispronouncing, the
  // recogniser mishearing, or the room — indistinguishable from here, and only
  // a listener can separate them.
  activityLog.log({
    level: 'info',
    event: 'tts.audit_divergence',
    message: `読み上げと聞き取りが ${audit.divergences.length} 箇所で違いました。`,
    detail: { coverage: audit.coverage, divergences: audit.divergences },
  });
}

speech.on('partial', (text: string) => {
  const utterance = tts.currentUtterance();
  if (utterance) {
    // Accumulated whether or not it turns out to be echo: if it was the user
    // interrupting, the audit is abandoned rather than compared against a
    // sentence nobody read.
    // Audited against the original, not the spoken form. Recognition writes
    // standard orthography, so `30もん` comes back as `30問` — comparing with
    // the spoken string would report a correct reading as a divergence.
    if (!echo || echo.forText !== utterance.original) echo = { forText: utterance.original, heard: '' };
    if (text.length > echo.heard.length) echo.heard = text;
  }
  const decision = shouldBargeIn(
    text,
    {
      speakingText: utterance?.text ?? null,
      originalText: utterance?.original ?? null,
      startedAt: utterance?.startedAt ?? null,
    },
    Date.now()
  );
  if (!decision.interrupt) {
    // Only the interesting refusals. `not_speaking` is every partial when IRIS
    // is quiet, which is nearly all of them, and logging it would bury
    // everything else.
    if (decision.reason === 'self_echo' || decision.reason === 'within_grace') {
      activityLog.log({
        level: 'info',
        event: 'speech.barge_in_suppressed',
        detail: { reason: decision.reason, heard: text.slice(0, 40) },
      });
    }
    return;
  }
  if (tts.stop('barge_in')) {
    // The echo is discarded: what came back was a person talking over the
    // utterance, so comparing it with the script would report their words as
    // mispronunciations.
    echo = null;
    activityLog.log({
      level: 'info',
      event: 'speech.barge_in',
      message: `発話中に割り込みを検出したため読み上げを停止しました。`,
      detail: { heard: text.slice(0, 60) },
    });
  }
});

/**
 * Speech becomes context.
 *
 * Only finalized text: a volatile result is the transcriber still deciding,
 * and an inference built on a word it is about to retract is worse than no
 * inference. Failures here are logged and dropped — the context layer must
 * never be able to break the microphone.
 */
speech.on('final', (transcript: { text: string; at: string }) => {
  try {
    context.observe({
      source: 'speech',
      kind: 'speech.last_utterance',
      value: transcript.text,
      confidence: 0.9,
      observedAt: transcript.at,
    });
    context.observe({
      source: 'speech',
      kind: 'presence.occupied',
      value: true,
      confidence: 0.8,
      evidence: '確定した発話を検出',
      observedAt: transcript.at,
    });
  } catch (err: any) {
    activityLog.warn('context.observe_failed', { message: err?.message });
  }
});

speech.on('event', ({ type }: { type: string }) => {
  if (type !== 'speech.listening' && type !== 'speech.stopped' && type !== 'speech.unavailable') return;
  try {
    context.observe({
      source: 'iris',
      kind: 'input.speech_listening',
      value: type === 'speech.listening',
      confidence: 1,
      evidence: type,
    });
  } catch {
    /* the microphone must not fail because bookkeeping did */
  }
});

/**
 * The unattended coding agent.
 *
 * The register held this at EXPLICIT_DECISION_REQUIRED with a recorded
 * conclusion against building it; the user decided otherwise on 2026-08-20
 * after the trade was laid out, and asked specifically for the unattended
 * form. Their call. What is bounded here is everything that can be.
 *
 * The allowlist is read from the environment as exact paths. An empty list is
 * treated as "nothing authorised" rather than "no restriction" — the second
 * reading is how a missing setting becomes a permission nobody granted.
 */
const agentPolicy: AgentPolicy = {
  ...DEFAULT_POLICY,
  allowedRepos: (process.env.IRIS_AGENT_REPOS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
  maxUsdPerRun: Number(process.env.IRIS_AGENT_MAX_USD ?? 5) || 5,
  maxRunMs: (Number(process.env.IRIS_AGENT_MAX_MINUTES ?? 120) || 120) * 60_000,
  maxConcurrent: Number(process.env.IRIS_AGENT_MAX_CONCURRENT ?? 1) || 1,
};

/**
 * 委任した実行の台帳。**プロセスの外。**
 *
 * `AgentProcessService` の `Map` は再起動で消える。消えると、走っていた実行の
 * 監督が切れ、`/api/telemetry/models` が数えるものも無くなる。
 */
const delegatedRuns = new DelegatedRunStore(db);

const agents = new AgentProcessService({
  policy: agentPolicy,
  /*
   * 始まりと終わりを台帳へ。**書けなくても実行は続く**（`note` が握る）。
   */
  onRunChanged: (run) => {
    if (run.state === 'running') {
      delegatedRuns.start({
        id: run.id, agent: run.agent, model: run.model ?? null,
        repo: run.repo, branch: run.branch, handoffId: run.handoffId,
        startedAt: run.startedAt,
      });
    } else {
      delegatedRuns.finish(run.id, {
        stopReason: run.stopReason, exitCode: run.exitCode ?? null,
        usd: typeof run.usd === 'number' ? run.usd : null,
        endedAt: run.endedAt ?? new Date().toISOString(),
      });
    }
  },
  binary: process.env.IRIS_AGENT_BINARY?.trim() || `${os.homedir()}/.npm-global/bin/claude`,
  home: os.homedir(),
  // Outside every allowed repository, so an agent's directory is never
  // mistaken for one a person is editing — and so the person's checkout is
  // never the thing that moves.
  worktreeRoot: path.join(os.homedir(), 'Library/Application Support/IRIS/worktrees'),
  onEvent: ({ type, detail }) => {
    /**
     * A spent plan is a warning, not a note.
     *
     * It is also the only reading of the third agent's allowance that exists,
     * so it is written to memory as well as to the log — the log answers what
     * happened tonight, and the question this has to answer is how often it
     * happens at all.
     */
    const spent = type.includes('quota_exhausted');
    activityLog.log({
      level: spent || type.includes('refused') || type.includes('failed') ? 'warn' : 'info',
      event: type,
      detail,
    });
    if (spent) {
      try {
        memories.remember({
          kind: 'environment',
          content: `${(detail as any)?.agent ?? 'エージェント'} が契約の利用上限に達して終了しました。`,
          provenance: 'measured',
          source: `実行 ${(detail as any)?.run ?? '不明'} / ${new Date().toISOString()}`,
          confidence: 0.95,
        });
      } catch {
        /* the log entry stands; a memory that failed to write is not worth a thrown event */
      }
    }
  },
});

/**
 * One launcher, shared by the immediate route and the scheduler.
 *
 * Written once so the two entry points cannot drift into different rules. The
 * allowlist, the clean-tree check and the concurrency limit all live below
 * this line, and neither caller can reach the spawn without passing them.
 */
async function launchAgent(input: {
  taskId: string;
  repo: string;
  role?: RunRole;
  agent?: AgentKind;
  /** Asked for by a caller; granted only if somebody is watching. */
  network?: boolean;
  unattended?: boolean;
  /** Which model, where the agent offers a choice. Unset takes its default. */
  model?: string;
}) {
  // `implement` unless told otherwise. A scheduled run with no role stated is
  // work the user queued to be done, not reviewed.
  const role: RunRole = input.role ?? 'implement';
  const kind: AgentKind = asAgentKind(input.agent);
  const handoff = await development.buildHandoff(input.taskId, role, AGENTS[kind].label);
  const prompt = renderHandoffMarkdown(handoff);
  const network = attendedNetwork({ requested: input.network, unattended: input.unattended });
  if (input.network === true && !network) {
    activityLog.warn('agent.network_refused', {
      detail: { task: input.taskId, note: '無人実行にネットワークは渡しません。' },
    });
  }
  if (network) {
    /**
     * Recorded because it is the one capability a run can have that the
     * others cannot see. Everything else about a run is visible in its
     * transcript; an open socket is only visible here.
     */
    activityLog.info('agent.network_granted', {
      detail: { task: input.taskId, agent: kind, note: '監督下の実行のため、ソケットを開けます。' },
    });
  }
  return agents.start({
    handoffId: input.taskId,
    repo: input.repo,
    prompt,
    agent: kind,
    network,
    /**
     * Named by the caller, or chosen from the role. See `modelForRole`.
     */
    model: input.model ?? modelForRole(kind, role),
  });
}

/* ── Delegation: approval given once, instead of asked for every time ────── */

const delegation = new DelegationStore(db);
const locks = new LockStore(db);
const DISPATCH_TOOL = 'start_coding_agent';

/** The repository a dispatch means when it does not say. */
function defaultRepo(): string | null {
  return agentPolicy.allowedRepos[0] ?? null;
}

/**
 * What has been spent under a grant today, counting what could not be read.
 *
 * A run still in flight has no cost yet, and a run whose transcript was
 * unreadable never will. Both are charged at the per-run ceiling rather than
 * at zero: that is the most they can have cost, and treating an unknown as
 * free is how a daily cap stops existing at exactly the moment the accounting
 * breaks. The stored row keeps its null, so the record still says "unknown"
 * rather than asserting a figure nobody measured.
 */
function spentUnderGrant(grantId: string): number {
  const spent = delegation.spentToday(grantId);
  return spent.usd + spent.unmetered * agentPolicy.maxUsdPerRun;
}

/**
 * Creates the task and starts an agent on it, as one act.
 *
 * One call rather than two, because two calls means two approvals for one
 * decision — and the button pressed twice is the thing this was built to
 * remove.
 */
/**
 * Whether the third agent can run right now.
 *
 * It talks to a language server the Antigravity application starts, and starts
 * none of its own — measured 2026-08-23, the process count does not change
 * across a run. Without the application it fails immediately with
 * `ANTIGRAVITY_LS_ADDRESS is not set`, so routing work to it when the
 * application is closed would be dispatching a run that cannot begin.
 *
 * Cached for a minute. This is asked once per dispatch and the answer changes
 * only when somebody opens or closes an application.
 */
let antigravitySeenAt = 0;
let antigravitySeen = false;
function antigravityRunning(): boolean {
  const now = Date.now();
  if (now - antigravitySeenAt < 60_000) return antigravitySeen;
  antigravitySeenAt = now;
  try {
    execFileSync('pgrep', ['-f', 'Antigravity.app/Contents/MacOS/Antigravity'], { stdio: 'pipe' });
    antigravitySeen = true;
  } catch {
    // pgrep exits non-zero when nothing matches, which is the answer, not an error.
    antigravitySeen = false;
  }
  return antigravitySeen;
}

async function dispatchCodingAgent(input: {
  title: string;
  goal: string;
  successCriteria: string[];
  constraints: string[];
  relevantFiles: string[];
  repo: string | null;
  /** Omitted means "you decide" — see `chooseAgent`. */
  agent?: AgentKind;
  /** Whether the work needs to reach the network. Decides the one hard case. */
  needsNetwork?: boolean;
}) {
  const repo = input.repo ?? defaultRepo();
  if (!repo) {
    return { refused: true as const, code: 'no_repo', message: '対象リポジトリが設定されていません。' };
  }

  /**
   * Chosen by remaining allowance when the caller did not say.
   *
   * The two agents were benchmarked before this existed and no speciality
   * separated them, so the routing rule is the one thing that is measurable
   * and live: which subscription has more of its week left. The exception is
   * work that needs the network, which Codex cannot do as IRIS runs it.
   *
   * The reason travels with the choice. A dispatch that routed for a reason
   * nobody can see is a dispatch nobody can correct.
   */
  const usage = readClaudeUsage(os.homedir());
  const codexUsage = cliUsage.read()?.codex ?? null;
  const chosen = input.agent
    ? { agent: input.agent, because: '指定されたため。' }
    : chooseAgent({
        needsNetwork: input.needsNetwork === true,
        headroom: {
          claudeWeekPercent: usage.week?.usedPercent ?? null,
          codexWeekPercent: codexUsage?.usedPercent ?? null,
        },
        /**
         * A dispatch made through this tool is one the user asked for in
         * conversation, so somebody is watching it — which is what decides
         * whether Codex may open a socket. The scheduler does not come
         * through here.
         */
        attended: true,
        agyAvailable: antigravityRunning(),
      });

  const task = await development.createTask({
    title: input.title,
    goal: input.goal,
    successCriteria: input.successCriteria,
    scope: null,
    nonGoals: [],
    constraints: input.constraints,
    relevantFiles: input.relevantFiles,
  });

  const result = await launchAgent({ taskId: task.id, repo, agent: chosen.agent });
  if ('refusal' in result) {
    return { refused: true as const, code: result.refusal.code, message: result.refusal.message };
  }

  /**
   * Recorded against the grant only when there is one.
   */
  chargeToGrant(repo, AGENTS[chosen.agent].label, result.run.id);

  return {
    taskId: task.id,
    runId: result.run.id,
    branch: result.run.branch,
    agent: chosen.agent,
    routedBecause: chosen.because,
    repo,
  };
}

/**
 * Reads the allowance, refreshing it first if it has gone stale.
 *
 * The refresh is the reason this is worth a function: a gate that reads
 * whatever happens to be lying around will, on the night it matters, read a
 * figure from before the runaway started.
 */
async function gateOnAllowance() {
  // Only reached for unattended work. See the two call sites.
  let usage = readClaudeUsage(os.homedir());
  if (usage.ageMinutes === null || usage.ageMinutes > DEFAULT_BUDGET.freshMinutes) {
    refreshAllowance(os.homedir(), 0);
    // Long enough for a refresh, which is measured at about six seconds.
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    usage = readClaudeUsage(os.homedir());
  }

  const root = process.cwd();
  const { verdict, baseline } = decideAllowance(
    {
      weekPercent: usage.week?.usedPercent ?? null,
      sessionPercent: usage.session?.usedPercent ?? null,
      weekResetsAtMs: usage.week?.resetsAtMs ?? null,
      ageMinutes: usage.ageMinutes,
    },
    readBaseline(root),
    Date.now()
  );

  /**
   * Written only when the run is going ahead. Recording a stretch that was
   * then refused would spend the budget on work that never happened.
   */
  if (verdict.allowed && baseline) writeBaseline(root, baseline);
  return verdict;
}

/** Run id to delegation use, so a completion can settle the right row. */
const dispatchUses = new Map<string, string>();

/**
 * Every agent run signs the same register, whichever door it came in by.
 *
 * This lived inside the dispatch tool, with a note saying that a dispatch the
 * user approved in the moment is not spending a delegation and must not
 * consume its daily cap. The distinction was right about approval and wrong
 * about money: approving something in the moment replaces the *permission*
 * the grant would have given, not the *ceiling* it carries. There is one
 * ceiling on unattended agent spend per day, and an agent started through
 * `POST /api/agent/start` spends from the same wallet as one started by the
 * tool.
 *
 * It mattered immediately. The first delegated run ever made on this machine
 * went through that endpoint, cost $2.34, and the grant reported $0 spent
 * against a $5 cap — a ceiling that would have let the next three runs
 * through and the one after that. A limit that only some callers report to is
 * not a limit; it is a suggestion with an audit trail.
 */
function chargeToGrant(
  repo: string,
  agent: string,
  runId: string,
  purpose: 'implement' | 'audit' = 'implement'
) {
  const grant = delegation.liveGrant(DISPATCH_TOOL);
  if (!grant) return;
  const vendor = agent.startsWith('codex') ? 'codex' : 'claude';
  delegation.attachRun(
    delegation.recordUse({
      grantId: grant.id,
      repo,
      agent,
      vendor,
      purpose,
      weekBefore: weekPercentOf(vendor),
    }),
    runId
  );
  dispatchUses.set(runId, delegation.recentUses(grant.id, 1)[0]?.id as string);
}

/**
 * The vendor's weekly percentage right now, or nothing.
 *
 * Read at both ends of a run so the difference can be attributed to it.
 * Nothing is capped on that yet: allocating shares before there is a
 * measurement to allocate against would put a number in the code that nobody
 * could defend, which is the mistake the routing table avoided by declining
 * to name a speciality neither benchmark found.
 */
function weekPercentOf(vendor: 'claude' | 'codex'): number | null {
  try {
    if (vendor === 'codex') return cliUsage.read()?.codex?.usedPercent ?? null;
    return readClaudeUsage(os.homedir()).week?.usedPercent ?? null;
  } catch {
    return null;
  }
}

agents.onCompleted((runId, usd) => {
  const useId = dispatchUses.get(runId);
  if (!useId) return;
  dispatchUses.delete(runId);
  /**
   * Refreshed before reading, so the after-figure is actually after.
   *
   * The status line only updates when something asks it to, and a reading
   * taken from before the run would attribute nothing to it — which is the
   * shape of a measurement that always says zero.
   */
  const run = agents.list().find((r: any) => r.id === runId) as any;
  /**
   * Which week this run drew down, when it drew down one that is read here.
   *
   * The third agent runs on a subscription IRIS has no reading for, so its
   * runs settle with a null week rather than being attributed to Claude's.
   * Recording an unknown as somebody else's spend is worse than recording
   * nothing: it would move a number that is used to route later work.
   */
  const vendor = asAgentKind(run?.agent);
  if (vendor === 'claude') refreshAllowance(os.homedir(), 0);
  const week = vendor === 'agy' ? null : weekPercentOf(vendor);
  /**
   * Settled with what ran it, not only what it cost.
   *
   * The model is read at settle time rather than at dispatch because a
   * transcript can report a different one than was asked for. Tokens are the
   * unit that matters — the plans are subscriptions and the dollar figure is
   * indicative — and where the agent files none, nulls are recorded rather
   * than zeroes: 「読めなかった」 and 「使わなかった」 are not the same row.
   */
  setTimeout(
    () =>
      delegation.settleUse(useId, usd, week, {
        model: run?.model ?? null,
        outputTokens: run?.outputTokens ?? null,
        inputTokens: run?.inputTokens ?? null,
        cacheReadTokens: run?.cacheReadTokens ?? null,
      }),
    14_000
  );
  if (usd === null) {
    activityLog.warn('delegation.unmetered', {
      detail: { run: runId, note: '費用を読めなかったため、上限計算では1回あたりの上限額として扱います。' },
    });
  }
});

defaultToolRegistry.registerAll(
  createAgentDispatchTools({
    dispatch: dispatchCodingAgent,
    listRuns: () => agents.list() as unknown as Array<Record<string, unknown>>,
    allowedRepos: () => agentPolicy.allowedRepos,
  })
);

const agentSchedule = new AgentScheduleStore(db);

/**
 * Runs what the user queued, at the time they queued it for.
 *
 * This is what makes unattended operation possible without touching the
 * approval boundary. The alternative was letting IRIS start agents on its own
 * judgement, which collides with two rules the orchestrator holds — a guess
 * may not cause an irreversible act, and anything above READ waits for a
 * person. Rather than granting an exception to those, the origin stays the
 * user: they decided while awake, and this reads the decision back later.
 *
 * Nothing here consults the boundary, because nothing is asking it for
 * anything. There is no tool call and no inferred origin.
 *
 * There *is* now a standing approval, added on 2026-08-21 for the dispatch
 * tool — this comment used to say there was none, and it would have gone on
 * saying so. It is deliberately not the same shape as the exception rejected
 * above. A guess still cannot use it (`decideDelegation` refuses an inferred
 * origin outright), it names one tool and specific repositories rather than a
 * risk level, it expires on its own, and every use is announced. The thing
 * that was refused was a permanent hole with nobody's name on it; what exists
 * is a grant with an end date.
 */
async function drainAgentSchedule() {
  for (const item of agentSchedule.due()) {
    // Claimed before launching, so two ticks cannot start the same row twice.
    if (!agentSchedule.claim(item.id)) continue;
    try {
      /**
       * The one place the ceiling belongs.
       *
       * A scheduled run fires at an hour nobody chose to be awake for, which
       * is exactly the case the cap was asked for. Refusing here costs a run
       * that can be started again in the morning; not refusing costs a week
       * of assistant by four.
       */
      const gate = await gateOnAllowance();
      if (!gate.allowed) {
        activityLog.warn('agent.schedule_refused', {
          detail: { scheduled: item.id, code: gate.code, message: gate.message },
        });
        // Left on the schedule rather than consumed: the allowance recovers,
        // and a run refused for want of it should fire when there is some.
        continue;
      }
      const result = await launchAgent({ taskId: item.taskId, repo: item.repo });
      if ('refusal' in result) {
        // A refusal is written down. A morning with no branch and no reason is
        // the same as never having queued anything.
        agentSchedule.recordFailed(item.id, result.refusal.message);
        activityLog.warn('agent.schedule_refused', {
          detail: { scheduled: item.id, repo: item.repo, reason: result.refusal.message },
        });
        continue;
      }
      agentSchedule.recordStarted(item.id, result.run.id);
      activityLog.info('agent.schedule_started', {
        detail: { scheduled: item.id, run: result.run.id, branch: result.run.branch },
      });
    } catch (err: any) {
      agentSchedule.recordFailed(item.id, err?.message ?? String(err));
      activityLog.warn('agent.schedule_failed', { detail: { scheduled: item.id, message: err?.message } });
    }
  }
}

// Once a minute, and once at startup so a machine that was asleep at the due
// time still runs what was waiting rather than skipping it silently.
/**
 * The per-run ceiling, finally attached to something that can stop a run.
 *
 * `perRunUsd` was printed at startup and enforced nowhere: the pre-call check
 * existed and had no caller, and the after-call check reads a `run.usage`
 * event emitted once the run is already over. This asks the budget between
 * steps, which is the only place a runaway loop can still be interrupted.
 */
orchestrator?.setSpendCeiling((usdSoFar) => {
  const limitUsd = budget.getLimits().perRunUsd;
  if (!(limitUsd > 0)) return null;
  return { stop: usdSoFar >= limitUsd, limitUsd };
});

/**
 * Approval the user granted in advance, consulted where one would be asked for.
 *
 * Returns null for every tool but the dispatch, and null for that one too
 * until something has actually been granted — so with nothing granted, the
 * approval boundary behaves exactly as it did before this existed.
 *
 * The repository is resolved the same way the dispatch itself resolves it. If
 * these two disagreed, a grant scoped to one repository could authorise a run
 * in another, which is the one mistake this check exists to prevent.
 */
orchestrator?.setDelegationCheck(({ tool, args, origin }) => {
  if (tool !== DISPATCH_TOOL) return null;

  const grant = delegation.liveGrant(DISPATCH_TOOL);
  if (!grant) return null;

  const asked = typeof args?.repo === 'string' && args.repo.trim() ? args.repo.trim() : null;
  const repo = asked ?? defaultRepo() ?? '';

  const verdict = decideDelegation({
    grant,
    tool,
    repo,
    origin,
    spentTodayUsd: spentUnderGrant(grant.id),
    running: agents.list().filter((run) => run.state === 'running').length,
    now: new Date(),
  });

  if (!verdict.satisfied) {
    // Written down, so "why did it ask me this time" has an answer.
    activityLog.info('delegation.not_satisfied', {
      detail: { tool, repo, code: verdict.code, message: verdict.message },
    });
    return { satisfied: false };
  }
  return verdict;
});

void drainAgentSchedule();
const agentScheduleTimer = setInterval(() => void loopWatch.around('agents.schedule', () => drainAgentSchedule()), 60_000);
agentScheduleTimer.unref();

/** Queue a run for later. The moment of queueing is the authorization. */
app.post('/api/agent/schedule', (req, res) => {
  const { queued, reason } = agentSchedule.queue({
    taskId: String(req.body?.taskId ?? ''),
    repo: String(req.body?.repo ?? ''),
    dueAt: String(req.body?.dueAt ?? ''),
  });
  if (!queued) {
    res.status(400).json({ queued: null, reason });
    return;
  }
  activityLog.warn('agent.scheduled', {
    detail: { scheduled: queued.id, task: queued.taskId, repo: queued.repo, dueAt: queued.dueAt },
  });
  res.status(201).json({ queued, reason, policy: agentPolicy });
});

app.get('/api/agent/schedule', (_req, res) => {
  res.json({
    scheduled: agentSchedule.list(),
    note:
      '予約した時点が承認です。実行は IRIS の推定ではなく利用者の指示を後から読み出しているだけなので、' +
      '承認境界には触れていません。実行されなかった予約は state=failed と note に理由が残ります。',
  });
});

app.delete('/api/agent/schedule/:id', (req, res) => {
  const cancelled = agentSchedule.cancel(req.params.id);
  res.json({ cancelled });
});

/**
 * Starts a run from a development task's handoff.
 *
 * The caller names a task, never a command and never a path: the handoff is
 * rendered here and becomes the prompt. A parameter that could carry a command
 * would make this arbitrary command execution under a narrower name.
 */
app.post('/api/agent/start', async (req, res) => {
  const taskId = String(req.body?.taskId ?? '');
  const repo = String(req.body?.repo ?? '');
  /**
   * Which agent, since `launchAgent` has always been able to take one and
   * this endpoint never passed it — so every run started here went to Claude
   * regardless of what the caller wanted, silently. Found while writing a
   * benchmark that compares the two: it would have compared Claude with
   * Claude and reported the difference as noise.
   */
  const agent: AgentKind = asAgentKind(req.body?.agent);
  if (!taskId || !repo) {
    res.status(400).json({ error: 'taskId と repo は必須です。' });
    return;
  }

  try {
    /**
     * No ceiling here, on purpose.
     *
     * The cap exists for work that runs while nobody is watching — that was
     * the reason it was asked for, and it is the only situation it protects.
     * A person starting a run and watching it does not need a governor
     * between them and their own tools; the allowance is right there on the
     * band while they decide.
     *
     * `unattended: true` opts a caller in, and the scheduler passes it. See
     * `gateOnAllowance`.
     */
    if (req.body?.unattended === true) {
      const gate = await gateOnAllowance();
      if (!gate.allowed) {
        res.status(409).json({ refused: true, code: `allowance_${gate.code}`, message: gate.message });
        return;
      }
    }

    /**
     * A dev server, when someone is watching.
     *
     * Asked for by the caller and granted only outside unattended runs. The
     * sandbox does not separate listening from reaching out, so this is the
     * same switch as outbound network — see the argv in `agent_runner`.
     */
    /**
     * The role, which this endpoint also never passed.
     *
     * The same shape as the `agent` bug found on 2026-08-22: `launchAgent` has
     * always taken one and the HTTP route never sent it, so every run started
     * here was an `implement` whatever the caller asked for. It surfaced when
     * the model began to depend on the role — a review dispatched here ran on
     * the implementation model and said nothing about it.
     */
    const role: RunRole =
      req.body?.role === 'review' || req.body?.role === 'verify' || req.body?.role === 'research'
        ? req.body.role
        : 'implement';

    const result = await launchAgent({
      taskId,
      repo,
      agent,
      role,
      network: req.body?.network === true,
      unattended: req.body?.unattended === true,
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
    });
    if ('refusal' in result) {
      res.status(409).json({ refused: true, ...result.refusal });
      return;
    }
    chargeToGrant(repo, result.run.agent ?? 'claude', result.run.id);
    res.status(201).json({ run: result.run, policy: agentPolicy });
  } catch (err) {
    handleError(res, err, 'agent.start_error', { taskId, repo });
  }
});

/**
 * The standing approval: what is granted, what it has spent, what it has done.
 *
 * A grant that cannot be inspected is the failure mode of granting one at all,
 * so this reports the terms, the day's spend against them, and the dispatches
 * actually made — not merely that something is switched on.
 */
/**
 * What each purpose has drawn from each week, measured rather than budgeted.
 *
 * No share is enforced. The figures have to exist before an allocation can be
 * defended, and today the only thing known is that two Codex runs costing
 * four cents between them moved that week's meter ten points — which says the
 * dollar figure was the wrong unit, and says nothing yet about what a fair
 * split would be.
 */
app.get('/api/allowance/breakdown', async (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '7'), 10) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const cache = sessionUsage(days);
  const sessions = await cache.get();
  const claudeWeek = weekPercentOf('claude');

  /**
   * The week's percentage, split across projects by their weighted share.
   *
   * Marked as an estimate everywhere it appears, because it is one twice
   * over: the relation between tokens and a percentage of the allowance is
   * not published, and the weighting that makes an Opus token comparable to a
   * Haiku one uses list prices as a stand-in for it. The split is defensible
   * and it is not a measurement, and those two things have to stay
   * distinguishable on the screen that shows them.
   */
  const estimated = claudeWeek === null
    ? null
    : sessions.projects.map((p) => ({
        project: p.project,
        estimatedWeekPoints: Math.round(claudeWeek * (p.sharePercent / 100) * 10) / 10,
      }));

  res.json({
    since,
    days,
    /** Measured: both ends of each delegated run's weekly figure. */
    byPurpose: delegation.allowanceSince(since),
    /** Measured: token counts from every session's own transcript. */
    byProject: sessions.projects,
    /** Estimated: the week's percentage split by weighted share. */
    estimatedWeekPoints: estimated,
    unreadableTranscripts: sessions.unreadable,
    /** How much history there is to argue from yet. */
    history: history.counts(),
    pricingLastVerified: sessions.pricingLastVerified,
    now: {
      claudeWeekPercent: claudeWeek,
      codexWeekPercent: weekPercentOf('codex'),
    },
    note:
      '上限は設けていません。byPurpose と byProject は実測、estimatedWeekPoints は推定です' +
      '（トークンと週次%の関係は非公開のため、定価を重みに使った按分）。',
  });
});

app.get('/api/delegation', (_req, res) => {
  const grant = delegation.liveGrant(DISPATCH_TOOL);
  if (!grant) {
    res.json({ granted: false, tool: DISPATCH_TOOL, allowedRepos: agentPolicy.allowedRepos });
    return;
  }
  const spent = delegation.spentToday(grant.id);
  res.json({
    granted: true,
    grant,
    today: {
      ...spent,
      /* What the cap is actually measured against: unreadable and in-flight
         runs are charged at the per-run ceiling, not at zero. */
      chargedUsd: spentUnderGrant(grant.id),
      /**
       * Not reported from the process list.
       *
       * A figure was added here for "what agents cost today regardless of the
       * grant", read from `agents.list()` — which is in memory and empty after
       * a restart. It showed $0 for a run that had cost $2.34 an hour earlier,
       * which is the failure this project is named after, introduced while
       * fixing an instance of it.
       *
       * `delegation_uses` is on disk and survives restarts, and now that both
       * doors record there, the charged figure below *is* the day's agent
       * spend. One number, from the durable place.
       */
      capUsd: grant.dailyUsdCap,
      perRunCeilingUsd: agentPolicy.maxUsdPerRun,
    },
    recent: delegation.recentUses(grant.id),
  });
});

/**
 * Grants it. Every field is a bound, and every bound has a default that errs
 * small — the point is to make asking unnecessary, not to make the limits
 * disappear.
 */
app.post('/api/delegation', (req, res) => {
  const now = new Date();
  const base = defaultGrant(DISPATCH_TOOL, agentPolicy.allowedRepos, now);

  const repos = Array.isArray(req.body?.repos)
    ? req.body.repos.filter((r: unknown) => typeof r === 'string')
    : base.repos;

  // Outside the agent policy's allowlist is outside the grant, whatever was
  // asked for. A grant cannot widen what a run was already forbidden.
  const scoped = repos.filter((r: string) => agentPolicy.allowedRepos.includes(r));
  if (scoped.length === 0) {
    res.status(400).json({
      error: '委任できるリポジトリがありません。',
      allowedRepos: agentPolicy.allowedRepos,
    });
    return;
  }

  const days = Number(req.body?.days);
  const expires = new Date(now.getTime());
  expires.setDate(expires.getDate() + (Number.isFinite(days) && days > 0 && days <= 90 ? days : 30));

  const cap = Number(req.body?.dailyUsdCap);
  const concurrent = Number(req.body?.maxConcurrent);

  const grant = delegation.grant({
    tool: DISPATCH_TOOL,
    repos: scoped,
    dailyUsdCap: Number.isFinite(cap) && cap > 0 && cap <= 100 ? cap : base.dailyUsdCap,
    maxConcurrent:
      Number.isInteger(concurrent) && concurrent > 0 && concurrent <= agentPolicy.maxConcurrent
        ? concurrent
        : base.maxConcurrent,
    expiresAt: expires.toISOString(),
    grantedAt: now.toISOString(),
    note: typeof req.body?.note === 'string' ? req.body.note : null,
  });

  activityLog.warn('delegation.granted', {
    detail: {
      tool: DISPATCH_TOOL,
      repos: scoped,
      dailyUsdCap: grant.dailyUsdCap,
      maxConcurrent: grant.maxConcurrent,
      expiresAt: grant.expiresAt,
    },
  });

  res.status(201).json({ granted: true, grant });
});

/** Revokes it. Timestamped, never deleted — the record of having agreed stays. */
app.delete('/api/delegation', (_req, res) => {
  const revoked = delegation.revoke(DISPATCH_TOOL);
  if (revoked > 0) activityLog.warn('delegation.revoked', { detail: { tool: DISPATCH_TOOL } });
  res.json({ granted: false, revoked });
});

/**
 * The portfolio, as the ledger currently states it.
 *
 * `ok: false` when it could not be read, never an empty project list. The two
 * are indistinguishable on screen otherwise, and one of them means a person's
 * work has quietly stopped being visible.
 */
app.get('/api/portfolio', (_req, res) => {
  res.json(portfolio.read());
});

/** What has run, what it cost, and why it stopped. */
app.get('/api/agent/runs', (_req, res) => {
  res.json({
    runs: agents.list(),
    policy: agentPolicy,
    note:
      '費用は起動された側の転記から実測しています。IRIS 自身の支出上限（/api/budget）はこれには効きません。' +
      '転記が読めなくなった実行は、上限が効かない状態で走り続けるより停止させます。',
  });
});

app.post('/api/agent/stop', (req, res) => {
  const id = String(req.body?.run ?? '');
  if (!id) {
    // Stopping everything is the thing someone wants at 3am, so it is not
    // hidden behind knowing an id.
    const stopped = agents.list().filter((r) => r.state === 'running').map((r) => agents.stop(r.id));
    res.json({ stopped: stopped.length, runs: stopped });
    return;
  }
  const run = agents.stop(id);
  if (!run) {
    res.status(404).json({ error: `そのような実行はありません: ${id}` });
    return;
  }
  res.json({ run });
});

/**
 * Money, read from files the rest of IRIS cannot reach.
 *
 * The directory is outside the workspace on purpose. `read_file` is READ and
 * therefore auto-executes, so a statement inside the workspace could reach a
 * cloud model in a single turn without anyone approving it. Only this endpoint
 * opens these files, and only from this one directory.
 *
 * The two halves are returned by different endpoints because they have
 * different rules — monthly totals may go into a prompt, individual
 * transactions may not. Decided by the user on 2026-08-20.
 */
const FINANCE_DIR = path.join(os.homedir(), 'Library/Application Support/IRIS/finance');
const finance = new FinanceStore(db);
/*
 * 会話から家計を聞けるようにする。**集計だけ。**
 *
 * 共有してよい側とローカル限定側を分けて作ってあったのに、渡してよい方を
 * 渡す口が無かった。分けた意味は、渡せる側を実際に渡せることにある。
 */
defaultToolRegistry.registerAll(createFinanceTools(finance));

/*
 * 分類の規則は起動のたびに掛け直す。
 *
 * 箱は行の中に書いてあるが、**判断は規則の側にある。**規則を足したときに
 * 取り込み済みの行だけ古い答えのまま残ると、同じ店が月によって別の箱に
 * 入り、その食い違いは画面からは分類の失敗に見えない — ただ数字が合わない。
 */
{
  const recat = finance.recategorise((description) => categoriseSpending(description));
  if (recat.changed > 0) {
    activityLog.info('finance.recategorised', {
      message: `${recat.changed}件を分け直した`,
      detail: { changed: recat.changed, months: recat.months },
    });
  }
}

// Line items expire on their own schedule, and the sweep runs hourly rather
// than at import: a promise kept only when something is imported is not kept
// on the months when nothing is.
finance.prune();
const financePruneTimer = setInterval(() => loopWatch.during('finance.prune', () => {
  const { deleted } = finance.prune();
  if (deleted > 0) activityLog.info('finance.pruned', { detail: { deleted } });
}), 60 * 60_000);
financePruneTimer.unref();

/** What is sitting in the folder waiting to be read. */
app.get('/api/finance/files', (_req, res) => {
  try {
    const names = fsExistsSync(FINANCE_DIR)
      ? fsReaddirSync(FINANCE_DIR).filter((n) => n.toLowerCase().endsWith('.csv'))
      : [];
    res.json({
      directory: FINANCE_DIR,
      files: names,
      formats: FORMATS.map((f) => ({ id: f.id, label: f.label, headers: f.requiredHeaders })),
      note:
        'ここに置いた CSV だけを読みます。ワークスペース外なので read_file からは届きません。' +
        '対応していない見出しのファイルは推測で読まず、見出しを返して拒否します。',
    });
  } catch (err) {
    handleError(res, err, 'finance.files_error');
  }
});

/** Reads one file. The file is not moved or deleted — that stays the user's call. */
app.post('/api/finance/import', (req, res) => {
  const fileName = String(req.body?.file ?? '');
  const account = String(req.body?.account ?? 'default');
  // Rejected rather than resolved: a name that can traverse is a name that can
  // read the rest of the disk through an endpoint built to read one folder.
  if (!fileName || fileName.includes('/') || fileName.includes('..')) {
    res.status(400).json({ error: 'ファイル名のみを指定してください（パスは不可）。' });
    return;
  }

  const full = path.join(FINANCE_DIR, fileName);
  if (!fsExistsSync(full)) {
    res.status(404).json({ error: `${FINANCE_DIR} にありません: ${fileName}` });
    return;
  }

  try {
    const bytes = fsReadFileSync(full);
    // The encoding belongs to the format, so the header has to be read first —
    // and a header misread as UTF-8 would simply not match, which is the
    // correct outcome rather than a silent mojibake import.
    let parsed = parseCsv(decode(bytes, 'utf-8'));
    if (!parsed.ok) {
      for (const encoding of ['shift_jis', 'euc-jp'] as const) {
        const retry = parseCsv(decode(bytes, encoding));
        if (retry.ok) { parsed = retry; break; }
      }
    }
    if (!parsed.ok) {
      res.status(422).json({ imported: false, reason: parsed.reason });
      return;
    }

    const result = finance.import({
      fileName,
      format: parsed.format!.id,
      account,
      transactions: parsed.transactions,
      skipped: parsed.skipped.length,
      categorize: (t) => categoriseSpending(t.description),
    });
    activityLog.warn('finance.imported', {
      detail: { file: fileName, format: parsed.format!.id, inserted: result.inserted, skipped: parsed.skipped.length },
    });
    res.status(201).json({
      imported: true,
      format: parsed.format!.label,
      ...result,
      skippedRows: parsed.skipped,
      note: '元のファイルは削除していません。取り込み結果を確認してから消してください。',
    });
  } catch (err) {
    handleError(res, err, 'finance.import_error', { file: fileName });
  }
});

/** Monthly totals. This is the half that may reach a model. */
app.get('/api/finance/summary', (req, res) => {
  const months = finance.aggregates({ from: req.query.from as string, to: req.query.to as string });
  // Spending is stated separately rather than left to the reader to sum,
  // because summing every row is exactly the mistake that double-counts a
  // card bill.
  // `superseded` rows never reach the aggregate table, so summing what is
  // here does not double a purchase that arrived twice.
  const spending = months.filter((m) => m.kind === 'spending');
  res.json({
    months,
    spendingByMonth: [...new Set(spending.map((m) => m.month))].sort().reverse().map((month) => ({
      month,
      total: spending.filter((m) => m.month === month).reduce((sum, m) => sum + m.total, 0),
    })),
    imports: finance.imports(),
    transferRules: finance.transferRules().length,
    note:
      '集計のみです。個別の取引は含みません。支出合計は kind=spending だけを足しています — ' +
      '口座間の移動(transfer)を含めると、カードの引き落としが購入と二重に数えられます。',
  });
});

/**
 * Individual transactions.
 *
 * Local only, by the user's decision. Served so a person can look, and never
 * assembled into a prompt — the endpoint says so in its own response, because
 * a rule that lives only in a design document is one a future call site will
 * not see.
 */
app.get('/api/finance/transactions', (req, res) => {
  res.json({
    transactions: finance.transactionsLocalOnly({
      month: req.query.month as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }),
    privacy: 'local_only',
    note:
      '個別の取引は端末外に出しません（2026-08-20 の利用者の判断）。プロンプトに含めないでください。' +
      'モデルに渡してよいのは /api/finance/summary の集計だけです。',
  });
});

/**
 * Gmail, for the card notifications that arrive within minutes of a purchase.
 *
 * A separate OAuth path from the MCP one, because Gmail has no MCP server
 * here and inventing a URL to satisfy that code path would be a guess in the
 * one place a guess costs a credential. Read-only scope, and nothing else.
 */
const googleOAuth = new GoogleOAuth({
  store: oauthStore,
  clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim(),
  /**
   * The MCP callback path, deliberately.
   *
   * A separate `/api/google/oauth/callback` was the obvious shape and Google
   * refused it with redirect_uri_mismatch — only the MCP one is registered on
   * the OAuth client. Reusing the registered path means no console work, and
   * the callback tells the two flows apart by the service recorded with the
   * state rather than by the URL.
   */
  redirectUri: OAUTH_REDIRECT,
  onEvent: ({ type, detail }) => activityLog.warn(type, { detail }),
});

const gmail = new GmailClient({
  store: oauthStore,
  clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim(),
  onEvent: ({ type, detail }) =>
    activityLog.log({ level: type.includes('failed') ? 'warn' : 'info', event: type, detail }),
});

/**
 * 認可が生きているか、いま測る。
 *
 * `?fresh=1` で保持を捨てて測り直す。既定は保持したものを返す — 生死を訊くたびに
 * Google を叩く必要はないが、再認可した直後に古い答えを返されると何が起きたか
 * 分からなくなる。
 */
app.get('/api/credentials', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    res.json({ google: [], note: 'GOOGLE_CLIENT_ID が設定されていないため、測れません。' });
    return;
  }
  if (req.query.fresh === '1') grantHealth.invalidate();
  const google = await grantHealth.all();
  /*
   * 測ったのだから、控えも新しくする。
   *
   * ここを書かずに出したせいで、再認可の直後にブリーフィングが「切れています」と
   * 言い続けた。次の定期チェックまで六時間あるので、**直った後の半日、古い読み取りが
   * 現在の顔をしていた** — この仕組みが防ぐために作られた形そのもの。
   */
  lastGrantHealth = google;
  grantHealthCheckedAt = new Date().toISOString();
  res.json({
    google,
    warning: grantWarning(google),
    note: 'liveness は alive / dead / unknown の三値です。unknown は「測れなかった」で、dead ではありません。',
  });
});

app.post('/api/google/oauth/start', (req, res) => {
  const service = String(req.body?.service ?? '');
  if (!GOOGLE_SERVICE_SCOPES[service]) {
    res.status(400).json({
      error: `対応していないサービスです: ${service}`,
      available: Object.keys(GOOGLE_SERVICE_SCOPES),
    });
    return;
  }
  try {
    const { authorizationUrl } = googleOAuth.start(service);
    res.json({
      authorizationUrl,
      scopes: GOOGLE_SERVICE_SCOPES[service],
      note: 'このURLをブラウザで開いて許可してください。要求するのは読み取り専用スコープのみです。',
    });
  } catch (err) {
    handleError(res, err, 'google_oauth.start_error', { service });
  }
});

/**
 * Kept as a clear error rather than removed.
 *
 * This was the original callback path and Google refuses it — the OAuth
 * client only has the MCP one registered. Anyone who finds this URL in an old
 * note gets told where it went instead of a 404.
 */
app.get('/api/google/oauth/callback', (_req, res) => {
  res.status(410).send(
    'この経路は使用していません。認可は /api/mcp/oauth/callback に戻ります' +
      '（OAuth クライアントに登録されているのがそちらのみのため）。'
  );
});

/** The senders IRIS has templates for. Nothing else is fetched. */
function notificationQuery(days: number): string {
  const senders = [...new Set(EMAIL_TEMPLATES.map((t) => t.sender))];
  return `${senders.map((s) => `from:${s}`).join(' OR ')} newer_than:${days}d`;
}

/**
 * Reads card notifications and records them as pending.
 *
 * Fetching is scoped to the senders there are templates for, so mail IRIS has
 * no business reading never enters this process. Anything that arrives and
 * does not match is reported by sender and subject rather than parsed
 * approximately — the register's rule for this feature.
 */
/**
 * 通知メールから家計を取り込む中身。**HTTP と時計の両方から呼べるように
 * 切り出してある。**
 *
 * これまでは HTTP の中にだけあったので、**誰かが押さないと台帳が増えなかった。**
 * 実際 16 日ぶん止まっていて、その間の買い物はどこにも無かった。集計を出す
 * 画面と道具を作った以上、中身が古いまま静かに正しい顔をしているのが一番まずい。
 */
async function importFinanceFromGmail(days: number, account: string, limit: number) {
  const { messages, truncated } = await gmail.search(notificationQuery(days), limit);
  const unrecognised: string[] = [];
  const skipped: string[] = [];
  const transactions: Array<{ occurredOn: string; amount: number; description: string }> = [];

  for (const message of messages) {
    const parsed = parseEmail(message);
    if (!parsed.ok) {
      unrecognised.push(parsed.reason ?? message.subject);
      continue;
    }
    for (const s of parsed.skipped) skipped.push(`${message.subject}: ${s.reason}`);
    transactions.push(...parsed.purchases.map((p) => ({
      occurredOn: p.occurredOn,
      amount: p.amount,
      description: p.description,
    })));
  }

  const result = finance.import({
    fileName: `gmail:${days}d`,
    format: 'gmail',
    account,
    transactions,
    skipped: skipped.length,
    // A notification is the first word on a purchase, not the last.
    status: 'pending',
    source: 'gmail',
    categorize: (t) => categoriseSpending(t.description),
  });

  return { messages: messages.length, truncated, result, unrecognised, skipped };
}

app.post('/api/finance/gmail/import', async (req, res) => {
  const days = Math.min(Math.max(Number(req.body?.days ?? 30), 1), 365);
  const account = String(req.body?.account ?? 'card');

  try {
    const { messages: seen, truncated, result, unrecognised, skipped } =
      await importFinanceFromGmail(days, account, Number(req.body?.limit ?? 500));
    const messages = { length: seen } as { length: number };
    activityLog.warn('finance.gmail_imported', {
      detail: { messages: messages.length, inserted: result.inserted, unrecognised: unrecognised.length },
    });
    res.status(201).json({
      messages: messages.length,
      // Named, because a truncated fetch produces a partial month that reads
      // as a cheap one.
      truncated,
      ...result,
      unrecognised,
      skipped,
      ...(truncated
        ? {
            warning:
              '取得件数の上限に達しました。期間内にまだメールがあります — この結果は不完全で、' +
              '古い月ほど少なく見えます。limit を上げるか days を短くして再実行してください。',
          }
        : {}),
      note:
        'pending として記録しました。月次の CSV を取り込んだあと POST /api/finance/reconcile で突合すると、' +
        '同じ購入が二重に数えられません。対応テンプレートが無いメールは金額を推測せず、差出人と件名だけ返しています。',
    });
  } catch (err: any) {
    if (err instanceof GmailUnavailableError) {
      res.status(409).json({ error: err.message, code: err.code, hint: err.hint });
      return;
    }
    handleError(res, err, 'finance.gmail_error');
  }
});

/**
 * 家計を自分で取り込む。
 *
 * 押されたときだけ走っていたので、**16 日ぶん止まっていた。**その間の買い物は
 * どこにも無く、集計は静かに正しい顔をしていた。画面と道具から読めるように
 * した以上、中身が古いまま黙っているのが一番まずい形になる。
 *
 * 認可が生きているときだけ走らせる。切れているのに叩き続けても増えないし、
 * **切れていることは別の仕組み（`grantHealth`）が既に見張っている** — 二か所で
 * 別々に判断すると、片方だけが正しいときに気づけない。
 *
 * 窓は 14 日。重なりは `(口座, 日付, 金額, 摘要, 出現順)` の同一性で落ちるので、
 * 毎回同じメールを読み直しても行は増えない。短すぎる窓は、数日 Mac を閉じて
 * いただけで穴が空く。
 */
const FINANCE_PULL_MS = 6 * 60 * 60_000;

async function pullFinance() {
  try {
    if (!gmail.configured()) return;
    const health = lastGrantHealth.find((g) => g.service === 'gmail');
    if (health && health.liveness === 'dead') {
      activityLog.info('finance.gmail_skipped', { message: '認可が切れているので取り込みません。' });
      return;
    }
    const { messages, truncated, result, unrecognised } = await importFinanceFromGmail(14, 'card', 500);
    activityLog.warn('finance.gmail_auto', {
      detail: {
        messages,
        inserted: result.inserted,
        duplicates: result.duplicates,
        unrecognised: unrecognised.length,
        truncated,
      },
    });
  } catch (err: any) {
    // 取り込めなかっただけ。**古いことは画面が「最後の取り込みから N 日」で
    // 言うので、ここで黙っても嘘にはならない。**
    activityLog.info('finance.gmail_auto_failed', { detail: { error: err?.message ?? String(err) } });
  }
}

if (process.env.IRIS_FINANCE_AUTOPULL !== '0') {
  // 起動直後は避ける。他の巡回と同じ理由で、立ち上がりに集中させない。
  const first = setTimeout(() => { void pullFinance(); }, 90_000);
  first.unref?.();
  const timer = setInterval(() => { void pullFinance(); }, FINANCE_PULL_MS);
  timer.unref?.();
}

app.get('/api/finance/gmail/templates', (_req, res) => {
  res.json({
    configured: gmail.configured(),
    templates: EMAIL_TEMPLATES.map((t) => ({
      id: t.id,
      label: t.label,
      sender: t.sender,
      requires: t.requires,
      placeholderMerchants: t.placeholderMerchants ?? [],
    })),
    query: notificationQuery(30),
    note:
      'テンプレートのある差出人だけを取得します。認識できないメールからは金額を読みません（推測した金額は支出に見えて、バグには見えないため）。',
  });
});

/**
 * Descriptions that mean money moved between the user's own accounts.
 *
 * Exact strings the user writes, never patterns. A rule of `カード` would also
 * swallow a purchase at a shop with カード in its name, and money reclassified
 * as a transfer disappears from the total rather than being merely misfiled —
 * the direction nobody notices.
 */
/**
 * Retires notifications that a statement has now confirmed.
 *
 * Run explicitly rather than on every import, so the report of what could not
 * be decided is something a person reads rather than a log line that scrolls
 * past.
 */
app.post('/api/finance/reconcile', (req, res) => {
  const result = finance.reconcilePending({
    windowDays: req.body?.windowDays ? Number(req.body.windowDays) : undefined,
  });
  activityLog.info('finance.reconciled', {
    detail: { matched: result.matched.length, ambiguous: result.ambiguous.length, unmatched: result.unmatched.length },
  });
  res.json({
    ...result,
    note:
      '同額・近い日付の候補が複数ある場合は突合しません。どちらか選ぶと購入が1件消え、しかも気づけないためです。' +
      'ambiguous に出たものは実データを見て判断してください。',
  });
});

app.get('/api/finance/transfer-rules', (_req, res) => {
  res.json({
    rules: finance.transferRules(),
    note:
      '摘要の完全一致だけで判定します。一致しないものは支出のまま残るので、規則の書き忘れは合計を多めに出します（少なめには出しません）。',
  });
});

app.post('/api/finance/transfer-rules', (req, res) => {
  const { rule, reason } = finance.addTransferRule({
    description: String(req.body?.description ?? ''),
    account: req.body?.account ? String(req.body.account) : null,
    note: req.body?.note ? String(req.body.note) : null,
  });
  if (!rule) {
    res.status(400).json({ rule: null, reason });
    return;
  }
  // Applied to what is already stored, or the correction only covers money
  // not yet spent.
  const applied = finance.reclassify();
  activityLog.warn('finance.transfer_rule_added', {
    detail: { description: rule.description, account: rule.account, reclassified: applied.changed },
  });
  res.status(201).json({ rule, reason, reclassified: applied });
});

app.delete('/api/finance/transfer-rules/:id', (req, res) => {
  const removed = finance.removeTransferRule(req.params.id);
  const applied = removed ? finance.reclassify() : { changed: 0, months: [] };
  res.json({ removed, reclassified: applied });
});

app.delete('/api/finance/imports/:id', (req, res) => {
  const result = finance.removeImport(req.params.id);
  activityLog.warn('finance.import_removed', { detail: { import: req.params.id, deleted: result.deleted } });
  res.json(result);
});

/**
 * Copies of the database, because there were none.
 *
 * On 2026-08-20 the only backups were two manual snapshots from two days
 * earlier, one a twentieth of the current size — every decision, experience
 * and correction since existed in exactly one place. `finance_local_boundary`
 * forbids automatic cloud backup, so this is local and thinned: dense where
 * mistakes are usually caught, sparse where they are occasionally caught,
 * nothing past a year.
 *
 * Outside the repository on purpose. `~/Downloads` is TCC-protected and
 * commonly excluded from Time Machine, which is a poor place for the only
 * copy of anything.
 */
const backups = new BackupService({
  db,
  directory: path.join(os.homedir(), 'Library/Application Support/IRIS/backups'),
  /*
   * `.env` も一緒に写す。**データベース以外で、控えの無い唯一のもの。**
   *
   * git は無視する（鍵が入るので当然）し、`VACUUM INTO` はデータベースしか
   * 見ない。API キーと、どの codex を使うかと、委任先のリポジトリ —— 消えると
   * 本当に戻らないのはここだけだった（2026-09-08、リポジトリを ~/Downloads
   * から移したときに数えて分かった）。
   */
  configFile: path.join(process.cwd(), '.env'),
  onEvent: ({ type, detail }) =>
    activityLog.log({ level: type === 'backup.taken' ? 'info' : 'warn', event: type, detail }),
});

// Once at startup and daily after. Taking one at startup means a machine that
// is rarely on still has a copy from the last time it ran, rather than a
// schedule that never fires.
void (() => {
  const result = backups.run();
  if (!result.ok) console.warn(`⚠️  バックアップを取得できません: ${result.reason}`);
})();
const backupTimer = setInterval(() => loopWatch.during('backups.run', () => backups.run()), 24 * 60 * 60_000);
backupTimer.unref();

app.get('/api/backups', (_req, res) => {
  const files = backups.describe();
  res.json({
    directory: path.join(os.homedir(), 'Library/Application Support/IRIS/backups'),
    backups: files,
    newest: files[0]?.takenAt ?? null,
    note:
      '取得のたびに開いて検証してから古いものを間引きます。' +
      '保持は 日別14 / 週別1ヶ月 / 月別1年。クラウドには送りません（finance_local_boundary）。',
  });
});

app.post('/api/backups', (_req, res) => {
  const result = backups.run();
  res.status(result.ok ? 201 : 500).json(result);
});

/**
 * Who else on this machine can read what IRIS keeps.
 *
 * Applied at every start rather than once by hand: a directory recreated later
 * inherits the umask, and the tightening would undo itself the first time
 * something was rebuilt. Checked as well as applied, so a failure to tighten
 * is visible instead of assumed.
 */
const PERMISSION_TARGETS: PermissionTarget[] = [
  {
    path: path.join(os.homedir(), 'Library/Application Support/IRIS/finance'),
    kind: 'directory',
    holds: '金融明細の CSV',
  },
  {
    path: path.join(os.homedir(), 'Library/Application Support/IRIS/backups'),
    kind: 'directory',
    holds: 'DB 全体のコピー（local_only の明細を含む）',
  },
  {
    path: path.join(os.homedir(), 'Library/Application Support/IRIS/worktrees'),
    kind: 'directory',
    holds: 'エージェントの作業ディレクトリ',
  },
  { path: dbPath, kind: 'file', holds: '記憶・判断・経験・金融明細' },
];

const permissionState = PERMISSION_TARGETS.map(enforcePermissions);
for (const state of permissionState) {
  if (!state.ok) console.warn(`⚠️  権限が開いています: ${state.path} — ${state.reason}`);
}

app.get('/api/permissions', (_req, res) => {
  const current = PERMISSION_TARGETS.map(enforcePermissions);
  res.json({
    targets: current.map((c) => ({
      ...c,
      mode: c.mode === null ? null : c.mode.toString(8).padStart(3, '0'),
    })),
    note:
      'ディレクトリは 700、ファイルは 600。IRIS が何を渡すかとは別の話で、' +
      '同じマシンの他アカウントがファイルを直接開けるかどうかです。起動のたびに適用し直します。',
  });
});

/** Everything believed right now, and everything explicitly not known. */
app.get('/api/context', (_req, res) => {
  res.json({
    ...context.current(),
    kinds: context.describeKinds(),
    note:
      '各フィールドは自分の観測時刻と信頼度を持ちます。unknown は「否定」ではなく「未観測」です。' +
      '較正されていない観測源の数値は確率として扱わず、band を使ってください。',
  });
});

/**
 * The same present the model sees.
 *
 * Deliberately the same call the tool makes, so what is inspected here and
 * what reaches a conversation cannot drift apart. `?format=text` returns the
 * rendered form, which is the one worth reading when checking whether the
 * wording is honest about freshness.
 */
app.get('/api/life-state', (req, res) => {
  try {
    const state = lifeState.current();
    if (req.query.format === 'text') {
      res.type('text/plain; charset=utf-8').send(renderLifeState(state));
      return;
    }
    res.json({
      ...state,
      note:
        'この層は何も保持しません。Context Engine・記憶・時刻をその場で読んで組み立てています。' +
        'unknown は「否定」ではなく「未観測、または古すぎる」です。',
    });
  } catch (err) {
    handleError(res, err, 'life_state.error');
  }
});

app.get('/api/context/history/:kind', (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
  res.json({ kind: req.params.kind, observations: context.history(req.params.kind, limit) });
});

app.get('/api/proactive', (_req, res) => {
  res.json({
    rules: proactive.listRules(),
    pending: proactive.listPending(),
    /**
     * 返事を待っている、IRIS から始めた会話。盤のレールがこれを読んで印を出す。
     * 盤は一本の巡回でこの口を読んでいるので、別の口を足さずにここへ載せる。
     */
    openers: proactiveOpeners.recent(20)
      .filter((o) => !o.replied)
      .map((o) => ({ conversationId: o.conversationId, ruleId: o.ruleId, title: o.title, label: railLabel(o.ruleId), createdAt: o.createdAt })),
    note:
      '提案は提案であり、実行ではありません。受理して起動した対話は origin=inferred として扱われ、' +
      'EXTERNAL_ACTION と DESTRUCTIVE のツールには到達できません。',
  });
});

/**
 * IRIS が先に話しかけた会話。新しい順に、返事があったかどうかを添えて。
 *
 * 画面はこれを見て、返事を待っている話があれば会話を開く（手が空いていれば）
 * か、入力欄の上に知らせを出す（打っている途中なら）。
 */
app.get('/api/proactive/openers', (_req, res) => {
  try {
    res.json({ openers: proactiveOpeners.recent(20) });
  } catch (err) {
    handleError(res, err, 'proactive.openers_failed');
  }
});

app.post('/api/proactive/rules', (req, res) => {
  try {
    const rule = proactive.addRule(req.body);
    // **通ってから保存する。**先に書くと、動かない規則が起動のたびに蘇る。
    proactiveRules.save(rule);
    res.json(rule);
  } catch (err) {
    handleError(res, err, 'proactive.rule_rejected');
  }
});

/**
 * 規則を黙らせる／戻す。**消さない。**
 *
 * 消すと「なぜ在ったか」も消える。止めたい理由はたいてい「いまは要らない」
 * であって「間違いだった」ではない。
 */
app.patch('/api/proactive/rules/:id', (req, res) => {
  const on = req.body?.enabled !== false;
  if (!proactiveRules.setEnabled(req.params.id, on)) {
    res.status(404).json({ ok: false, reason: 'その規則はありません。' });
    return;
  }
  res.json({ ok: true, id: req.params.id, enabled: on, note: '次の起動から反映されます。' });
});

/** Checks the rules against the present. Fires nothing on its own schedule. */
app.post('/api/proactive/evaluate', (_req, res) => {
  const evaluations = proactive.evaluate();
  res.json({ evaluations, pending: proactive.listPending() });
});

/**
 * Runs a suggestion the user chose.
 *
 * origin `inferred` is the point of this endpoint existing at all: the same
 * text sent through /api/chat would be a user turn, and would carry a user's
 * permissions.
 */
app.post('/api/proactive/:id/accept', async (req, res) => {
  try {
    const { prompt, suggestion } = proactive.accept(req.params.id);
    if (!prompt) {
      res.json({ ran: false, suggestion });
      return;
    }
    if (!chatService) {
      res.status(503).json({ error: 'プロバイダが設定されていないため実行できません。' });
      return;
    }
    const result = await chatService.sendMessage({
      conversationId: req.body?.conversationId ?? null,
      message: prompt,
      origin: 'inferred',
    });
    res.json({ ran: true, suggestion, result });
  } catch (err) {
    handleError(res, err, 'proactive.accept_failed');
  }
});

app.post('/api/proactive/:id/dismiss', (req, res) => {
  res.json({ dismissed: proactive.dismiss(req.params.id) });
});

/**
 * Audits public skill candidates against the repositories known to IRIS.
 * GET uses the local daily cache; POST explicitly refreshes it.
 */
app.get('/api/skills/recommendations', async (_req, res) => {
  try {
    res.json(await skillAdvisor.recommend(false));
  } catch (err) {
    handleError(res, err, 'skills.recommendations_failed');
  }
});

app.post('/api/skills/recommendations/refresh', async (_req, res) => {
  try {
    res.json(await skillAdvisor.recommend(true));
  } catch (err) {
    handleError(res, err, 'skills.recommendations_refresh_failed');
  }
});

/**
 * What is being kept, and what is on disk that nothing is keeping.
 *
 * A record of when someone was home should be answerable at any moment:
 * which kinds, how long, how much, since when, and on whose decision.
 */
app.get('/api/context/retention', (_req, res) => {
  res.json({
    kept: contextStore.summary(),
    /** Data whose policy was turned off. Kept, but visible rather than lost. */
    orphaned: contextStore.orphaned(),
    total: contextStore.count(),
    note:
      '方針のない観測種別は一切保存されません。有効化には保持期間の指定が必須で、無期限はありません。',
  });
});

/**
 * Starts keeping a kind. Requires a retention period in the same call — there
 * is no path here that results in an unbounded record of a person's days.
 */
app.post('/api/context/retention', (req, res) => {
  try {
    const policy = contextStore.enable({
      kind: String(req.body?.kind ?? ''),
      retainMs: Number(req.body?.retainMs),
      maxRows: req.body?.maxRows === undefined ? undefined : Number(req.body.maxRows),
      note: req.body?.note ?? null,
    });
    activityLog.warn('context.retention_enabled', {
      message: policy.kind,
      detail: policy,
    });
    res.json(policy);
  } catch (err) {
    handleError(res, err, 'context.retention_rejected');
  }
});

/** Stops keeping a kind. Deletes what was gathered only if asked. */
app.delete('/api/context/retention/:kind', (req, res) => {
  const result = contextStore.disable(req.params.kind, {
    deleteExisting: req.query.deleteExisting === 'true',
  });
  activityLog.warn('context.retention_disabled', { message: req.params.kind, detail: result });
  res.json(result);
});

/** The stored record, so it can be taken out and read. */
app.get('/api/context/export', (req, res) => {
  const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
  const observations = contextStore.exportAll(kind);
  res.json({ kind: kind ?? null, count: observations.length, observations });
});

/** Drops what has been observed, for a user who does not want it held. */
app.post('/api/context/forget', (req, res) => {
  const kind = typeof req.body?.kind === 'string' ? req.body.kind : undefined;
  const dropped = context.forget(kind);
  // In memory and on disk both: a user asking to be forgotten does not mean
  // "from the part you happened to keep in RAM".
  const deleted = contextStore.forget(kind);
  activityLog.warn('context.forgotten', { message: kind ?? 'all', detail: { dropped, deleted } });
  res.json({ dropped, deleted, kind: kind ?? null });
});

/**
 * Voice output.
 *
 * Neural first, on-device last. The good voice when the network and the
 * account are there; something rather than silence when they are not. The
 * cloud engines start disabled — a key configured for chat is not consent to
 * upload every spoken reply — and enabling one is a request to this server,
 * recorded in the activity log.
 */
// The same helper that transcribes also plays: cloud engines stream raw PCM
// into it, which is what took time-to-first-audio from seconds to ~1.5s.
const playerPath = () => speech.resolveBinary(REPO_ROOT);

const deviceTts = new DeviceTtsEngine(playerPath);
const googleTts = new GoogleTtsEngine({
  enabled: process.env.IRIS_TTS_GOOGLE === 'true',
  voiceName: process.env.IRIS_TTS_GOOGLE_VOICE,
  languageCode: process.env.IRIS_SPEECH_LOCALE || 'ja-JP',
  playerPath,
});
const openaiTts = new OpenAiTtsEngine({
  enabled: process.env.IRIS_TTS_OPENAI === 'true',
  model: process.env.IRIS_TTS_OPENAI_MODEL,
  defaultVoice: process.env.IRIS_TTS_OPENAI_VOICE,
  // Direction for delivery, which is the lever the reading dictionary cannot
  // reach. Only OpenAI among the configured engines accepts it.
  defaultInstructions: process.env.IRIS_TTS_OPENAI_INSTRUCTIONS,
  playerPath,
});
const elevenTts = new ElevenLabsTtsEngine({
  enabled: process.env.IRIS_TTS_ELEVENLABS === 'true',
  model: process.env.IRIS_TTS_ELEVENLABS_MODEL,
  voiceId: process.env.IRIS_TTS_ELEVENLABS_VOICE,
  outputFormat: process.env.IRIS_TTS_ELEVENLABS_FORMAT,
  languageCode: process.env.IRIS_TTS_ELEVENLABS_LANGUAGE,
  playerPath,
});

// Neural first, on-device last — the good voice when the network is there,
// and something rather than silence when it is not.
/**
 * Reading corrections, applied above every engine.
 *
 * Heard on 2026-08-19: the on-device voice read 平滑筋 as へいかつすじ. Whether
 * any given cloud voice would make the same mistake is not known and cannot
 * be learned from normal use, because the correction is applied before the
 * text reaches an engine at all. That is the intended arrangement — each
 * vendor gets a different subset of Japanese compounds wrong, and the
 * knowledge belongs in one place rather than being rediscovered per engine —
 * but it does mean "the new voice read it correctly" is evidence about this
 * dictionary, not about the voice.
 */
const pronunciations = new PronunciationStore(db);
{
  const { inserted } = pronunciations.seed();
  if (inserted > 0) console.log(`🗣  読み辞書: ${inserted} 件を追加`);
}

const tts = new TtsService([googleTts, elevenTts, openaiTts, deviceTts], {
  // Notation first, vocabulary second. `8/24` has to become `8月24日` before
  // the dictionary looks at it, or a reading keyed on 日 never sees one.
  //
  // Both rewrite the spoken string only. The display and the transcript keep
  // what the user actually wrote — a log reading 8月24日 where they typed 8/24
  // has replaced one wrong record with another.
  pronounce: (text) => {
    const normalized = normalizeForSpeech(text);
    const spoken = applyPronunciations(normalized.text, pronunciations.list());
    return {
      text: spoken.text,
      applied: [
        ...normalized.applied.map((r) => ({ term: r.from, reading: r.to, count: 1 })),
        ...spoken.applied,
      ],
    };
  },
  order: (process.env.IRIS_TTS_ORDER || 'google,elevenlabs,openai,device').split(',').map((s) => s.trim()),
  defaultVoice: process.env.IRIS_TTS_VOICE,
  locale: process.env.IRIS_SPEECH_LOCALE || 'ja-JP',
  onEvent: ({ type, detail }) => {
    const level = type === 'tts.fallback' || type === 'tts.failed_mid_utterance' ? 'warn' : 'info';
    activityLog.log({ level, event: type, detail });
  },
});

app.get('/api/tts', async (_req, res) => {
  try {
    res.json(await tts.status());
  } catch (err) {
    handleError(res, err, 'tts.status_failed');
  }
});

app.get('/api/tts/voices', async (req, res) => {
  try {
    const engine = typeof req.query.engine === 'string' ? req.query.engine : undefined;
    res.json({ voices: engine ? await tts.voices(engine) : await tts.allVoices() });
  } catch (err) {
    handleError(res, err, 'tts.voices_failed');
  }
});

app.post('/api/tts/speak', async (req, res) => {
  try {
    const result = await tts.speak(String(req.body?.text ?? ''), {
      engine: req.body?.engine,
      voice: req.body?.voice,
      rate: req.body?.rate,
      pitch: req.body?.pitch,
    });
    // After the audio, not during: the echo is still arriving while the
    // player drains, and comparing early would report the unspoken tail.
    setTimeout(() => finishAudit(), 1_500).unref?.();
    res.json(result);
  } catch (err) {
    handleError(res, err, 'tts.speak_failed');
  }
});

app.post('/api/tts/select', (req, res) => {
  try {
    if (Array.isArray(req.body?.order)) tts.setOrder(req.body.order.map(String));
    if (req.body?.engine) tts.select(String(req.body.engine), req.body?.voice);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 'tts.select_failed');
  }
});

/**
 * Turns a cloud engine on or off. Logged as a warning when enabling, because
 * it changes where the user's words go.
 */
app.post('/api/tts/engines/:id', (req, res) => {
  const enabled = req.body?.enabled === true;
  const engine =
    req.params.id === 'openai' ? openaiTts
    : req.params.id === 'elevenlabs' ? elevenTts
    : req.params.id === 'google' ? googleTts
    : null;
  if (!engine) {
    res.status(400).json({ error: 'このエンジンは切り替えできません。' });
    return;
  }
  engine.setEnabled(enabled);
  activityLog.log({
    level: enabled ? 'warn' : 'info',
    event: 'tts.engine_toggled',
    message: `${req.params.id}: ${enabled ? '有効' : '無効'}`,
    detail: { engine: req.params.id, enabled, sendsTextOffDevice: enabled },
  });
  res.json({ engine: req.params.id, enabled });
});

/**
 * The reading dictionary.
 *
 * Worth being able to inspect: a wrong entry is applied silently and
 * consistently, which is exactly how a mistake stops being noticed.
 */
app.get('/api/tts/pronunciations', (_req, res) => {
  res.json({
    entries: pronunciations.list(),
    note: '読み上げ時のみ置換します。画面と会話履歴の文字列は変更されません。',
  });
});

/** Corrects a reading. Recorded as a user entry, which outranks the shipped list. */
app.post('/api/tts/pronunciations', (req, res) => {
  try {
    const entry = pronunciations.set(
      String(req.body?.term ?? ''),
      String(req.body?.reading ?? ''),
      req.body?.note ?? null
    );
    activityLog.info('tts.pronunciation_set', { message: `${entry.term} → ${entry.reading}` });
    res.json(entry);
  } catch (err) {
    handleError(res, err, 'tts.pronunciation_rejected');
  }
});

app.delete('/api/tts/pronunciations/:term', (req, res) => {
  res.json({ removed: pronunciations.remove(req.params.term) });
});

/**
 * Delivery direction for the engines that accept it.
 *
 * Separate from voice selection: the same voice reads very differently when
 * told to. Not persisted, for the same reason a raised budget limit is not —
 * a style tried once should not quietly become the default.
 */
app.post('/api/tts/instructions', (req, res) => {
  const text = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';
  openaiTts.setInstructions(text || undefined);
  activityLog.info('tts.instructions_set', { message: text.slice(0, 120) || '(解除)' });
  res.json({
    instructions: openaiTts.instructions ?? null,
    appliesTo: ['openai'],
    note:
      'Chirp 3: HD は REST では話し方の指示を受け付けません。恒久化するには ' +
      'IRIS_TTS_OPENAI_INSTRUCTIONS を .env に設定してください。',
  });
});

/**
 * How the last reading actually came out.
 *
 * Candidates, not corrections. Each line is the voice mispronouncing, the
 * recogniser mishearing, or the room — and nothing here can tell which.
 */
app.get('/api/tts/audit', (_req, res) => {
  if (!lastAudit) {
    res.json({
      audit: null,
      note:
        'まだ照合していません。マイクが開いた状態でスピーカーから読み上げると照合できます。' +
        'イヤホンでは音響経路がないため照合できません。',
    });
    return;
  }
  res.json({
    audit: lastAudit,
    description: describeAudit(lastAudit),
    note: '原因は3通り（読み上げの誤読・認識の誤り・雑音）あり、区別できるのは聞いた人だけです。辞書には自動追加しません。',
  });
});

app.post('/api/tts/stop', (_req, res) => {
  tts.stop();
  res.json({ ok: true });
});

function speechError(res: Response, err: any) {
  if (err instanceof SpeechHelperMissingError) {
    res.status(503).json({ error: err.message, code: 'helper_not_built' });
    return;
  }
  handleError(res, err, 'speech.error');
}

app.get('/api/speech/status', (_req, res) => {
  res.json({ ...speech.status(), recent: speech.peek(10) });
});

app.get('/api/speech/probe', async (_req, res) => {
  try {
    res.json(await speech.probe(REPO_ROOT, String(req_locale(_req))));
  } catch (err) {
    speechError(res, err);
  }
});

app.post('/api/speech/install', async (req, res) => {
  try {
    res.json(await speech.install(REPO_ROOT, String(req_locale(req))));
  } catch (err) {
    speechError(res, err);
  }
});

/**
 * Opens the microphone. Deliberately a POST with no default-on path: an
 * always-on listener must be something the user turned on.
 */
app.post('/api/speech/start', (req, res) => {
  try {
    /**
     * `push` while a key is held, `ambient` otherwise.
     *
     * The mode decides what counts as being addressed, which is the one thing
     * standing between a microphone and a room full of remarks. Defaulting to
     * `ambient` means the stricter rule applies unless something asks for the
     * looser one.
     */
    voice.setMode(req.body?.mode === 'push' ? 'push' : 'ambient');
    // Anything still queued belongs to a previous request. A push-to-talk turn
    // means "what I say from now"; delivering the leftovers made IRIS answer a
    // sentence from minutes earlier, correctly, which looked like nothing was
    // wrong at all.
    const stale = voice.discardPending();
    if (stale > 0) {
      activityLog.info('voice.discarded', { detail: { count: stale } });
    }
    speech.start(REPO_ROOT, String(req_locale(req)));
    res.json(speech.status());
  } catch (err) {
    speechError(res, err);
  }
});

app.post('/api/speech/stop', async (_req, res) => {
  await speech.stop();
  res.json(speech.status());
});

/**
 * Takes the transcripts and forgets them, so the same sentence cannot be
 * acted on twice. What the caller does with them is the caller's decision.
 */
/**
 * Transcripts, each marked with whether it was addressed to IRIS.
 *
 * The decision is made here rather than in the client, so it is the same code
 * the tests cover and the client keeps not importing from `server/`. What the
 * client does with the flag stays the client's business — today it sends the
 * addressed ones and puts the rest in the input box, which is where an
 * unaddressed remark has always gone.
 */
/**
 * The loop that makes speaking to IRIS possible without IRIS being open.
 *
 * The rule it carries — only what is addressed becomes a request — was written
 * in the browser and is unchanged. What changed is that a web page is no
 * longer the only thing that can hear.
 */
const voice = new VoiceLoop({
  status: () => {
    const s = speech.status();
    return { state: String(s.state), pending: Number(s.pending ?? 0) };
  },
  drain: () => drainForLoop(),
  chat: () => chatService,
  /**
   * Spoken back, because it was spoken to.
   *
   * Not awaited: the turn is already finished and the answer is already on the
   * band, so a slow voice must not hold the loop and delay the next thing
   * heard. A failure here is logged and changes nothing else — being unable to
   * say the reply is not the same as being unable to give it.
   */
  /*
   * 約束を返す。**声の列が本当に順番を守るのはここ次第。**
   *
   * `void` で投げっぱなしにすると、列は呼び出しの順を守るだけで、**前の音が
   * 鳴り終わる前に次が始まる。**文ごとに喋るようにした以上、待つ相手がいる。
   */
  speak: (text) =>
    tts.speak(text, {}).then(() => undefined).catch((err: any) => {
      activityLog.warn('voice.speak_failed', { detail: { message: err?.message ?? String(err) } });
    }),
  conversationId: () => voiceConversation,
  setConversationId: (id) => { voiceConversation = id; },
  onEvent: (event) => {
    // A tick that found nothing is not worth a row in the record; a tick that
    // found something and did nothing with it is exactly what needs finding.
    if (event.type !== 'voice.tick' || (event.count ?? 0) > 0) {
      console.log(`[voice] ${event.type} ${JSON.stringify(event)}`);
    }
    activityLog.log({
      level: event.type === 'voice.failed' ? 'warn' : 'info',
      event: event.type,
      detail: { text: event.text, tool: event.tool, count: event.count, message: event.message },
    });
    lastVoice = { ...event, at: new Date().toISOString() };
  },
});

/** Voice turns land in one conversation rather than scattering. */
let voiceConversation: string | null = null;
/** The most recent thing heard, for the resident interface to show. */
let lastVoice: (Record<string, unknown> & { at: string }) | null = null;

voice.start();

/**
 * How much of the top of the screen the resident band is covering.
 *
 * macOS does not know the band is there — `visibleFrame` accounts for the menu
 * bar and the Dock and nothing else — so a maximised window goes underneath it
 * and loses its first fifty points. The band cannot fix that for other
 * applications, but it can tell this one, which is the one that most often has
 * something worth reading up there.
 *
 * Reported by the band rather than assumed, and it expires: a band that was
 * closed without saying so should not leave a gap behind it forever.
 */
let stripCover: { height: number; at: number } | null = null;

/**
 * Every coding session on this machine, and how long since it last moved.
 *
 * Read fresh. Both directories are private formats belonging to tools that did
 * not promise to keep them stable, so nothing is cached and a file that cannot
 * be understood is counted rather than skipped.
 */
/**
 * The weather, if the user has made the shortcut that provides it.
 *
 * Reports the reason when there is none, because "no shortcut" and "no
 * forecast" are different problems and only one of them is fixable by waiting.
 */
/**
 * Every attempt, counted.
 *
 * The service used to return its reason to the caller and write it nowhere,
 * so when the user reported that the location lookup misses too often, their
 * report was the only evidence in existence — no rate, no times, no
 * distinction between the shortcut coming back empty and never running. The
 * cache made it unmeasurable from outside too: five requests over five
 * minutes returned the same figure from 16:59:50, because a success is held
 * for fifteen minutes.
 *
 * Counting comes before changing the thing being counted. Otherwise the next
 * fix is judged by the same feeling it was meant to address.
 */
const weatherTally = new Map<string, number>();
onWeatherOutcome((outcome) => {
  weatherTally.set(outcome.result, (weatherTally.get(outcome.result) ?? 0) + 1);
  activityLog.log({
    level: outcome.result === 'ok' ? 'info' : 'warn',
    event: `weather.${outcome.result}`,
    message: outcome.reason ?? outcome.sample ?? '',
    detail: { ms: outcome.ms },
  });
});

app.get('/api/weather', async (_req, res) => {
  const read = await readWeather();
  /**
   * The tally travels with the reading, so "it misses a lot" can be answered
   * without going to the log. Since start-up only: the durable record is the
   * activity log, and two numbers that could disagree would be worse than one.
   */
  res.json({ ...read, attempts: Object.fromEntries(weatherTally) });
});

/**
 * How long it takes to reach the next appointment, when that is a question.
 *
 * Only asked for events inside the window, and the window is the point. A
 * route to somewhere the day after tomorrow is not information — traffic then
 * is unknowable, and the figure would sit on the band all day being wrong in a
 * way nobody could check. Inside three hours it is the whole question.
 *
 * Silent about places it does not know. An unmapped title is the ordinary
 * case, not a fault: most appointments are not somewhere you travel to.
 */
/**
 * Where this machine is, as the band measures it.
 *
 * IRIS has no location of its own: it is a server process, and Core Location
 * belongs to an application with a window and a permission prompt. The band
 * already holds a working client — built for travel times, hundred-metre
 * accuracy, cached for five minutes — so the fix for anything that needs a
 * position is to let it say what it knows rather than to ask a second
 * subsystem the same question.
 *
 * Posted rather than polled. The band knows when its fix changes; asking it on
 * a timer would either miss the change or wake the location service far more
 * often than anything here needs.
 *
 * This is also the measurement that decides whether the weather's location
 * problem is a location problem at all. If nothing ever arrives here, the band
 * has no fix either and the shortcut is not the thing at fault.
 */
let hereLat: number | null = null;
let hereLon: number | null = null;
let hereAt = 0;
/** Beyond this the position is a place the machine used to be. */
const HERE_TTL = 30 * 60_000;

app.post('/api/location', (req, res) => {
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.status(400).json({ error: 'lat と lon が要ります。' });
    return;
  }
  hereLat = lat;
  hereLon = lon;
  hereAt = Date.now();
  res.status(204).end();
});

app.get('/api/location', (_req, res) => {
  const age = Date.now() - hereAt;
  if (hereLat === null || age > HERE_TTL) {
    res.json({
      lat: null,
      lon: null,
      ageMinutes: hereLat === null ? null : Math.round(age / 60_000),
      reason:
        hereLat === null
          ? '帯からまだ現在地が届いていません。位置情報の許可を確認してください。'
          : '届いている現在地が古すぎます。',
    });
    return;
  }
  res.json({ lat: hereLat, lon: hereLon, ageMinutes: Math.round(age / 60_000), reason: null });
});

/**
 * Locks on files that would be gone if somebody deleted them.
 *
 * The fence is the kernel's, not IRIS's: `chflags uchg`, which answers
 * "Operation not permitted" to a delete and to an overwrite alike. What IRIS
 * adds is the half the flag does not carry — why it was applied, by whom, and
 * above all when it came off and what for. A lock whose removal leaves no
 * trace is worth much less than one that records the moment worth reviewing.
 *
 * It stops the slip, not the decision. `chflags nouchg` is one command and
 * anybody can type it; `drifted` exists because they can, and a lock the
 * ledger believes in while the disk does not is the one thing here that would
 * be actively misleading.
 */
app.get('/api/locks', (req, res) => {
  const all = req.query.all === 'true';
  res.json({ locks: locks.list(all), drifted: locks.drifted() });
});

app.post('/api/locks', (req, res) => {
  const path = String(req.body?.path ?? '').trim();
  const reason = String(req.body?.reason ?? '').trim();
  // Required, not defaulted. The reason is the whole value of the ledger, and
  // an empty one would let the interesting rows be the blank ones.
  if (!path || !reason) {
    res.status(400).json({ error: 'path と reason が要ります。' });
    return;
  }
  const result = locks.lock(path, reason, String(req.body?.by ?? 'user'));
  if (!result.ok) {
    res.status(result.code === 'flag_failed' ? 500 : 400).json({ error: result.message, code: result.code });
    return;
  }
  activityLog.info('lock.applied', { message: reason, detail: { path: result.lock.path } });
  res.status(201).json({ lock: result.lock });
});

app.delete('/api/locks', (req, res) => {
  const path = String(req.body?.path ?? req.query.path ?? '').trim();
  const reason = String(req.body?.reason ?? req.query.reason ?? '').trim();
  if (!path || !reason) {
    res.status(400).json({ error: 'path と reason が要ります。外した理由が記録の本体です。' });
    return;
  }
  const result = locks.unlock(path, reason, String(req.body?.by ?? 'user'));
  if (!result.ok) {
    res.status(result.code === 'flag_failed' ? 500 : 400).json({ error: result.message, code: result.code });
    return;
  }
  /** Warn, not info: taking protection off is the event worth noticing. */
  activityLog.warn('lock.released', { message: reason, detail: { path: result.lock.path } });
  res.json({ lock: result.lock });
});

app.get('/api/travel/next', async (_req, res) => {
  /**
   * Three hours, and adjustable only so it can be tested.
   *
   * The next appointment is usually a day or more away, which means the
   * ordinary state of this endpoint is "nothing to measure" — and a path that
   * only runs when someone happens to have a meeting soon is a path that goes
   * untested until it is needed.
   */
  const WINDOW_MINUTES = Number(process.env.IRIS_TRAVEL_WINDOW_MINUTES) || 180;
  try {
    const reading = await calendar.readBest(2);
    const now = Date.now();
    const upcoming = (reading.events ?? [])
      .filter((e) => !e.allDay && e.start)
      .map((e) => ({ event: e, at: Date.parse(e.start as string) }))
      .filter((e) => Number.isFinite(e.at) && e.at > now)
      .sort((a, b) => a.at - b.at)[0];

    /**
     * The place names travel with the answer.
     *
     * The band writes an unknown title in quotes — 「ガウス」 — because a
     * calendar title is arbitrary text and quoting is what stops it running
     * into the sentence around it. A name this machine can resolve to an
     * address is not arbitrary; it is a place, and a place reads as a word.
     * Only the match strings go over the wire. The addresses stay here.
     */
    const known = readPlaces(process.cwd()).places.map((p) => p.match);

    if (!upcoming) {
      res.json({ to: null, label: null, minutesUntil: null, reason: null, knownPlaces: known });
      return;
    }

    const minutesUntil = Math.round((upcoming.at - now) / 60_000);
    if (minutesUntil > WINDOW_MINUTES) {
      // Outside the window there is nothing to ask for. Traffic the day after
      // tomorrow is not knowable, and a figure nobody can check would sit on
      // the band all day being wrong.
      res.json({ to: null, label: null, minutesUntil, reason: null, knownPlaces: known });
      return;
    }

    // The project's own `.iris/`, not the home directory: these are addresses
    // for this installation's calendar, and `.iris/` is already ignored by git
    // so they do not travel with the source.
    const { places, reason: placesReason } = readPlaces(process.cwd());
    const place = resolveAddress(upcoming.event.title, places);
    const address = place?.address ?? upcoming.event.location?.trim() ?? null;
    res.json({
      to: address,
      label: upcoming.event.title,
      minutesUntil,
      knownPlaces: known,
      // An unmapped title is the ordinary case — most appointments are not
      // somewhere you travel to — so it is only worth a reason when the map
      // itself could not be read.
      reason: address ? null : placesReason,
    });
  } catch (err: any) {
    handleError(res, err, 'travel.error');
  }
});

/**
 * The next exam, cached for an hour.
 *
 * Six months of calendar is a much larger read than the band's other polls,
 * and an exam date does not move between one glance and the next. The cache
 * is what makes a permanent countdown affordable on a forty-five second poll.
 */
let examCache: { value: any; at: number } | null = null;
/**
 * しばらくの予定と、そこから出した空き時間。
 *
 * One endpoint rather than two: the free time is only meaningful beside the
 * events it was derived from, and a caller that could fetch one without the
 * other would be able to show gaps without showing what makes them gaps.
 *
 * The free text is built here rather than in the browser because it is the
 * part that leaves the machine. Whoever pastes it is handing someone else a
 * claim about their week, so the sources and the time travel with it.
 */
/**
 * 源どうしの食い違い。
 *
 * 「iPhone には入っているのに Mac に入らないことがある」（利用者、2026-09-06）。
 * この機械は同じ予定を三つの場所から読んでいるので、**三つが違うことを言えば
 * それがそのまま検知になる。**
 *
 * 各源を**別々に**読む。`readBest` は併合してから返すので、併合したあとでは
 * 誰が持っていなかったのかが消えている —— 併合は答えを出すための道具で、
 * ここで要るのはその手前。
 */
app.get('/api/calendar/divergence', async (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '14'), 10) || 14, 1), 31);
  const readings: SourceReading[] = [];

  const gather = async (source: string, run: () => Promise<{ events?: any[] }>) => {
    try {
      const reading = await run();
      readings.push({ source, ok: true, events: (reading.events ?? []) as any });
    } catch (err: any) {
      readings.push({ source, ok: false, events: [], reason: err?.message ?? String(err) });
    }
  };

  await Promise.all([
    gather('eventkit', () => calendar.read(days)),
    ...(googleCalendar.configured() ? [gather('google', () => googleCalendar.read(days))] : []),
    ...(icloudCalendar.configured() ? [gather('icloud', () => icloudCalendar.read(days))] : []),
  ]);

  res.json({ days, ...findDivergence(readings) });
});

/**
 * 打った一行を、予定の下書きにする。**まだ書かない。**
 *
 * 返すのは解決済みの絶対値と、埋まらなかったもの、疑わしいもの。画面は
 * これを出して、人が見てから登録する。
 */
app.post('/api/calendar/draft', async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) {
    res.status(400).json({ error: '解釈する文がありません。' });
    return;
  }
  if (!router) {
    res.status(503).json({ error: '模型に繋がっていないので解釈できません。' });
    return;
  }
  try {
    /*
     * 道具を渡さない。空の指示。
     *
     * 題名付けと同じ扱いで、経路も同じにしてある —— 一行を読むのに履歴も
     * 道具も承認の境界も要らない。**道具の一覧を渡すと使いたくなる。**
     */
    const answer = await router.generateResponse(
      [{ role: 'user', content: buildEventPrompt(text, new Date()) }],
      [],
      'JSON だけを返してください。'
    );
    const draft = parseEventDraft(answer?.content ?? '', new Date(), text);
    if (!draft) {
      /*
       * 読めなかったことを、空の予定として返さない。**題名だけの予定を
       * 作れる道を残さない。**
       */
      res.json({
        readable: false,
        heard: text,
        reason: '予定として読み取れませんでした。日付と時刻を入れて打ち直してください。',
      });
      return;
    }
    res.json({ readable: true, heard: text, draft, summary: describeEventDraft(draft) });
  } catch (err: any) {
    handleError(res, err, 'calendar.draft_failed');
  }
});

/**
 * 書き込める相手。
 *
 * 読めるものではなく**書けるもの**だけ。祝日や共有された誰かの予定を選ばせて
 * から断るのは一往復遅い。
 */
app.get('/api/calendar/targets', async (_req, res) => {
  /*
   * 両方から集める。**片方が落ちても、もう片方は出す。**
   *
   * Google だけを見ていたときは書ける相手が個人の一つしか無く、職場（20件）と
   * 自宅（9件）は iCloud にあった。**選ばせる意味が無いうえに、職場の予定が
   * 他の職場の予定と別の場所に散る**という状態だった。
   *
   * 落ちた側は `unavailable` として名前を返す。**黙って短い一覧を出すと、
   * 「職場が無い」が「職場には書けない」に見える。**
   */
  const targets: Array<{ id: string; name: string; source: string; primary: boolean }> = [];
  const unavailable: Array<{ source: string; reason: string }> = [];

  const gather = async (source: string, run: () => Promise<Array<{ id: string; name: string; primary?: boolean }>>) => {
    try {
      for (const c of await run()) {
        targets.push({ id: c.id, name: c.name, source, primary: c.primary === true });
      }
    } catch (err: any) {
      unavailable.push({ source, reason: err?.message ?? String(err) });
    }
  };

  await Promise.all([
    gather('google', () => googleCalendar.listWritableCalendars()),
    gather('icloud', () => icloudCalendar.listWritableCalendars()),
  ]);

  res.json({ targets, unavailable });
});

/**
 * 予定を一件作る。
 *
 * **言い回しを受け取らない。**受け取るのは解決済みの下書きだけ。ここに文を
 * 渡せる口を開けると、**画面を経ずに書ける道**ができて、承認の境界が
 * 迂回できるものになる。解釈は上の口、書き込みはこの口、と分けてあるのは
 * そのため。
 *
 * 押した人が承認そのもの。画面には解決済みの日付・時刻・入れる先が出ていて、
 * それを見て押している。**推し量った実行ではないので、承認の台帳は通らない。**
 * 模型が自分で予定を入れたくなったときは別の話で、そのときは道具にして
 * 承認の台帳を通す。
 */
app.post('/api/calendar/events', async (req, res) => {
  const body = req.body ?? {};
  const calendarId = String(body.calendarId ?? '').trim();
  const source = String(body.source ?? '').trim();
  const title = String(body.title ?? '').trim();
  const start = String(body.start ?? '').trim();
  const allDay = body.allDay === true;
  const end = body.end ? String(body.end).trim() : null;
  const location = body.location ? String(body.location).trim() : null;

  if (!calendarId) { res.status(400).json({ error: '入れる先が指定されていません。' }); return; }
  if (source !== 'google' && source !== 'icloud') {
    /*
     * どちらに書くかを、`calendarId` の形から推し量らない。
     *
     * Google は `a@b.com`、iCloud は URL —— 見分けは付くが、**見分けが付く
     * ことと、見分けてよいことは別。**形が似た日が来たときに、黙って別の
     * カレンダーへ書く道になる。呼ぶ側に名乗らせる。
     */
    res.status(400).json({ error: '入れる先の種類（google / icloud）が指定されていません。' });
    return;
  }
  if (!title) { res.status(400).json({ error: '題名がありません。' }); return; }
  const shape = allDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  if (!shape.test(start) || (end !== null && !shape.test(end))) {
    /*
     * 形が合わないものは断る。**「来週の火曜」をここへ渡せないようにする**のが
     * この検査の目的で、打ち間違いを直すためではない。
     */
    res.status(400).json({ error: '日付は解決済みの絶対値で渡してください。' });
    return;
  }

  try {
    /*
     * 時間帯はこの機械のもの。打った人は自分の時計で打っている。
     *
     * 読めなければ東京。**推測を黙って使うより、外れたときに一箇所を見れば
     * いい方がいい。**
     */
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
    const created =
      source === 'google'
        ? await googleCalendar.createEvent({ calendarId, title, start, end, allDay, location, timeZone })
        : await icloudCalendar.createEvent({
            calendarUrl: calendarId, title, start, end, allDay, location, timeZone,
          });
    // 書いたら使い回しを捨てる。入れたものが「無い」と報告されないため。
    calendar.forget();
    activityLog.info('calendar.event_created', {
      message: `${title} を登録した`,
      detail: { source, calendarId, start, end, allDay, timeZone, id: created.id },
    });
    res.status(201).json({ ok: true, source, ...created });
  } catch (err: any) {
    handleError(res, err, 'calendar.create_failed');
  }
});

app.get('/api/schedule', async (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '7'), 10) || 7, 1), 31);
  /**
   * どの日から読むか。`YYYY-MM-DD`。無ければ今日。
   *
   * 週の画面が前後にめくるための口。**形の合わない値は黙って今日に読み替えず、
   * 断る** —— 「来週」を頼んで今週が返ると、画面は来週の顔で今週を出す。
   */
  const fromRaw = req.query.from === undefined ? null : String(req.query.from);
  let fromDay: Date | null = null;
  if (fromRaw !== null) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromRaw);
    const parsed = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
    if (!parsed || parsed.getMonth() !== Number(m![2]) - 1 || parsed.getDate() !== Number(m![3])) {
      return res.status(400).json({ error: 'from は YYYY-MM-DD の実在する日付で渡してください。', from: fromRaw });
    }
    fromDay = parsed;
  }
  try {
    const reading = await calendar.readBest(days, fromDay ? { from: fromDay } : {});
    const events = (reading.events ?? []).map((e: any) => ({
      ...e,
      /** The filing dropped, by the same rule the band uses. */
      shortTitle: subject(String(e.title ?? '')),
    }));

    const contributions = ((reading as any).contributions ?? []).map((c: any) => String(c.source));
    const live = contributions.filter((s: string) => s !== 'cache');

    /**
     * 設定されている源がそろっていなければ、空き時間は出さない。
     *
     * 2026-08-27 の Google 失効では、授業が丸一日消えていた。その状態の空き時間は
     * 授業中の時刻を「空いています」として人に渡すことになる。画面に警告を出しても
     * **コピペした先には警告が付いていかない。**
     */
    const expected = ['google', 'icloud'].filter((name) => contributedExpectations[name]?.());
    const missing = expected.filter((name) => !live.includes(name));

    const today = fromDay ?? new Date();
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      dates.push(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      );
    }

    /**
     * 今日より前は返さない。**「この先 N 日」と名乗っている口なので。**
     * `from` を渡されたときは、その窓の外を返さない —— 理由は同じ。
     *
     * 空き時間はもとから今日を起点に組んでいた（`dates`）のに、予定の方は
     * `readBest` が返したものをそのまま流していた。控えには前の週の予定が
     * 残っているので、**7日と書いてある欄に 9/1 から 9/13 までの13日分が
     * 並んでいた**（実測 2026-09-07、23件のうち9件が過ぎた日）。
     *
     * 数も合っていなかった。見出しの「23件 / 7日」は、7日で数えた件数では
     * ない。**窓の外を混ぜると、窓の大きさを言う数字が意味を失う。**
     *
     * 今日そのものは丸ごと残す。朝の講義が終わっていても、**今日という日は
     * まだ過ぎていない** —— 一日の形を見るのに要る。時刻で切るのは盤の
     * 「今日と明日の予定」の仕事で、あちらは次に何が来るかを言う欄。
     */
    const first = dates[0];
    const last = dates[dates.length - 1];
    const within = events.filter((e: any) => {
      const key = String(e.start ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
      return key >= first && key <= last;
    });

    /*
     * 日ごとに切り分けるのは `sliceByDay` の仕事。
     *
     * ここは開始日で束ねているだけだった。**日をまたぐ予定が、またいだ先の
     * 日に一件も現れない。**「9/8 22:00〜9/9 12:00」の翌日は、9:00 から
     * 24:00 まで丸ごと空きとして出ていた。`freeForDay` の注記は前から
     * 「呼び出し側で切っておく」と言っていて、**切っている呼び出し側が
     * 無かった。**
     */
    const byDay = sliceByDay(within, dates);

    /*
     * 空きは今日から先だけ。**過ぎた日に「空き 15h」と書くのは、使えない時間を
     * 使える顔で出すこと。**前の週をめくったときに起きる。
     */
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const free = missing.length > 0
      ? []
      : dates.filter((d) => d >= todayKey).map((d) => freeForDay(d, byDay.get(d) ?? []));

    res.json({
      days,
      /** 窓の最初の日。画面が「どの週を見ているか」を答えから確かめるため。 */
      from: first,
      events: within,
      free,
      freeText: missing.length > 0 ? null : asPlainText(free, live, new Date()),
      sources: live,
      /** Said plainly, because the absence is the reason there is no free time. */
      blocked:
        missing.length > 0
          ? `${missing.join('・')} が読めていないため、空き時間は出しません。予定が欠けたまま「空いています」と人に渡すことになります。`
          : null,
    });
  } catch (err) {
    handleError(res, err, 'schedule.error');
  }
});

/**
 * 講義日程表とカレンダーの食い違い。
 *
 * 「明日は8:30から授業あると思うんだけど」（利用者、2026-09-08）。**本人の
 * 記憶が気づいて、IRIS は両方を持っていながら黙っていた。**日程表は
 * 1限＝08:30 と書いてあり、カレンダーは 09:40 だった。
 *
 * どちらが正しいとは言わない。**違うと言うだけ。**紙には版があり、刷った
 * あとに動く。判断は人がする —— この口が無くしたいのは、判断ではなく
 * 「気づかないこと」の方。
 */
app.get('/api/lectures/divergence', async (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '14'), 10) || 14, 1), 400);
  try {
    const today = new Date();
    const key = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const until = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days - 1);

    const schedule = readScheduleLectures(process.cwd());
    let events: any[] = [];
    let calendarReason: string | null = null;
    try {
      const reading = await calendar.readBest(days);
      events = (reading.events ?? []) as any[];
    } catch (err: any) {
      calendarReason = err?.message ?? String(err);
    }

    res.json({
      source: schedule.source,
      ...findLectureDivergence({
        lectures: schedule.lectures,
        exams: schedule.exams,
        events,
        from: key(today),
        to: key(until),
        scheduleReason: schedule.reason,
        calendarReason,
        gridFaults: schedule.gridFaults,
      }),
    });
  } catch (err) {
    handleError(res, err, 'lectures.divergence_error');
  }
});

/**
 * 日程表にあってカレンダーに無い授業を、実際に入れる。
 *
 * 「日程表8:30って書いてどうするの？実際に拾えた予定なら正式に予定として
 * 入れて欲しい」（利用者、2026-09-08）。**注記は何も直さない。**
 *
 * **`confirm` が無ければ書かない。**返すのは「入れるとしたらこれ」だけ。
 * 90日で77件あるので、押し間違いで七十件が本物のカレンダーに増える口を
 * 作らない —— 消すのは一件ずつになる。
 *
 * 時刻が違うだけのものには触らない。**IRIS は予定を作れるが直せない。**
 * 同じ授業をもう一件足せば、間違った時刻の予定が消えるのではなく二つに
 * なる。直すには既存を書き換える力が要り、それは別の話。
 */
app.post('/api/lectures/import', async (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.body?.days ?? '14'), 10) || 14, 1), 400);
  const confirm = req.body?.confirm === true;
  const source = String(req.body?.source ?? '');
  const calendarId = String(req.body?.calendarId ?? '');
  try {
    const today = new Date();
    const key = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const until = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days - 1);

    const schedule = readScheduleLectures(process.cwd());
    let events: any[] = [];
    let calendarReason: string | null = null;
    try {
      events = ((await calendar.readBest(days)).events ?? []) as any[];
    } catch (err: any) {
      calendarReason = err?.message ?? String(err);
    }
    const gap = findLectureDivergence({
      lectures: schedule.lectures,
      exams: schedule.exams,
      events,
      from: key(today),
      to: key(until),
      scheduleReason: schedule.reason,
      calendarReason,
      gridFaults: schedule.gridFaults,
    });
    if (!gap.compared) {
      res.status(409).json({ ok: false, reason: gap.reason });
      return;
    }

    const shaped = toLectureEvents(
      gap.missing.map((m) => ({
        title: m.title, date: m.date, period: m.period, start: m.scheduled, span: m.span,
      }))
    );

    if (!confirm) {
      res.json({
        ok: true,
        wouldAdd: shaped.events,
        /** 始まりが決まらず入れられないもの。**黙って落とさない。** */
        cannotPlace: shaped.skipped,
        /** 触らないもの。作れても直せないため。 */
        leftAlone: gap.moved,
        note: 'confirm: true を付けるまで書き込みません。',
      });
      return;
    }
    if (source !== 'google' && source !== 'icloud') {
      res.status(400).json({ ok: false, reason: '入れる先の種類（google / icloud）が指定されていません。' });
      return;
    }
    if (!calendarId) {
      res.status(400).json({ ok: false, reason: '入れる先のカレンダーが指定されていません。' });
      return;
    }

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
    const added: any[] = [];
    const failed: any[] = [];
    for (const e of shaped.events) {
      try {
        const made = source === 'google'
          ? await googleCalendar.createEvent({
              calendarId, title: e.title, start: e.start, end: e.end,
              allDay: false, location: null, timeZone,
            })
          : await icloudCalendar.createEvent({
              calendarUrl: calendarId, title: e.title, start: e.start, end: e.end,
              allDay: false, location: null, timeZone,
            });
        added.push({ ...e, id: made.id });
        calendar.forget();
      } catch (err: any) {
        // 途中で止めない。**入った分と入らなかった分を、両方数えて返す。**
        failed.push({ ...e, error: err?.message ?? String(err) });
      }
    }
    activityLog.info('lectures.imported', {
      message: `日程表の授業を ${added.length} 件入れた`,
      detail: { source, calendarId, days, added: added.length, failed: failed.length },
    });
    res.json({ ok: failed.length === 0, added, failed, cannotPlace: shaped.skipped, leftAlone: gap.moved });
  } catch (err) {
    handleError(res, err, 'lectures.import_error');
  }
});

/**
 * 日程表と時刻が食い違う予定を、日程表に合わせる。
 *
 * **作るのとは別の重さ。**足すのは間違えても消せるが、書き換えは元の値が
 * 消える。だから触るのは**時刻だけ**で、題名も場所も送らない（PATCH）。
 *
 * 相手は日付と題名で一件に絞れたものだけ。二件あるときは触らない ——
 * どちらを直すかを機械が選ぶ話ではない。
 *
 * `confirm` が無ければ書かない。返すのは「こう直す」だけ。
 */
app.post('/api/lectures/retime', async (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.body?.days ?? '90'), 10) || 90, 1), 400);
  const confirm = req.body?.confirm === true;
  const calendarId = String(req.body?.calendarId ?? '');
  try {
    const today = new Date();
    const key = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const until = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days - 1);
    const schedule = readScheduleLectures(process.cwd());
    let events: any[] = [];
    let calendarReason: string | null = null;
    try {
      events = ((await calendar.readBest(days)).events ?? []) as any[];
    } catch (err: any) {
      calendarReason = err?.message ?? String(err);
    }
    const gap = findLectureDivergence({
      lectures: schedule.lectures,
      exams: schedule.exams, events, from: key(today), to: key(until),
      scheduleReason: schedule.reason, calendarReason, gridFaults: schedule.gridFaults,
    });
    if (!gap.compared) {
      res.status(409).json({ ok: false, reason: gap.reason });
      return;
    }

    const shaped = toLectureEvents(
      gap.moved.map((m) => ({
        title: m.title, date: m.date, period: m.period, start: m.scheduled, span: m.span,
      }))
    );
    const plan = shaped.events.map((e, i) => ({ ...e, was: gap.moved[i]?.calendar ?? null }));

    if (!confirm) {
      res.json({ ok: true, wouldRetime: plan, note: 'confirm: true を付けるまで書き換えません。' });
      return;
    }
    if (!calendarId) {
      res.status(400).json({ ok: false, reason: '直す先のカレンダーが指定されていません。' });
      return;
    }

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
    const fixed: any[] = [];
    const missed: any[] = [];
    for (const e of plan) {
      try {
        const found = await googleCalendar.findEvent(calendarId, e.start.slice(0, 10), e.title);
        if (!found) {
          // 一件に絞れなかった。**選ばずに残す。**
          missed.push({ ...e, error: '日付と題名で一件に絞れませんでした。' });
          continue;
        }
        await googleCalendar.updateEventTime({
          calendarId, eventId: found.id, start: e.start, end: e.end, timeZone,
        });
        fixed.push({ ...e, id: found.id });
        // 書いたら使い回しを捨てる（直した時刻が古い答えに隠れないため）。
        calendar.forget();
      } catch (err: any) {
        missed.push({ ...e, error: err?.message ?? String(err) });
      }
    }
    activityLog.info('lectures.retimed', {
      message: `日程表に合わせて ${fixed.length} 件の時刻を直した`,
      detail: { calendarId, days, fixed: fixed.length, missed: missed.length },
    });
    res.json({ ok: missed.length === 0, fixed, missed });
  } catch (err) {
    handleError(res, err, 'lectures.retime_error');
  }
});

/**
 * 入れた予定を、id を指定して取り消す。
 *
 * **探して消さない。**探し方の間違いは、そのまま人の予定を消す。取り消せる
 * のは、入れたときに返した id を持っているものだけ。
 *
 * 2026-09-08 に要った: 日程表から77件入れたうち13件が、暦に一日ずれて既に
 * 在るものの二重だった。突き合わせが日ごとで、**日付がずれた予定は「その日に
 * 無い」に見えた。**
 */
/**
 * 日付と題名から予定の id を引く。**一件に絞れたときだけ返す。**
 *
 * 消す前に「何を消すのか」を人が見るための口。二件あるときは `null` で、
 * どちらかを選ばない。
 */
app.post('/api/calendar/events/find', async (req, res) => {
  const calendarId = String(req.body?.calendarId ?? '');
  const items: Array<{ date: string; title: string }> = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!calendarId || !items.length) {
    res.status(400).json({ ok: false, reason: 'calendarId と items が要ります。' });
    return;
  }
  const found: any[] = [];
  for (const it of items) {
    try {
      const hit = await googleCalendar.findEvent(calendarId, String(it.date), String(it.title));
      found.push({ ...it, id: hit?.id ?? null, start: hit?.start ?? null });
    } catch (err: any) {
      found.push({ ...it, id: null, error: err?.message ?? String(err) });
    }
  }
  res.json({ ok: true, found });
});

/**
 * 予定の時刻を、id を指定して直す。
 *
 * `lectures/retime` は日程表との食い違いを直すもので、こちらは**こちらの
 * 出した値が間違っていたとき**に直すためのもの。相手を探さないので、
 * 直す先を取り違えようがない。
 */
app.post('/api/calendar/events/settime', async (req, res) => {
  const calendarId = String(req.body?.calendarId ?? '');
  const items: Array<{ id: string; start: string; end?: string | null }> =
    Array.isArray(req.body?.items) ? req.body.items : [];
  if (!calendarId || !items.length || !req.body?.confirm) {
    res.status(400).json({ ok: false, reason: 'calendarId と items と confirm が要ります。' });
    return;
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
  const done: any[] = [];
  const failed: any[] = [];
  for (const it of items) {
    try {
      await googleCalendar.updateEventTime({
        calendarId, eventId: String(it.id), start: String(it.start),
        end: it.end ? String(it.end) : null, timeZone,
      });
      done.push(it.id);
      calendar.forget();
    } catch (err: any) {
      failed.push({ id: it.id, error: err?.message ?? String(err) });
    }
  }
  res.json({ ok: failed.length === 0, done, failed });
});

app.post('/api/calendar/events/remove', async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const calendarId = String(req.body?.calendarId ?? '');
  const confirm = req.body?.confirm === true;
  if (!calendarId || ids.length === 0) {
    res.status(400).json({ ok: false, reason: 'calendarId と ids が要ります。' });
    return;
  }
  if (!confirm) {
    res.json({ ok: true, wouldRemove: ids.length, note: 'confirm: true を付けるまで消しません。' });
    return;
  }
  const removed: string[] = [];
  const failed: any[] = [];
  for (const id of ids) {
    try {
      await googleCalendar.deleteEvent(calendarId, id);
      // 書いたら使い回しを捨てる。消したものが「まだある」と読まれないため。
      calendar.forget();
      removed.push(id);
    } catch (err: any) {
      failed.push({ id, error: err?.message ?? String(err) });
    }
  }
  activityLog.info('calendar.events_removed', {
    message: `予定を ${removed.length} 件取り消した`,
    detail: { calendarId, removed: removed.length, failed: failed.length },
  });
  res.json({ ok: failed.length === 0, removed, failed });
});

app.get('/api/exam/next', async (_req, res) => {
  if (examCache && Date.now() - examCache.at < 60 * 60_000) {
    res.json(examCache.value);
    return;
  }
  try {
    const reading = await calendar.readBest(180);
    let value = nextExam(reading.events ?? []);

    /**
     * The published schedule, when the calendar has nothing to say.
     *
     * The countdown rested entirely on somebody having typed the exam in. On
     * 2026-08-27 the Google token expired at 02:33 and tomorrow's exam went
     * with it — no error, just an empty line where a countdown had been.
     *
     * Weaker than the calendar on purpose: the PDF carries a version date and
     * things move after it is printed. It answers only where the calendar
     * does not, and says where the answer came from when it does.
     */
    if (!value) {
      const schedule = readScheduleExams(process.cwd());
      /**
       * Days the calendar already has an *exam* on — not days it has anything on.
       *
       * Matching on the date alone was the first attempt and it suppressed
       * tomorrow's exam outright, because the calendar has a shift that
       * evening. "The calendar knows about this" has to mean it knows about an
       * exam, so the same test the countdown itself uses decides it.
       */
      const known = new Set(
        (reading.events ?? [])
          .filter((e: any) => looksLikeExam(String(e.title ?? '')))
          .map((e: any) => String(e.start ?? '').slice(0, 10))
          .filter(Boolean)
      );
      const today = new Date();
      const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const upcoming = schedule.exams
        .filter((e) => !alreadyKnown(e.date, known))
        .filter((e) => Date.parse(`${e.date}T00:00:00`) >= midnight.getTime())
        .sort((a, b) => a.date.localeCompare(b.date));
      const first = upcoming[0];
      if (first) {
        value = {
          title: first.title,
          date: first.date,
          days: Math.round((Date.parse(`${first.date}T00:00:00`) - midnight.getTime()) / 86_400_000),
          after: upcoming.length - 1,
          /** Said out loud: this is the printed schedule, not the calendar. */
          from: `講義日程表 ${first.source}`,
        } as any;
      }
    }

    examCache = { value, at: Date.now() };
    res.json(value);
  } catch (err: any) {
    handleError(res, err, 'exam.error');
  }
});

/**
 * セッションの読みは覚えておく。
 *
 * 転記を何十本も走査するので、**HUD の4秒の待ちに間に合わなくなっていた**
 * — 盤の「進行状況」が空になっていたのはこれ。読めなかった結果が「動いて
 * いるものはありません」として出ていた。**遅いことと、無いことは違う。**
 *
 * 30秒。セッションの状態はそれより速く変わらない。
 */
let sessionsCache: { at: number; hours: number; value: ReturnType<typeof readSessions> } | null = null;

/**
 * 記録の走査は重い。**一つの cache を、読む側全員で使う。**
 *
 * 課題とセッションの紐付け（`/api/fdp/tasks`）が自前で一週間ぶんを走査して、
 * 応答が 120 秒を超えた（実測 2026-09-11）。窓の広さは要らない —— 「いま誰が
 * 進めているか」は、この数時間の話。
 */
/**
 * 走査は別プロセスで。**サーバは凍らない。**
 *
 * 同期の `readSessions` をサーバの中で呼ぶと、記録 499 MB を読むあいだ
 * 十数秒止まる（実測 2026-09-15：何もしない `/api/briefing` が 12.8 秒待った。
 * カレンダーが 31 秒かかり、⌥⌘K のパネルが「読み込み中」から動かなかったのは
 * その後ろに並んでいたから）。`scripts/sessions-scan.ts` を子プロセスで走らせ、
 * 返ってきたら cache を入れ替える。同時には一つだけ。
 */
let sessionsRefresh: Promise<void> | null = null;
function refreshSessions(window: number): Promise<void> {
  if (sessionsRefresh) return sessionsRefresh;
  sessionsRefresh = new Promise<void>((resolve) => {
    const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
    execFile(
      tsx, ['scripts/sessions-scan.ts', os.homedir(), String(window)],
      { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      (err, stdout) => {
        sessionsRefresh = null;
        if (err) {
          activityLog.log({ level: 'warn', event: 'sessions.scan_failed', detail: { message: String(err.message).slice(0, 300) } });
          return resolve();
        }
        try {
          // 読み取りは子に出したが、**結果を解くのはここ。**大きければここで止まる。
          loopWatch.during('sessions.parse', () => {
            sessionsCache = { at: Date.now(), hours: window, value: JSON.parse(stdout) };
          });
        } catch (e: any) {
          activityLog.log({ level: 'warn', event: 'sessions.scan_unreadable', detail: { message: e?.message } });
        }
        resolve();
      }
    );
  });
  return sessionsRefresh;
}

/**
 * いま手元にある一覧。**古ければ即返して、裏で取り直す。**
 *
 * 一度も読めていないときだけ待つ（起動直後の数秒）。それ以外は、30 秒より
 * 古い答えを返してから次を取りに行く —— セッションの状態はその速さでしか
 * 変わらない。
 */
async function cachedSessions(window = 12): Promise<ReturnType<typeof readSessions>> {
  const now = Date.now();
  const have = sessionsCache && sessionsCache.hours === window ? sessionsCache : null;
  if (have && now - have.at < 30_000) return have.value;
  const refresh = refreshSessions(window);
  if (have) { void refresh; return have.value; }
  await refresh;
  return sessionsCache?.value ?? { sessions: [], unreadable: [] } as any;
}

app.get('/api/sessions', async (_req, res) => {
  const hours = Number(_req.query.hours);
  const window = Number.isFinite(hours) && hours > 0 ? hours : 12;
  res.json(await cachedSessions(window));
});

app.post('/api/hud/strip', (req, res) => {
  const height = Number(req.body?.height);
  /**
   * Whether this report is the band appearing, rather than still being there.
   *
   * The band cannot say so itself — it posts the same height every thirty
   * seconds whether it just opened or has been up for an hour — but the
   * server has seen the previous one, and that is enough. A report arriving
   * after nothing, or after a zero, is the band coming back.
   *
   * Ninety seconds because the heartbeat is thirty: two missed reports is a
   * band that went away, one is a slow moment.
   */
  const previous = stripCover;
  const opening = Number.isFinite(height) && height > 0 && (!previous || Date.now() - previous.at > 90_000);
  stripCover = Number.isFinite(height) && height > 0 ? { height, at: Date.now() } : null;
  /**
   * The band's heartbeat doubles as "somebody could be looking".
   *
   * The allowance was refreshed only when the dashboard opened, and the band
   * shows the same figure without ever opening it — so a person who only ever
   * glances at the top of the screen watched a number go stale. Measured at
   * the time it was reported: 69 minutes old.
   *
   * This arrives every thirty seconds while the band is up, and the refresh
   * declines unless the figure is older than the window below, so it costs
   * nothing at all when the band is not running. Presence is the right gate:
   * the band is only on screen because somebody put it there.
   *
   * Thirty minutes, after five turned out to be finer than the thing it reads.
   *
   * Five was asked for directly, and the note written at the time already
   * carried the objection: the seven-day meter "did not move across two
   * consecutive refreshes". The band shows that meter. So every five minutes a
   * Claude Code session was created to fetch a number that had not changed —
   * 238 of them across four days, filling the application's session list.
   *
   * Thirty is chosen against what the figure actually does, not against the
   * cost: a week does not move meaningfully in half an hour, and opening the
   * dashboard still refreshes anything older than an hour, so the number a
   * person looks at is never the stale one. Forty-eight sessions a day instead
   * of two hundred and eighty-eight.
   */
  /**
   * Opening is somebody arriving to look; staying open is not.
   *
   * While the band is up the figure is kept within half an hour, which is
   * finer than the week it shows actually moves. But a band that was closed
   * refreshes nothing at all, so the first thing a person sees on opening it
   * was whatever the number happened to be when they last closed it — five
   * hours and forty minutes old, the day this was written.
   *
   * So the moment it appears is worth a fetch on its own terms, with a much
   * shorter window: what is on screen when somebody looks should be from the
   * last few minutes, and that costs one session per opening rather than one
   * every thirty.
   */
  if (opening) refreshAllowance(os.homedir(), 5);
  else if (stripCover) refreshAllowance(os.homedir(), 30);
  res.json({ ok: true });
});

app.get('/api/hud/strip', (_req, res) => {
  // Two minutes without a word from the band means it is not there.
  const fresh = stripCover && Date.now() - stripCover.at < 120_000;
  res.json({ height: fresh ? stripCover!.height : 0 });
});

/** What was last heard, and what became of it. */
app.get('/api/speech/voice', (_req, res) => {
  res.json({ mode: voice.currentMode(), last: lastVoice, status: speech.status() });
});

/**
 * No longer drains. Kept so an old page does not error, and so nothing can
 * take an utterance away from the loop that answers it.
 *
 * `speech.drain()` empties a queue, and for a while both this endpoint and the
 * server-side loop called it — whichever asked first won. Removing the caller
 * from the source was not enough: a browser that had already loaded the old
 * script kept asking, and it kept winning. Measured on 2026-08-21, twice, with
 * the recogniser producing a perfect transcript and the queue empty by the time
 * the loop looked.
 *
 * A client cannot be relied on to be current, so the endpoint stops being a
 * way to consume. What was heard is at `/api/speech/voice`, which reads.
 */
app.post('/api/speech/drain', (_req, res) => {
  res.json({
    transcripts: [],
    wakeWords: WAKE_WORDS,
    note: '取り出しはサーバ側で行います。聞こえたものは /api/speech/voice を参照してください。',
  });
});

/** The real drain, for the loop only. Not routed. */
function drainForLoop() {
  const drained = speech.drain();
  /*
   * 自分の声を、答える相手から外す。
   *
   * 割り込み判定は**読み上げを止めるか**を決めるだけで、**答えるか**は別だった。
   * 名前を含む文を IRIS 自身が読み上げると、マイクが拾い、名前があるので
   * 「呼ばれた」ことになり、IRIS が自分に答える —— **マイクが自分から模型に
   * 話しかける輪**で、作らないと決めてある配置そのもの。文ごとに喋るように
   * したぶん、声に出す回数が増えて起きやすくなった。
   *
   * 鳴っている間に聞こえたもの全部を捨てはしない。それをやると**割り込みが
   * 死ぬ** —— 被せて話しかけたのに無視される。読み上げている文に似ているか
   * だけを見る（`own_voice.ts`）。
   */
  const speaking = tts.currentUtterance();
  const kept: Array<{ text: string; at: string; addressed: boolean; request: string }> = [];
  for (const t of (drained.transcripts ?? []) as Array<{ text: string; at: string }>) {
    const heardAt = Date.parse(t.at);
    const verdict = isOwnVoice(t.text, speaking ?? null, Number.isFinite(heardAt) ? heardAt : Date.now());
    if (verdict.own) {
      activityLog.log({
        level: 'info',
        event: 'voice.own_voice_ignored',
        message: '自分の読み上げを聞き取ったので、答えませんでした。',
        detail: { heard: t.text.slice(0, 60) },
      });
      continue;
    }
    const wake = detectWakeWord(t.text);
    kept.push({
      text: t.text,
      at: t.at,
      addressed: wake.addressed,
      // The utterance with the name removed, so the request reads as a
      // request rather than as a greeting.
      request: wake.addressed ? wake.request : t.text,
    });
  }
  return { transcripts: kept };
}

function req_locale(req: any): string {
  const value = req?.body?.locale ?? req?.query?.locale;
  return typeof value === 'string' && value.trim() ? value.trim() : process.env.IRIS_SPEECH_LOCALE || 'ja-JP';
}

/**
 * The built client, when there is one.
 *
 * A resident IRIS should be one process, not a dev server plus a bundler. If
 * `npm run build` has not been run the API still works and this simply is not
 * mounted — during development Vite serves the client on its own port.
 */
const CLIENT_DIST = path.join(REPO_ROOT, 'dist');
if (fsExistsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  // Anything not an API route is the single-page app's to route.
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

/**
 * How each model has actually performed.
 *
 * Read from records already kept, and deliberately unwilling to rank on thin
 * evidence: a scoreboard that puts two attempts beside forty will be believed.
 */
const telemetry = new TelemetryService(db);

/**
 * Where the money is, right now.
 *
 * Meant to be on screen continuously rather than checked: a limit nobody sees
 * is a limit discovered after it mattered.
 */
app.get('/api/budget', (_req, res) => {
  res.json(budget.state());
});

/**
 * What the coding assistants on this machine have used.
 *
 * Kept apart from /api/budget on purpose. That one is money IRIS spent through
 * its own keys and can price exactly; this is how much of a flat-rate
 * allowance is gone. A percentage and a dollar figure in the same place invite
 * being read as the same kind of number.
 */
/**
 * The token, readable only from this machine.
 *
 * Handing it out over loopback is not a hole: reaching loopback already means
 * being on the computer, where the file itself is readable anyway. It exists
 * so the token can be copied onto a phone without anyone having to find a path
 * in Application Support, which is the difference between a feature being used
 * and being explained.
 *
 * The check is repeated here rather than relying on the gate above, because
 * this is the one route where "remote requests carry the token" would be
 * circular — a device that had the token would be asking for the token.
 */
app.get('/api/access/token', (req, res) => {
  if (!isLoopback(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'この端末からのみ取得できます。', code: 'not_local' });
  }
  res.json({ token: accessToken.token, source: accessToken.source, path: accessToken.path });
});

/**
 * Asks Claude Code to report its allowance, when it is worth asking.
 *
 * Costs about two cents and six seconds, so it is called by the dashboard
 * when it opens and by nothing else. An idle machine pays nothing to keep a
 * number fresh that nobody is reading.
 */
app.get('/api/usage/refresh', (_req, res) => {
  res.json(allowanceRefreshState());
});

app.post('/api/usage/refresh', (req, res) => {
  const stale = Number(req.body?.staleMinutes);
  res.json(refreshAllowance(os.homedir(), Number.isFinite(stale) && stale >= 0 ? stale : 60));
});

/**
 * What would be lost if this machine died right now.
 *
 * Reported rather than assumed working. A backup that has stopped writes
 * nothing, and nothing reads exactly like success.
 */
app.get('/api/backup/repo', async (_req, res) => {
  // 記憶ではなく、記憶と git の reflog を突き合わせたもの。再起動で
  // 「一度も押していない」に見えていた（`repoBackupReading` を参照）。
  res.json(await repoBackupReading(process.cwd()));
});

app.post('/api/backup/repo', async (_req, res) => {
  res.json(await backUpRepository(process.cwd()));
});

app.get('/api/usage/cli', (_req, res) => {
  try {
    /**
     * The Claude allowance joins the token counts rather than replacing them.
     *
     * They answer different questions and neither substitutes for the other:
     * the tokens are how much work was done and are computed here from the
     * transcripts, the percentage is how much of the week is left and can
     * only be relayed. When the status line has not run there is no
     * percentage and the tokens are still true.
     */
    res.json({ ...cliUsage.read(), claudeLimits: readClaudeUsage(os.homedir()), agy: agyUsage.read() });
  } catch (err: any) {
    handleError(res, err, 'cli_usage.error');
  }
});

/**
 * いま取り直す。
 *
 * The two file-backed meters are swept every five minutes, and a cold sweep
 * takes seconds — which is right for something a panel polls, and wrong for
 * the moment a person looks at the rail and wants to know what it says *now*.
 * So the wait is offered explicitly rather than paid for on every poll.
 *
 * Clearing before sweeping matters: a refresh that returns the cached answer
 * is a button that does nothing while looking like it did something.
 */
app.post('/api/usage/cli/refresh', async (_req, res) => {
  try {
    /*
     * 掃き直しは別プロセスに出たので、**押した人だけは待つ。**待たないと、
     * この口は古い答えを返して「押しても何も変わらない」ボタンになる ——
     * 上のコメントがそう決めている。他の口（`read()`）は待たない。
     */
    cliUsage.invalidate();
    await refreshCliUsage();
    /**
     * Claude の割合は、走らせてみないと分からない。
     *
     * ファイルを読み直しても、そのファイルを書くのは Claude Code の
     * ステータス行だけ。**押しても Claude だけ変わらない**のは、読み直しの
     * 失敗ではなく、読み直す先が古いから。だから頼まれたら一回走らせる。
     * `0` は「何分古くても取り直す」。
     */
    refreshAllowance(os.homedir(), 0);
    /**
     * Codex も一往復させる。
     *
     * Codex は**動いたときにしか枠を書かない。**開いていても turn が無ければ
     * 記録は増えず、窓が入れ替わったあとは「読めない」のまま。走らせれば
     * 事実が作れる — ただし**枠を少し使う**ので、窓がまだ生きているときは
     * 走らせない（判断は `needsProbe` の側）。
     */
    refreshCodexAllowance(cliUsage.read().codex);
    await agyUsage.refresh();
    res.json({ ...cliUsage.read(), claudeLimits: readClaudeUsage(os.homedir()), agy: agyUsage.read() });
  } catch (err: any) {
    handleError(res, err, 'cli_usage.refresh.error');
  }
});

/**
 * Raises or lowers a limit for this process only.
 *
 * Deliberately not persisted — a limit raised to get one task done should not
 * quietly outlive it. The durable setting is .env.
 */
app.post('/api/budget/limits', (req, res) => {
  const patch: Record<string, number> = {};
  for (const key of ['perRunUsd', 'dailyUsd', 'monthlyUsd', 'warnAt']) {
    if (typeof req.body?.[key] === 'number') patch[key] = req.body[key];
  }
  const before = budget.getLimits();
  const after = budget.setLimits(patch);
  activityLog.warn('budget.limits_changed', {
    message: JSON.stringify(patch),
    detail: { before, after, persisted: false },
  });
  res.json({ limits: after, persisted: false, note: '.env に書かない限り再起動で戻ります。' });
});

/**
 * Search across every conversation.
 *
 * A tool and an endpoint, never an injection into each prompt — the handoff
 * rules out sending whole conversations to the model on every turn by name.
 */
/**
 * What external surface has been taken on, and at what risk level.
 *
 * Worth being able to read: every one of these tools was named, described and
 * schema'd by someone else, and the risk level was assigned from this side.
 */
/**
 * One thing per area, rather than everything known.
 *
 * Ported from the FDP dashboard, whose design rule is the point: a list of
 * forty items and a list of five are different products. Read-only — the
 * spreadsheet and the OS repository are canon and this only reads them.
 */
const fdpSheets = process.env.IRIS_FDP_SHEET_ID
  ? new FdpSheets(process.env.IRIS_FDP_SHEET_ID)
  : null;

const focus = fdpSheets
  ? new DailyFocusService({
      sheets: fdpSheets,
      osActiveProjectsPath:
        process.env.IRIS_OS_ACTIVE_PROJECTS ??
        path.join(
          process.env.HOME ?? '',
          'Documents/Codex/2026-07-27/med-ai-builder-lab-repository-manager',
          'MED-AI Builder Lab/00_OS/Active_Projects.md'
        ),
    })
  : null;

/**
 * 今日の一件は、要求のたびに組み直さない。
 *
 * `build()` はシートへ六本の問い合わせを並べる。**待ち時間はほぼ全部が網**で、
 * 実測 2026-09-28 で `GET /api/focus` が 4.8〜6.1秒。盤と画面の両方が繰り返し
 * 聞くので、そのたびに六本出していた。
 *
 * 「今日どれをやるか」は分の単位で変わらないので、60 秒は古くてよい。古さを
 * 隠さないために、返す側に `date` が入っている（`build()` が付ける）。
 */
let focusHeld: FreshEnough<any> | null = null;
function focusCache(): FreshEnough<any> {
  if (!focusHeld) focusHeld = new FreshEnough<any>(60_000, () => focus!.build());
  return focusHeld;
}

/**
 * The ledger itself, beside the one thing chosen from it.
 *
 * Two readers of one sheet rather than two sources: the web panel and the
 * native board both call this, so a task cannot be "更新停止" in one place and
 * "順調" in the other.
 */
const fdpHolds = new FdpHoldStore(db);
const fdpLedger = new FdpLedgerStore(db);

/**
 * The sheet is downstream now, and still has readers.
 *
 * The daily digest, two iPhone calendar subscriptions and today.py all read the
 * spreadsheet and do not know the ledger moved. A store that stopped being
 * updated does not announce itself — it serves last week's answer every
 * morning — so writes are mirrored across until those readers move.
 */
const fdpSheetWriter =
  process.env.IRIS_FDP_WEBAPP_URL && process.env.IRIS_FDP_WEBAPP_SECRET
    ? new FdpSheetWriter(process.env.IRIS_FDP_WEBAPP_URL, process.env.IRIS_FDP_WEBAPP_SECRET)
    : null;

const fdpTasks = fdpSheets ? new FdpTasksService(fdpSheets, fdpHolds, fdpLedger) : null;

app.get('/api/focus', async (_req, res) => {
  if (!focus) {
    res.status(503).json({
      error: 'IRIS_FDP_SHEET_ID が設定されていません。',
      hint: 'FDP のスプレッドシートIDを .env に設定してください。',
    });
    return;
  }
  try {
    const result = await focusCache().get();
    /**
     * 今日、いまから先に残っている時間。
     *
     * 独立したレビュー（astra、2026-09-08）の指摘 ——「分野別に一件ずつ
     * 選ぶだけで、合計が今日に収まるかを判断しない」。**一件あたり何分か
     * かるかは、どこにも書かれていない**（シートに所要時間の列が無い）ので、
     * 埋めない。代わりに**入れ物の側**を言う ——「2時間の枠が一つと、
     * 1時間が二つ」まで分かれば、どれを今日に置くかは本人が決められる。
     *
     * 空きが出せない日（源が欠けている）は、ここも数を出さない。同じ理由で
     * 止まる —— しかもこちらは「いま手を付けられる」という顔で出るぶん、
     * 黙って間違える余地が大きい。
     */
    let room: any = null;
    try {
      const today = new Date();
      const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const reading = await calendar.readBest(1);
      const events = (reading.events ?? []) as any[];
      const day = freeForDay(key, sliceByDay(events, [key]).get(key) ?? []);
      const left = roomLeftToday(day, today);
      room = { ...left, summary: describeRoom(left) };
    } catch (err: any) {
      // 読めなかったことは、数の代わりに言う。**黙って 0 にしない。**
      const left = roomLeftToday(null, new Date(), { blocked: `今日の予定を読めませんでした（${err?.message ?? err}）。` });
      room = { ...left, summary: describeRoom(left) };
    }
    // The calendar is the sixth area and comes from a different source, so it
    // is attached rather than folded in — a reader should be able to see
    // which ones came from the sheet.
    let calendarItem: any = null;
    try {
      const reading = await calendar.readBest(14);
      const next = upcomingEvents(reading.events)[0];
      if (next) {
        calendarItem = {
          area: 'calendar',
          label: '予定',
          title: next.title,
          due: next.start,
          detail: next.calendar,
          available: true,
          stale: 'stale' in reading ? reading.stale : false,
          source: reading.source,
          // A cache that is old because its writer keeps failing is a
          // different problem from one that is merely old, and waiting fixes
          // only the second.
          ...((reading as any).lastError ? { syncFailing: (reading as any).lastError } : {}),
          ...(((reading as any).contributions ?? []).some((c: any) => c.lastError)
            ? {
                syncFailing: ((reading as any).contributions ?? []).find((c: any) => c.lastError)
                  .lastError,
              }
            : {}),
          // A live source that quietly stopped being live is the failure
          // this whole ordering exists to prevent, and the daily focus is
          // where it would actually be noticed.
          ...(reading.fellBackFrom?.length
            ? { degraded: reading.fellBackFrom.map((f) => ({ from: f.from, code: f.code, hint: f.hint })) }
            : {}),
        };
      }
    } catch (err: any) {
      calendarItem = { area: 'calendar', label: '予定', title: null, available: false, error: err?.message };
    }
    res.json({ ...result, room, items: [...(calendarItem ? [calendarItem] : []), ...result.items] });
  } catch (err) {
    handleError(res, err, 'focus.error');
  }
});

/**
 * Every open task in the ledger, and how many are finished.
 *
 * `/api/focus` answers "what now"; this answers "what has stopped". A 200 with
 * `ok: false` rather than a 5xx, because the caller is a panel: it has to draw
 * something, and what it must draw is that the sheet could not be read — not
 * an empty list, which reads as "nothing to do".
 */
app.get('/api/fdp/tasks', async (_req, res) => {
  if (!fdpTasks) {
    res.json({
      ok: false,
      error: 'IRIS_FDP_SHEET_ID が設定されていません。',
      readAt: new Date().toISOString(),
    });
    return;
  }
  try {
    const reading: any = await fdpTasks.read();
    if (reading.ok) {
      // どこで進めるか。実在する道だけ。無いものは null のまま出す。
      // 誰が進めているか。作業場所の中に cwd を持つセッション。
      const live = (await cachedSessions(12)).sessions;
      reading.tasks = reading.tasks.map((t: any) => {
        const workplace = workplaceOf(t);
        const sessions = sessionsFor(workplace, live as any).slice(0, 3).map((s) => ({
          id: s.id, name: s.name, live: s.live, resume: s.resume, kind: s.kind, lastAt: s.lastAt, doingNow: s.doingNow ?? null, scope: s.scope,
        }));
        return { ...t, workplace, sessions };
      });
    }
    res.json(reading);
  } catch (err: any) {
    res.json({
      ok: false,
      error: err?.message ?? String(err),
      readAt: new Date().toISOString(),
    });
  }
});

/**
 * 課題の作業場所の根。
 *
 * 一つ目は台帳の資料入れそのもの。二つ目は T011 の台帳（GCI の論点表）が
 * 置かれている Codex の作業場所で、**課題の正本は一つでも、成果物の置き場は
 * 一つではない。**環境変数で足せる。
 */
const FDP_WORK_ROOTS = (
  process.env.IRIS_FDP_WORK_ROOTS ||
  // 二つ目は親まで。台帳の文は `medrecall/docs/…` と親からの相対で書かれている。
  `${os.homedir()}/Documents/Founder-Development-Program,${os.homedir()}/Documents/Codex/2026-07-28`
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 作業場所を Finder で開く。
 *
 * web の画面からは Finder を開けない（ブラウザの外なので）。サーバはこの
 * 機械で動いているので開ける。**開くのは、さっき `findWorkplace` が実在を
 * 確かめた道だけ** —— 画面から任意の道を受け取って開く口にはしない。
 */
/**
 * その課題のセッションを前に出す。
 *
 * `claude://code/continue?session=<id>` を `open` に渡す。実測 2026-09-11：
 * Claude.app が `claude` スキームを登録していて、これで前に出た。**そのセッション
 * に正確に着地するかは端末からは確かめられない**ので、応答にはそう書く。
 * Codex にはスキームが無い。無いものは開けないと言う。
 */
app.post('/api/fdp/tasks/:id/session', async (req, res) => {
  if (!fdpTasks) return res.status(503).json({ error: 'IRIS_FDP_SHEET_ID が設定されていません。' });
  const id = String(req.params.id ?? '').trim();
  const wanted = typeof req.body?.session === 'string' ? req.body.session : null;
  const reading: any = await fdpTasks.read().catch(() => null);
  const task = reading?.ok ? reading.tasks.find((t: any) => t.id === id) : null;
  if (!task) return res.status(404).json({ error: `${id} という課題はありません。` });
  const place = findWorkplace(task, FDP_WORK_ROOTS);
  const live = (await cachedSessions(12)).sessions;
  const candidates = sessionsFor(place, live as any);
  const session = wanted ? candidates.find((s) => s.id === wanted || s.resume === wanted) : candidates[0];
  if (!session) return res.status(404).json({ error: `${id} を進めているセッションはありません。`, code: 'no_session' });
  if (session.kind !== 'claude') {
    return res.status(409).json({ error: 'Codex のセッションは外から前に出せません（URL スキームがありません）。', code: 'no_scheme' });
  }
  const { execFile } = await import('node:child_process');
  execFile('/usr/bin/open', [`claude://code/continue?session=${encodeURIComponent(session.resume)}`], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    activityLog.log({ level: 'info', event: 'fdp.session_raised', detail: { id, session: session.id } });
    res.json({ ok: true, session: { id: session.id, name: session.name, live: session.live }, note: 'Claude を前に出しました。該当のセッションに着地したかは画面で確かめてください。' });
  });
});

app.post('/api/fdp/tasks/:id/open', async (req, res) => {
  if (!fdpTasks) return res.status(503).json({ error: 'IRIS_FDP_SHEET_ID が設定されていません。' });
  const id = String(req.params.id ?? '').trim();
  const reading: any = await fdpTasks.read().catch(() => null);
  const task = reading?.ok ? reading.tasks.find((t: any) => t.id === id) : null;
  if (!task) return res.status(404).json({ error: `${id} という課題はありません。` });
  const place = findWorkplace(task, FDP_WORK_ROOTS);
  if (!place) return res.status(404).json({ error: `${id} の作業場所は決まっていません。`, code: 'no_workplace' });
  const { execFile } = await import('node:child_process');
  // ファイルなら Finder で場所を示す（-R）、資料入れなら開く。
  const args = place.kind === 'file' ? ['-R', place.path] : [place.path];
  execFile('/usr/bin/open', args, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    activityLog.log({ level: 'info', event: 'fdp.workplace_opened', detail: { id, path: place.path } });
    res.json({ ok: true, opened: place });
  });
});

/**
 * Park a task until a date, or let it go again.
 *
 * The date is required and the actor is required. A hold with no end does not
 * expire, which is the failure it exists to prevent; an unattributed hold
 * cannot be traced back when three sessions are writing to the same ledger.
 *
 * The reason is optional and shown when present. It is worth having and is not
 * worth relying on — a reason does not stop being true, so it cannot be what
 * makes a pause temporary.
 */
app.post('/api/fdp/tasks/:id/hold', (req, res) => {
  const taskId = String(req.params.id ?? '').trim();
  const { heldUntil, reason, setBy } = req.body ?? {};
  if (!taskId) return res.status(400).json({ error: '課題IDが必要です。' });
  try {
    const hold = fdpHolds.hold(
      taskId,
      String(heldUntil ?? ''),
      reason == null ? null : String(reason),
      String(setBy ?? '').trim() || 'unknown'
    );
    res.json({ ok: true, hold });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Bring the ledger in from the spreadsheet.
 *
 * Refuses to run twice without `force`. Import overwrites, so running it after
 * IRIS has become the writer would silently undo whatever IRIS wrote — the
 * sheet would win a fight it is no longer in.
 */
app.post('/api/fdp/import', async (req, res) => {
  if (!fdpSheets) return res.status(503).json({ error: 'IRIS_FDP_SHEET_ID が設定されていません。' });
  const force = req.body?.force === true;
  const existing = fdpLedger.count();
  if (existing > 0 && !force) {
    return res.status(409).json({
      error: `台帳には既に ${existing} 件あります。取り込みは上書きなので、IRIS 側の変更が消えます。`,
      hint: '本当に入れ直すなら force: true を付けてください。',
      existing,
    });
  }
  const result = await fdpSheets.fetchTab('課題台帳', '課題名');
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ ok: true, ...fdpLedger.importFromSheet(result.rows), total: fdpLedger.count() });
});

/**
 * Change one field of one task.
 *
 * The write lands in the store first and is mirrored to the sheet afterwards.
 * That order is the whole answer to "which one is right": the store is, always,
 * and a mirror that failed makes the sheet stale rather than making the ledger
 * wrong. The failure is recorded and counted, never retried silently.
 */
/**
 * 課題の一欄を書き、Sheet に鏡写しする。画面の PATCH と見張りの両方が通る道。
 *
 * 日付の印は store が書いたものをそのまま使う。ここで別に時計を読むと、
 * Sheet と台帳が「最後に動いた日」で食い違い、更新停止の判定がずれる。
 */
async function writeFdpField(id: string, field: string, value: string | number | null | undefined, writtenBy: string) {
  const write = fdpLedger.update(id, field, value ?? null, writtenBy.trim() || 'unknown');
  let mirror: any = { attempted: false };
  if (fdpSheetWriter) {
    const result = await fdpSheetWriter.update(id, {
      [write.sheetColumn]: write.newValue,
      最終更新日: fdpLedger.get(id)?.lastUpdated ?? null,
    });
    fdpLedger.recordMirror(write.rowId, result.ok, result.error);
    mirror = { attempted: true, ...result };
  } else {
    fdpLedger.recordMirror(write.rowId, false, 'IRIS_FDP_WEBAPP_URL が未設定');
  }
  return { write, mirror };
}

app.patch('/api/fdp/tasks/:id', async (req, res) => {
  const id = String(req.params.id ?? '').trim();
  const { field, value, writtenBy } = req.body ?? {};
  try {
    res.json({ ok: true, ...(await writeFdpField(id, String(field ?? ''), value, String(writtenBy ?? ''))) });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? String(err) });
  }
});

/** Every recorded change to one task, newest first. */
app.get('/api/fdp/tasks/:id/history', (req, res) => {
  res.json({ history: fdpLedger.history(String(req.params.id ?? '').trim()) });
});

app.delete('/api/fdp/tasks/:id/hold', (req, res) => {
  const taskId = String(req.params.id ?? '').trim();
  const releasedBy = String((req.body ?? {}).releasedBy ?? '').trim() || 'unknown';
  const released = fdpHolds.release(taskId, releasedBy);
  res.json({ ok: true, released });
});

app.get('/api/calendar', async (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '14'), 10) || 14, 1), 365);
  // `?sources=live` excludes the local cache. It exists for whatever writes
  // that cache: reading it in order to produce the thing that replaces it
  // would preserve every stale event forever, each sync copying it forward
  // while the file went on looking freshly written.
  const excludeCache = String(req.query.sources ?? '') === 'live';
  try {
    res.json(await calendar.readBest(days, { excludeCache }));
  } catch (err: any) {
    if (err instanceof CalendarUnavailableError) {
      res.status(503).json({
        error: err.message,
        code: err.code,
        hint: err.hint,
        // Every source that was tried, so a 503 says what was attempted
        // rather than only what was raised.
        tried: (err as any).fellBackFrom ?? [],
      });
      return;
    }
    handleError(res, err, 'calendar.error');
  }
});

/**
 * Starts a consent flow and hands back the URL to visit.
 *
 * IRIS does not open it. A resident service that could put a consent screen in
 * front of someone unprompted would be a worse thing to run than one that
 * cannot, so the URL is returned and a person decides.
 */
app.post('/api/mcp/oauth/start', async (req, res) => {
  const serverId = String(req.body?.server ?? '');
  const provider = providerFor(serverId);
  if (!provider) {
    res.status(400).json({
      error: 'GOOGLE_CLIENT_ID が設定されていないか、サーバ名が不正です。',
      hint: 'Google Cloud で OAuth クライアント（ウェブアプリケーション）を作成してください。',
    });
    return;
  }

  const config = mcpConfigs.find((c) => c.id === serverId);
  if (!config) {
    res.status(404).json({ error: `未設定の MCP サーバです: ${serverId}`, configured: mcpConfigs.map((c) => c.id) });
    return;
  }

  try {
    // A previous attempt that was never completed must not lend its state to
    // this one.
    provider.beginNewFlow();

    const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
    // The scope is passed explicitly, and this is not optional.
    //
    // Left out, the SDK uses whatever the server advertises it supports —
    // which for Google's calendar server is twelve scopes including full
    // read-write `.../auth/calendar` and `.../auth/calendar.acls`. Consenting
    // to that would hand over the ability to create, delete and reshare
    // events, in a flow whose entire stated purpose was reading. The server
    // is not being hostile; it is describing its capabilities, and taking a
    // capability list as a request is the mistake.
    const scope = (GOOGLE_MCP_SCOPES[serverId] ?? []).join(' ');
    if (!scope) {
      res.status(400).json({
        error: `${serverId} に対する要求スコープが定義されていません。`,
        hint: 'GOOGLE_MCP_SCOPES に読み取り専用スコープを定義してください。',
      });
      return;
    }

    /*
     * いま持っている許可が、いま要る許可を覆っているか。
     *
     * `auth` は**手形があるかどうか**しか見ない。だから読み取りだけの手形が
     * 残っていると `AUTHORIZED` を返して同意画面へ行かず、**書き込みは
     * 403 で落ちる。**実際に落ちた（2026-09-08、授業77件の書き込みが
     * `insufficient authentication scopes` で全滅。一件も入らなかったのは
     * 幸い）。
     *
     * 「許可はあるか」と「いま要るものを覆っているか」は別の問いで、
     * **前者に答えて後者を答えた気になっていた。**足りなければ、手形が
     * あっても同意を取り直す。
     */
    const held = (provider.tokens()?.scope ?? '').split(/\s+/).filter(Boolean);
    const short = (GOOGLE_MCP_SCOPES[serverId] ?? []).filter((s) => !held.includes(s));
    if (short.length && held.length) {
      provider.beginNewFlow();
      /*
       * 手形を捨ててから始める。**残したままでは同意画面が出ない。**
       *
       * 残す方が安全に見えて、実際には流れが始まらない —— `auth` は手形の
       * 有無しか見ないので、`AUTHORIZED` を返して終わる。それでは足りない
       * ままで、書き込みは 403 で落ち続ける。
       *
       * 代わりに失うものを言う: **同意を終えるまで、カレンダーの読み取りも
       * 止まる。**途中でやめた場合は、もう一度ここを叩けば同じ画面に戻る。
       */
      provider.invalidateCredentials('tokens');
    }

    // Returns 'REDIRECT' once it has decided a consent screen is needed; the
    // provider captured the URL on the way past.
    const outcome = await auth(provider as any, { serverUrl: config.url, scope });
    const url = provider.takeAuthorizationUrl();
    if (!url) {
      res.json({
        status: outcome,
        alreadyAuthorized: outcome === 'AUTHORIZED',
        /*
         * 足りない許可は、名前を挙げる。**「認可し直してください」だけでは、
         * 何が足りないのか分からない。**
         */
        ...(short.length
          ? {
              missingScopes: short,
              hint:
                'いまの許可では足りないので、取り直します。' +
                '**同意を終えるまでカレンダーの読み取りも止まります。**' +
                '途中でやめたら、もう一度ここを叩けば同じ画面に戻ります。',
            }
          : {}),
      });
      return;
    }
    res.json({
      status: outcome,
      authorizationUrl: url.toString(),
      redirectUri: OAUTH_REDIRECT,
      note:
        'このURLをブラウザで開いて許可してください。' +
        `リダイレクトURI「${OAUTH_REDIRECT}」が OAuth クライアントに登録されている必要があります。`,
    });
  } catch (err) {
    handleError(res, err, 'oauth.start_failed');
  }
});

/**
 * Where Google sends the user back.
 *
 * A callback whose state this server did not issue is rejected outright. An
 * unsolicited callback is either a bug or an attack, and neither should be
 * answered with a token exchange.
 */
app.get('/api/mcp/oauth/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  if (req.query.error) {
    res.status(400).send(`認可が拒否されました: ${String(req.query.error)}`);
    return;
  }
  if (!code || !state) {
    res.status(400).send('code と state が必要です。');
    return;
  }

  const flow = oauthStore.claimFlow(state);
  if (!flow) {
    activityLog.warn('oauth.unknown_state', { message: 'このサーバが発行していない state です。' });
    res.status(400).send('この認可要求は当サーバが発行したものではないか、期限切れです。');
    return;
  }

  /**
   * Plain Google services come back here too.
   *
   * One registered redirect URI serves both flows; which one this is comes
   * from the service recorded with the state, not from the path. The flow has
   * already been claimed above, so the exchange is handed the claimed row —
   * claiming twice would find nothing the second time.
   */
  if (GOOGLE_SERVICE_SCOPES[flow.serverId]) {
    try {
      const result = await googleOAuth.completeWithFlow(flow, code);
      // 認可が通ったことを、次の巡回（六時間後）まで知らないままにしない。
      grantHealth.invalidate(flow.serverId);
      void refreshGrantHealth();
      res.send(
        `${result.service} の認可が完了しました。` +
          (result.hasRefreshToken ? '' : '（更新トークンが返っていません。1時間で切れます。）') +
          'このタブは閉じて構いません。'
      );
    } catch (err: any) {
      activityLog.error('google_oauth.exchange_failed', { detail: { message: err?.message } });
      res.status(500).send(`トークン交換に失敗しました: ${err?.message ?? err}`);
    }
    return;
  }

  const provider = providerFor(flow.serverId);
  const config = mcpConfigs.find((c) => c.id === flow.serverId);
  if (!provider || !config) {
    res.status(400).send('対応する MCP サーバの設定が見つかりません。');
    return;
  }

  /**
   * The verifier comes back from the flow, not from memory.
   *
   * The store has persisted it since the authorization URL was built, and
   * until now nothing read it back — the exchange asked the provider, which
   * answers from an in-process field. Anything that clears that field between
   * the consent screen and the callback therefore broke the exchange: a
   * restart, or the SDK's own `invalidateCredentials('all')`.
   *
   * The second one is what actually bit, and it hid the cause. `auth()`
   * invalidates and retries once when an exchange fails, so a real error
   * (2026-08-20: whatever Google objected to) came back as "PKCE verifier が
   * ありません" — a message about the retry, describing nothing about why the
   * first attempt failed. Restoring the verifier means the retry runs with the
   * same one the challenge was built from, and the error that surfaces is the
   * original.
   */
  if (flow.codeVerifier) provider.saveCodeVerifier(flow.codeVerifier);

  try {
    const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
    await auth(provider as any, {
      serverUrl: config.url,
      authorizationCode: code,
      // Same list as the request, so the exchange cannot quietly widen it.
      scope: (GOOGLE_MCP_SCOPES[flow.serverId] ?? []).join(' '),
    });
    // The token is now in the store. It is never echoed here — the browser
    // that completed the flow has no reason to see it.
    activityLog.warn('oauth.completed', { message: flow.serverId });
    grantHealth.invalidate(flow.serverId);
    void refreshGrantHealth();
    res.send(`${flow.serverId} の認可が完了しました。このタブは閉じて構いません。`);
  } catch (err: any) {
    activityLog.error('oauth.exchange_failed', { message: err?.message ?? String(err) });
    res.status(500).send(`トークン交換に失敗しました: ${err?.message ?? err}`);
  }
});

/**
 * Whether a credential exists, and until when. Never the credential.
 *
 * Not even a prefix of it: a "safe" fragment of a bearer token is still part
 * of a bearer token.
 */
app.get('/api/mcp/oauth', (_req, res) => {
  res.json({
    redirectUri: OAUTH_REDIRECT,
    tokens: oauthStore.allStatuses(),
    openFlows: oauthStore.openFlowCount(),
    scopes: GOOGLE_MCP_SCOPES,
    note: 'トークンそのものは返しません。読み取り専用スコープのみを要求します。',
  });
});

app.delete('/api/mcp/oauth/:server', (req, res) => {
  const revoked = oauthStore.revoke(req.params.server);
  activityLog.warn('oauth.revoked', { message: req.params.server, detail: { revoked } });
  res.json({ revoked });
});

app.get('/api/mcp', (_req, res) => {
  res.json({
    servers: mcp.inventory(),
    note:
      'すべて UNTRUSTED として登録されます。分類できなかったツールは READ にせず承認必須にします — ' +
      'READ は自動実行されるため、「判断できなかった」を「安全」と同じ扱いにしてはいけません。',
  });
});

app.get('/api/search', (req, res) => {
  const query = String(req.query.q ?? '');
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const role = req.query.role === 'user' || req.query.role === 'assistant' ? req.query.role : undefined;
  res.json(searchService.search(query, { limit, role, conversationId: req.query.conversationId as string }));
});

app.get('/api/search/stats', (_req, res) => {
  res.json(searchService.stats());
});

/** Rebuilds the index. Triggers keep it in step, so this is the escape hatch. */
app.post('/api/search/reindex', (_req, res) => {
  const result = searchService.reindex();
  activityLog.warn('search.reindexed', { detail: result });
  res.json(result);
});

app.get('/api/telemetry/models', (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '30'), 10) || 30, 1), 365);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  res.json({ days, ...telemetry.summary({ sinceIso }) });
});

app.get('/api/telemetry/compare', (req, res) => {
  const a = String(req.query.a ?? '');
  const b = String(req.query.b ?? '');
  if (!a || !b) {
    res.status(400).json({ error: 'a と b の両方を指定してください。' });
    return;
  }
  res.json(telemetry.compare(a, b, req.query.role ? String(req.query.role) : undefined));
});

/**
 * どの列が誰に頼んでいるか、そして選べる相手。
 *
 * `chosen` が `null` は「選んでいない（既定のまま）」で、`serving` が実際に
 * 先頭に立っている相手。**二つを別に返す**のは、選んでいないことと、選んだ
 * 結果それが先頭になっていることが、画面で同じに見えてはいけないから。
 */
function laneView(lane: 'voice' | 'text') {
  const order = laneOrder(lane);
  return {
    chosen: preferences.get(`lane.${lane}`),
    serving: order[0] ?? null,
    order,
    /*
     * その列の健康状態。**入力バーの chip はこれを読む。**
     *
     * chip は前から「一番目」ではなく「最初に**使える**もの」を出していた
     * —— 枠切れの日に嘘を書かないため。列ごとに router が分かれたので、
     * 既定の router の健康状態を読んでいると**会話の相手と違うものが出る**
     * （実測 2026-09-11、chip が「Gemini」、中身が「いま anthropic」）。
     */
    providers: laneRouter(lane)?.health() ?? [],
    options: Object.keys(providers).map((id) => ({ id, model: providers[id].currentModel })),
  };
}

/**
 * 出し先を選ぶ。
 *
 * 知らない名前は拒む。**綴りを間違えたまま「保存しました」と言うと、変えた
 * つもりで変わっていない状態になる** —— この機械がいちばん嫌う形。
 */
app.post('/api/settings/lanes', (req, res) => {
  const { lane, provider } = req.body ?? {};
  if (lane !== 'voice' && lane !== 'text') {
    return res.status(400).json({ error: 'lane は voice か text です。', code: 'invalid_lane' });
  }
  if (provider === null || provider === '') {
    preferences.clear(`lane.${lane}`);
    laneRouters.clear();
    return res.json({ lane, ...laneView(lane), note: '既定に戻しました。' });
  }
  if (typeof provider !== 'string' || !providers[provider]) {
    return res.status(400).json({
      error: `${provider} という出し先はありません。`,
      code: 'unknown_provider',
      known: Object.keys(providers),
    });
  }
  preferences.set(`lane.${lane}`, provider);
  laneRouters.clear();
  activityLog.log({ level: 'info', event: 'settings.lane_changed', detail: { lane, provider } });
  res.json({ lane, ...laneView(lane) });
});

/**
 * 購読できる IRIS の暦。
 *
 * 「iris専用のカレンダーが欲しい。まとめて見れるやつ」（利用者、2026-09-15）。
 * Mac／iPhone のカレンダーに「IRIS」という一つの暦として並ぶ。中身は
 * **IRIS の台帳にあって、どの暦にも配られていないもの**だけ：課題の期限、
 * 保留の終わり、未着手の開始予定日。試験とコンテストは Apps Script の配信が
 * 既にあり、授業は Google にあるので、ここでは出さない —— 同じものを二つの
 * 暦に出すと、消したときにどちらが本物か分からなくなる。
 *
 * 読み専用。書き戻しは無い。token は一度作って preferences に置く。
 * 127.0.0.1 なので外からは届かないが、この機械の他のプロセスには届く。
 */
function icsToken(): string {
  const key = 'ics.token';
  let t = preferences.get(key);
  if (!t) { t = randomBytes(16).toString('hex'); preferences.set(key, t); }
  return t;
}

app.get('/api/calendar/iris.ics', async (req, res) => {
  if (String(req.query.token ?? '') !== icsToken()) {
    return res.status(403).type('text/plain').send('token が違います。');
  }
  const events: IcsEvent[] = [];
  const reading: any = fdpTasks ? await fdpTasks.read().catch(() => null) : null;
  for (const t of reading?.ok ? reading.tasks : []) {
    const short = String(t.title ?? '').replace(/[（(].*$/, '').slice(0, 28);
    if (t.due && /^\d{4}\/\d{2}\/\d{2}$/.test(t.due)) {
      events.push({
        uid: `fdp-${t.id}-due`, start: t.due.replace(/\//g, '-'), transparent: true,
        summary: `期限 ${t.id} ${short}`,
        description: [t.nextAction ? `次: ${t.nextAction}` : null, t.status ? `状態: ${t.status}` : null].filter(Boolean).join('\n'),
      });
    }
    if (t.heldUntil) {
      events.push({ uid: `fdp-${t.id}-hold`, start: t.heldUntil, transparent: true,
        summary: `保留おわり ${t.id} ${short}`, description: t.holdReason ? `理由: ${t.holdReason}` : undefined });
    }
    if (t.status === '未着手' && t.start && /^\d{4}\/\d{2}\/\d{2}$/.test(t.start) && (t.startsInDays ?? -1) > 0) {
      events.push({ uid: `fdp-${t.id}-start`, start: t.start.replace(/\//g, '-'), transparent: true,
        summary: `開始 ${t.id} ${short}` });
    }
  }
  res.type('text/calendar; charset=utf-8').send(buildIcs('IRIS', events));
});

/** 購読 URL を一度だけ見る口。token を含むので、画面の設定からだけ出す。 */
app.get('/api/calendar/iris.ics/url', (_req, res) => {
  res.json({ webcal: `webcal://127.0.0.1:${CONFIG.port}/api/calendar/iris.ics?token=${icsToken()}`,
             http: `http://127.0.0.1:${CONFIG.port}/api/calendar/iris.ics?token=${icsToken()}` });
});

app.get('/api/settings', (_req, res) => {
  res.json({
    lanes: { voice: laneView('voice'), text: laneView('text') },
    activeProvider: activeProvider ? activeProvider.id : 'none',
    activeModel: activeProvider ? activeProvider.currentModel : 'none',
    availableProviders: Object.keys(providers).map((k) => ({ id: k, name: providers[k].name, currentModel: providers[k].currentModel })),
    routing: router ? { order: router.keys(), providers: router.health() } : null,
    registeredTools: defaultToolRegistry.describe(),
    workspaceRoot: defaultWorkspace.root,
    schemaVersion: getSchemaVersion(db),
    limits: {
      providerTimeoutMs: CONFIG.providerTimeoutMs,
      providerAttempts: CONFIG.providerAttempts,
      toolTimeoutMs: CONFIG.toolTimeoutMs,
      runDeadlineMs: CONFIG.runDeadlineMs,
      maxToolLoops: CONFIG.maxToolLoops,
    },
  });
});

const PORT = CONFIG.port;
/**
 * The offline copy, kept current for readers that cannot open a socket.
 *
 * Started here rather than beside the other timers, and that is not tidiness:
 * the payload names the port, `PORT` is declared further down this file, and
 * calling it earlier threw `Cannot access 'PORT' before initialization` into
 * the activity log — where it sat, correctly reported and unread, while the
 * endpoint kept answering and the file kept being the copy somebody had
 * written by hand. The failure was visible; nobody was looking. Anything that
 * needs the port belongs after the port exists.
 */
/**
 * Sweeps away the transcripts IRIS wrote by asking itself a question.
 *
 * The refresh can only work by making a real session run, so every one leaves
 * a transcript in the application's own list — 238 across four days before the
 * interval was lengthened. Fewer is not none, and a pile that only grows is
 * one that eventually gets cleared in a hurry with a wildcard.
 *
 * A day of them is kept. Nothing needs them, but a sweep that reaches the last
 * hour would be racing whatever is still writing, and the cost of waiting is
 * a few dozen files.
 *
 * Daily, and once at startup. Failures are logged rather than thrown: a file
 * that could not be deleted is next to a hundred that could.
 */
function sweepProbes(): void {
  const result = sweepProbeTranscripts(os.homedir(), new Set([PROBE_PROMPT, '1', 'IRIS usage probe']));
  if (result.removed > 0) {
    activityLog.info('probe.swept', {
      message: `使用量計測の転記を ${result.removed} 件片付けました。`,
      detail: { removed: result.removed, bytes: result.bytes },
    });
  }
  for (const failure of result.failures) {
    activityLog.warn('probe.sweep_failed', { message: failure.reason, detail: { path: failure.path } });
  }
}

const probeSweepTimer = setInterval(() => loopWatch.during('probes.sweep', () => sweepProbes()), 24 * 60 * 60_000);
probeSweepTimer.unref();

/**
 * 先回りの規則を、定期的に present に当てる。
 *
 * **誰も呼んでいなかった。**`evaluate()` の口は `POST /api/proactive/evaluate`
 * だけで、叩く側が無い。規則が保存されない（別に直した）のと合わせて、
 * これが「提案イベント0件」のもう半分 —— 399行の試験が守っている仕組みが、
 * **一度も動かされずに置いてあった。**
 *
 * 二分ごと。規則の側に `cooldownMs` があるので、当てる回数を増やしても
 * 同じ提案が積み上がることはない。**間隔で黙らせるのではなく、規則が
 * 自分で黙る。**
 *
 * 規則が一つも無ければ何もしない。空回りを記録に残しても、読む人には
 * 「動いている」と「言うことが無い」の区別が付かない。
 */
/**
 * 見張りの四つを、context へ流す。
 *
 * 規則が読めるのは context に入ったものだけ。**IRIS はどれも既に知っていて、
 * 誰にも渡していなかった。**
 *
 * 読めなかったものは**観測しない。**「0件」を書くと、読めていない状態が
 * 「異状なし」として規則に届く —— この機械がいちばん避けている形。
 */
/**
 * 見張りが転んだことを言う。
 *
 * 最初は `catch {}` で黙らせていた。**それでは「言うことが無い」と「見に
 * 行けなかった」が同じ顔になる** —— この機械が名前の由来にしている失敗を、
 * それを直すための仕組みの中でやるところだった。
 *
 * 観測は足さない。**読めなかったことは、読めた値の代わりにならない。**
 */
function missed(kind: string, err: any): void {
  activityLog.log({
    level: 'warn',
    event: 'watch.failed',
    detail: { kind, message: err?.message ?? String(err) },
  });
}

async function watch(): Promise<void> {
  const at = new Date().toISOString();

  // ── 委任が終わった ──────────────────────────────
  try {
    const since = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    const ended = delegatedRuns.since(since).filter((r) => r.state === 'stopped');
    if (ended.length) {
      const last = ended[ended.length - 1];
      context.observe({
        source: 'iris.watch',
        kind: 'delegation.finished',
        value: { id: last.id, agent: last.agent, model: last.model, reason: last.stopReason },
        confidence: 1,
        evidence: `${last.agent} が ${last.stopReason} で終了`,
        observedAt: last.endedAt ?? at,
      });
    }
  } catch (err: any) { missed('delegation.finished', err); }

  // ── 認可が消えた ────────────────────────────────
  try {
    const dead = lastGrantHealth.filter((g) => g.liveness === 'dead');
    // `unknown` は数に入れない。**測れなかったのと、切れているのは別。**
    if (dead.length) {
      context.observe({
        source: 'iris.watch',
        kind: 'grant.dead',
        value: dead.length,
        confidence: 1,
        evidence: dead.map((g) => g.service).join('・'),
        observedAt: at,
      });
    }
  } catch (err: any) { missed('grant.dead', err); }

  // ── 新しい日程表 ─────────────────────────────────
  /*
   * `.iris/schedule/` に `講義日程_<版>.pdf` が置かれて、対応する
   * `exams-<版>.json` が無ければ、抽出して年度全体を比べる。
   *
   * 2026-09-12 に分かったこと：6月19日版が来たとき、暦は 6月より前の日程の
   * まま残っていて（67件）、それが三か月気づかれなかった。**改訂は暦を
   * 自動では追いかけない。**だから版が上がった瞬間に、入れ替える**前に**
   * 食い違いを出す。入れ替えるかどうかは人が決める —— ここでは比べるだけ。
   *
   * 抽出は `scripts/extract-schedule.py`（同期、数秒）。失敗したら理由を
   * 残して次回また試す —— 壊れた JSON を置かない。
   */
  try {
    const dir = path.join(process.cwd(), '.iris', 'schedule');
    const names: string[] = fsExistsSync(dir) ? fsReaddirSync(dir) : [];
    for (const pdf of names.filter((f) => /^講義日程_.+\.pdf$/.test(f))) {
      const stamp = pdf.replace(/^講義日程_/, '').replace(/\.pdf$/, '');
      const json = path.join(dir, `exams-${stamp}.json`);
      if (fsExistsSync(json)) continue;
      const year = Number(stamp.split('.')[0]) || new Date().getFullYear();
      const grade = process.env.IRIS_SCHEDULE_GRADE || 'M2';
      try {
        execFileSync('python3', ['scripts/extract-schedule.py', path.join(dir, pdf), json, String(year), grade], {
          cwd: process.cwd(), stdio: 'pipe', timeout: 120_000,
        });
      } catch (err: any) {
        activityLog.log({ level: 'warn', event: 'lectures.extract_failed', detail: { pdf, message: String(err?.stderr ?? err?.message ?? err).slice(0, 400) } });
        continue;
      }
      activityLog.log({ level: 'info', event: 'lectures.new_version', detail: { pdf, json: path.basename(json) } });
      // 今日から年度末まで比べる。60日の窓では冬の食い違いが秋まで見えない。
      // 過ぎた授業は入れ替えの対象ではないので数えない（数えると 4〜8月の
      // 未取り込みが「欠け156」として立って、本当の食い違いが埋もれる）。
      const schedule = readScheduleLectures(process.cwd());
      const events = ((await calendar.readBest(400)).events ?? []) as any[];
      const dates = schedule.lectures.map((l) => l.date).sort();
      const gap = findLectureDivergence({
        lectures: schedule.lectures,
        exams: schedule.exams, events,
        from: at.slice(0, 10), to: dates[dates.length - 1] ?? at.slice(0, 10),
        scheduleReason: schedule.reason, calendarReason: null, gridFaults: schedule.gridFaults,
      });
      const evidence = gap.compared
        ? `${stamp} 版：欠け${gap.missing.length}・時刻違い${gap.moved.length}・日ずれ${gap.shifted.length}・余分${gap.surplus.length}（今日から年度末）`
        : `${stamp} 版：比べられませんでした（${gap.reason}）`;
      context.observe({ source: 'iris.watch', kind: 'lectures.new_version', value: stamp, confidence: 1, evidence, observedAt: at });
    }
  } catch (err: any) { missed('lectures.new_version', err); }

  // ── 日程表との食い違い ──────────────────────────
  try {
    const schedule = readScheduleLectures(process.cwd());
    const events = ((await calendar.readBest(60)).events ?? []) as any[];
    const today = new Date();
    const key = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const until = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 59);
    const gap = findLectureDivergence({
      lectures: schedule.lectures,
      exams: schedule.exams, events, from: key(today), to: key(until),
      scheduleReason: schedule.reason, calendarReason: null, gridFaults: schedule.gridFaults,
    });
    // 比べられなかったときは観測しない。**比べていないことを「0件」にしない。**
    if (gap.compared) {
      const total = gap.missing.length + gap.moved.length + gap.shifted.length + gap.surplus.length;
      if (total > 0) {
        /*
         * 試験は数で言わない。**題名と日付で言う。**
         *
         * 「欠け1」では何が欠けているか分からない。授業の欠けは一度に七十件
         * 出ることがあるので数えるしかないが、**試験は年に二十件ほどで、
         * 一件の重みが違う。**2026-09-16 に「欠け0」と報告した裏で
         * 病理学Ⅱ各論試験が暦に無かったのは検査の穴だったが、仮に数えられて
         * いても「欠け1」では動けなかった。
         */
        const exams = [
          ...gap.missing.filter((g) => g.kind === 'exam').map((g) => `${g.date} ${g.title.replace(/[\s　]+/g, '')}（暦に無い${g.scheduled ? `／紙は${g.scheduled}` : ''}）`),
          ...gap.moved.filter((g) => g.kind === 'exam').map((g) => `${g.date} ${g.title.replace(/[\s　]+/g, '')}（紙${g.scheduled}／暦${g.calendar}）`),
          ...gap.shifted.filter((g) => g.kind === 'exam').map((g) => `${g.title.replace(/[\s　]+/g, '')}（紙${g.date}／暦${g.calendar}）`),
          ...gap.surplus.filter((g) => g.kind === 'exam').map((g) => `${g.date} ${g.title.replace(/[\s　]+/g, '')}（紙に無い）`),
        ];
        const counts = `欠け${gap.missing.length}・時刻違い${gap.moved.length}・日ずれ${gap.shifted.length}・余分${gap.surplus.length}`;
        context.observe({
          source: 'iris.watch',
          kind: 'lectures.divergent',
          value: total,
          confidence: 1,
          evidence: exams.length ? `${counts}。試験: ${exams.join('、')}` : counts,
          observedAt: at,
        });
      }
    }
  } catch (err: any) { missed('lectures.divergent', err); }

  // ── 論点表から進捗率 ────────────────────────────
  /*
   * 作業場所が `*-progress-ledger.csv` の課題は、表の「確認済み ÷ 論点数」を
   * 進捗率にする。復習で表を直せば台帳が追いかける（「T011 の進捗を CSV から
   * 自動で」— 利用者、2026-09-15）。逆向きは無い：台帳を直しても表は変わらない。
   *
   * 書くのは値が変わったときだけ。読めなければ書かない —— 表が壊れている日に
   * 0% を書くのは、進捗を消すのと同じ。
   */
  try {
    const reading: any = fdpTasks ? await fdpTasks.read() : null;
    for (const t of reading?.ok ? reading.tasks : []) {
      const place = findWorkplace(t, FDP_WORK_ROOTS);
      if (!place) continue;
      // 資料入れなら、その中の論点表（一つだけ）。ファイルならそれ自身。
      let ledgerPath: string | null = null;
      if (place.kind === 'file') ledgerPath = /-progress-ledger\.csv$/.test(place.path) ? place.path : null;
      else {
        const names = fsReaddirSync(place.path).filter((n: string) => /-progress-ledger\.csv$/.test(n));
        ledgerPath = names.length === 1 ? path.join(place.path, names[0]) : null;
      }
      if (!ledgerPath) continue;
      let ledger;
      try { ledger = readGciLedger(ledgerPath); }
      catch (err: any) { activityLog.log({ level: 'warn', event: 'fdp.ledger_unreadable', detail: { id: t.id, path: ledgerPath, message: err?.message } }); continue; }
      if (ledger.progress === null) continue;
      const current = typeof t.progress === 'number' ? Math.round(t.progress * 100) / 100 : null;
      if (current === ledger.progress) continue;
      const { mirror } = await writeFdpField(t.id, 'progress', ledger.progress, 'iris.watch');
      activityLog.log({
        level: 'info', event: 'fdp.progress_from_ledger',
        detail: { id: t.id, from: current, to: ledger.progress, confirmed: ledger.confirmed, topics: ledger.topics, mirrored: mirror.ok ?? false },
      });
    }
  } catch (err: any) { missed('fdp.progress_from_ledger', err); }

  // ── 期限が迫っている、または過ぎている ──────────────
  /*
   * 条件は `dueInDays === 1` だった。**前日に一度だけ言って、そのあとは何も
   * 言わない。**今日が期限（0日）も、過ぎた期限（負）も、条件から外れる。
   *
   * 実測 2026-09-30: T005 は当日、T011 は 13 日超過で、どちらも一度も鳴って
   * いなかった。台帳は同じものを見て `期限間近`・`遅延` と判定しているのに、
   * **その判定を誰も読んでいなかった。**
   *
   * だから日数を数え直さず、台帳の判定をそのまま条件にする。閾値は設定タブに
   * あり、**二箇所で別々に決めない。**
   */
  try {
    const reading = fdpTasks ? await fdpTasks.read() : null;
    const tasks: any[] = (reading as any)?.tasks ?? [];
    const pressing = pressingTasks(tasks);
    if (pressing.length) {
      /*
       * 件数ではなく、名前と残り日数で言う。**「1件」では動けない** ——
       * 試験の食い違いで同じことを学んだ。
       */
      const named = pressing.slice(0, 5).map(describePressing);
      context.observe({
        source: 'iris.watch',
        kind: 'deadline.pressing',
        value: named,
        confidence: 1,
        evidence: named.join('、'),
        observedAt: at,
      });
    }
  } catch (err: any) { missed('deadline.pressing', err); }
}

/**
 * 声をかける四つ（利用者が選んだ、2026-09-09）。
 *
 * どれも**見ていないと気づけないもの。**次の予定も週の枠も試験までの日数も
 * レールに出ているので、規則にしない —— 出ているものを言い直すのは提案では
 * なく反復。
 *
 * 起動のたびに入れ直す。`addRule` は同じ id を上書きするので、文言を直したら
 * 次の起動で直る。**利用者が黙らせたものは `enabled = 0` で戻ってこない**
 * （保存の側が旗を守る）。
 */
const WATCH_RULES: Array<Parameters<typeof proactive.addRule>[0]> = [
  {
    id: 'watch.delegation-finished',
    description: '委任した実行が終わったことを伝える',
    conditions: [{ kind: 'delegation.finished', minConfidence: 0.9 }],
    // 画面を見ていなければ、終わったことを知る方法が他に無い。
    suggestion: '委任した実行が終わっています。成果を見ますか。',
    cooldownMs: 25 * 60_000,
  },
  {
    id: 'watch.grant-dead',
    description: '認可が切れていることを、次に使う前に伝える',
    conditions: [{ kind: 'grant.dead', minConfidence: 0.9 }],
    /*
     * 切れたことは、**次に使おうとしたときにしか分からない。**2026-09-08 に
     * Google の書き込みでそれを踏んだ —— 77件が全部 403 で落ちてから
     * 気づいた。
     */
    suggestion: '切れている認可があります。使う前に取り直しますか。',
    cooldownMs: 12 * 60 * 60_000,
  },
  {
    id: 'watch.lectures-new-version',
    description: '講義日程表の新しい版を取り込んだら、入れ替える前に食い違いを伝える',
    conditions: [{ kind: 'lectures.new_version', minConfidence: 0.9 }],
    suggestion: '講義日程表の新しい版を取り込みました。カレンダーと比べた結果を見ますか。',
    cooldownMs: 3 * 24 * 60 * 60_000,
  },
  {
    id: 'watch.lectures-divergent',
    description: '講義日程表とカレンダーの食い違いを伝える',
    conditions: [{ kind: 'lectures.divergent', minConfidence: 0.9 }],
    // 日程表の版が上がったときに効く。人の記憶に頼らないための規則。
    // 試験が絡む食い違いは `evidence` に題名と日付で入る（数だけでは動けない）。
    suggestion: '講義日程表とカレンダーが食い違っています。見ますか。',
    cooldownMs: 24 * 60 * 60_000,
  },
  {
    id: 'watch.deadline-pressing',
    description: '期限が迫っている、または過ぎている課題を伝える',
    conditions: [{ kind: 'deadline.pressing', minConfidence: 0.9 }],
    /*
     * 前の版は「明日が期限」だけを見ていたので、**逃すと二度と言わなかった。**
     * 過ぎた期限は翌日も過ぎたままなので、静まるのは片付いたときだけ。
     */
    suggestion: '期限が迫っている、または過ぎている課題があります。',
    // 半日。**毎回言うと読み飛ばされ、一度きりだと逃す。**
    cooldownMs: 12 * 60 * 60_000,
  },
];

/*
 * 置き換えた規則は**消さずに無効にする。**置き場のコメントが理由を書いている
 * ——「消すと、なぜ在ったかも消える」。`deadline.tomorrow` はもう観測されない
 * ので、有効なままでも鳴らないが、**鳴らない規則が有効の顔で並んでいる**のは
 * 別の嘘になる。
 */
try {
  proactiveRules.setEnabled('watch.deadline-tomorrow', false);
} catch { /* 無かったなら何もしない */ }

for (const rule of WATCH_RULES) {
  try {
    proactiveRules.save(proactive.addRule(rule));
  } catch (err: any) {
    activityLog.log({
      level: 'warn', event: 'proactive.rule_rejected_on_boot',
      detail: { id: (rule as any).id, message: err?.message ?? String(err) },
    });
  }
}

const watchTimer = setInterval(() => { void loopWatch.around('watch', () => watch()); }, 10 * 60_000);
watchTimer.unref?.();
setTimeout(() => { void loopWatch.around('watch.boot', () => watch()); }, 20_000);

const proactiveTimer = setInterval(() => loopWatch.during('proactive.evaluate', () => {
  try {
    if (proactive.listRules().length === 0) return;
    proactive.evaluate();
  } catch (err: any) {
    activityLog.log({
      level: 'warn', event: 'proactive.evaluate_failed',
      detail: { message: err?.message ?? String(err) },
    });
  }
}), 2 * 60_000);
proactiveTimer.unref?.();

const briefingTimer = setInterval(() => loopWatch.during('briefing.write', () => writeBriefingFile()), 5 * 60_000);
briefingTimer.unref();

const server = app.listen(PORT, () => {
  loopWatch.during('briefing.write.boot', () => writeBriefingFile());
  loopWatch.during('probes.sweep.boot', () => sweepProbes());
  /*
   * セッションの cache を温めておく。
   *
   * 走査は同期で 11 秒かかる（実測 2026-09-11）。起動直後の最初の読み手
   * —— 課題の欄でも盤でも —— がそれを払うと、画面が「読み取り中…」のまま
   * 十数秒止まる。起動が済んで 3 秒後に一度走らせて、以降は 30 秒の cache と
   * `staleOk` に乗る。走らせている間は他の応答も止まるが、起動直後の 3 秒後
   * なら誰も待っていない。
   */
  setTimeout(() => { void loopWatch.around('sessions.warmup', () => cachedSessions(12)); }, 3000).unref?.();
  /*
   * 高いものは先に温めておく。**最初に聞いた人が待つ役にならないように。**
   *
   * 実測 2026-09-28、温める前の一回目: 内訳 8.71秒・今日の一件 4.77秒・
   * 暦 3.41秒。二回目からは 0.02〜0.04秒。待つ人がいなくなったわけではなく、
   * **待つ役が起動直後のここに移った**だけ —— そこには誰も並んでいない。
   */
  const warmed = (what: string) => (err: any) =>
    // 温めの失敗は作業を止めないが、**黙って落ちるのは別の話。**
    activityLog.log({ level: 'warn', event: 'warmup.failed', detail: { what, message: err?.message ?? String(err) } });
  setTimeout(() => {
    void loopWatch.around('breakdown.warmup', () =>
      sessionUsage(7).get().then(() => undefined).catch(warmed('allowance.breakdown'))
    );
  }, 5000).unref?.();
  setTimeout(() => {
    if (!focus) return;
    void loopWatch.around('focus.warmup', () =>
      focusCache().get().then(() => undefined).catch(warmed('focus'))
    );
  }, 7000).unref?.();
  /*
   * 暦は日数ごとに別の答えなので、**実際に聞かれる日数**を温める。
   * 呼び出し側が使っているのは 1・2・14・60・180・400（grep で数えた）。
   * 400 は日程表の突き合わせだけが使い、重いので温めない —— 押した人が待つ。
   */
  setTimeout(() => {
    void loopWatch.around('calendar.warmup', async () => {
      for (const days of [2, 14, 60]) {
        try { await calendar.readBest(days); } catch { /* 温めの失敗は失敗ではない */ }
      }
    });
  }, 9000).unref?.();
  setTimeout(() => {
    if (!fdpTasks) return;
    // 課題の一覧も温める。設定タブを網越しに取るのが 5.2 秒だった。
    void loopWatch.around('fdp.warmup', () => fdpTasks!.read().then(() => undefined).catch(() => undefined));
  }, 11_000).unref?.();
  console.log(`🤖 IRIS Core Server running on http://localhost:${PORT}`);
  console.log(`   schema v${getSchemaVersion(db)} | db ${dbPath}`);
  console.log(`   workspace ${defaultWorkspace.root}`);
  console.log(`   tools ${defaultToolRegistry.getAll().length} registered`);
  console.log(
    `   review ${review.canReview()
      ? review.availableReviewers().map(({ provider }) => provider.currentModel).join(', ') + ' で独立レビュー可能'
      : '独立レビュー不可（実装モデル以外が未設定）'}`
  );
  console.log(
    `   register ${Object.values(register.counts()).reduce((a, b) => a + b, 0)} entries ` +
      `(seed +${seedResult.inserted} ~${seedResult.updated})`
  );
  /**
   * Started here rather than at import, so a module load never touches the
   * network. The first push happens immediately: the interesting case is a
   * machine that has just been turned back on with yesterday's work on it.
   */
  startRepoBackup(process.cwd());

  /**
   * Snapshots, on two different clocks.
   *
   * The allowance is cheap to read — it is already in a file the status line
   * refreshes — so it is sampled every twenty minutes and a week's shape
   * survives. The project breakdown reads several hundred transcripts and
   * takes tens of seconds, so it runs once every six hours; its window is a
   * rolling seven days and nothing inside that window is lost by sampling it
   * four times a day.
   *
   * Both fire immediately at startup, because a machine that has just been
   * turned on is the case where the last sample is oldest.
   */
  const snapshotAllowance = () => {
    const claude = readClaudeUsage(os.homedir());
    const codex = cliUsage.read()?.codex ?? null;
    history.recordAllowance([
      {
        vendor: 'claude',
        weekPercent: claude.week?.usedPercent ?? null,
        sessionPercent: claude.session?.usedPercent ?? null,
        weekResetsAt: claude.week?.resetsAtMs ? new Date(claude.week.resetsAtMs).toISOString() : null,
      },
      {
        vendor: 'codex',
        weekPercent: codex?.usedPercent ?? null,
        sessionPercent: null,
        weekResetsAt: codex?.resetsAtMs ? new Date(codex.resetsAtMs).toISOString() : null,
      },
    ]);
  };

  /*
   * 同じ走査を二人が別々にやらない。**内訳の口と同じ手元の答えを使う。**
   * 6時間ごとの記録のために 4.7 GB を読み直すと、その間サーバが止まる。
   */
  const snapshotProjects = async () => {
    try {
      const read = await sessionUsage(7).get();
      history.recordProjects(
        7,
        read.projects.map((p) => ({
          project: p.project,
          weightedUsd: p.weightedUsd,
          outputTokens: p.outputTokens,
          cacheReadTokens: p.cacheReadTokens,
          messages: p.messages,
        }))
      );
    } catch (err: any) {
      activityLog.warn('allowance.snapshot_failed', { detail: { message: err?.message } });
    }
  };

  /**
   * Not immediately.
   *
   * The first snapshot at startup recorded Codex as null and Claude as 90 —
   * the Codex reading comes from scanning rollout files and is not ready the
   * instant the server binds a port. A hole in the series is meant to say
   * "the meter was not answering", and a hole that only ever means "the
   * process had just started" teaches the series to be ignored.
   */
  setTimeout(snapshotAllowance, 30_000);
  setTimeout(snapshotProjects, 45_000);
  setInterval(() => loopWatch.during('allowance.snapshot', () => snapshotAllowance()), 20 * 60_000).unref?.();
  setInterval(() => void loopWatch.around('projects.snapshot', () => snapshotProjects()), 6 * 60 * 60_000).unref?.();
});

// Close the database cleanly so WAL is checkpointed on shutdown.
function shutdown(signal: string) {
  console.log(`\n[iris] ${signal} received, shutting down.`);
  // A microphone left open by a process that has exited is the worst way for
  // this to fail, so it is closed before anything else.
  void speech.stop();
  tts.stop();
  void mcp.close();
  server.close(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
