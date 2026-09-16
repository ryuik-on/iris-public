import Database from 'better-sqlite3';

/**
 * Single owner of database connection setup and schema migrations.
 *
 * Design notes (Reliable State):
 * - `foreign_keys` is OFF by default in SQLite. The pre-existing schema declared
 *   FOREIGN KEY ... ON DELETE CASCADE but the pragma was never enabled, so the
 *   constraint was decorative. It is now enabled on every connection.
 * - `journal_mode = WAL` is persistent (stored in the DB file) and survives an
 *   abrupt process kill far better than the default rollback journal.
 * - Schema version is tracked with `PRAGMA user_version`, which is transactional
 *   and lives in the DB header, so it survives file copies and backups.
 */

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline: approvals, conversations, conversation_messages',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_approvals (
          approval_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          args_json TEXT NOT NULL,
          risk_level TEXT NOT NULL,
          history_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_approvals(session_id);

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation
          ON conversation_messages(conversation_id, created_at);
      `);
    },
  },
  {
    version: 2,
    name: 'link pending approvals to their originating conversation',
    up(db) {
      // Nullable so pre-existing rows migrate cleanly. SQLite permits adding a
      // REFERENCES column via ALTER TABLE only when its default is NULL.
      if (!columnExists(db, 'pending_approvals', 'conversation_id')) {
        db.exec(`
          ALTER TABLE pending_approvals
          ADD COLUMN conversation_id TEXT
            REFERENCES conversations(id) ON DELETE CASCADE;
        `);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pending_conversation
          ON pending_approvals(conversation_id, status);
        CREATE INDEX IF NOT EXISTS idx_pending_status
          ON pending_approvals(status, created_at);
      `);
    },
  },
  {
    version: 3,
    name: 'activity logs (system/tool/error events kept out of semantic history)',
    up(db) {
      // Deliberately NO foreign key on conversation_id: audit records must
      // outlive the conversation they describe. Deleting a conversation removes
      // its messages and approvals, but never its audit trail.
      db.exec(`
        CREATE TABLE IF NOT EXISTS activity_logs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          session_id TEXT,
          level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
          event TEXT NOT NULL,
          message TEXT,
          detail_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activity_logs_created
          ON activity_logs(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_activity_logs_conversation
          ON activity_logs(conversation_id, created_at DESC);
      `);
    },
  },
  {
    version: 4,
    name: 'monotonic activity sequence for deterministic recency ordering',
    up(db) {
      // ISO-8601 timestamps tie at millisecond resolution, and the rowid
      // tiebreaker then ranks by creation order rather than by activity, so
      // "most recently active" could resolve to the wrong thread whenever two
      // operations landed in the same millisecond. A monotonic counter makes
      // the ordering total and tie-free. updated_at is retained for display.
      if (!columnExists(db, 'conversations', 'updated_seq')) {
        db.exec(`ALTER TABLE conversations ADD COLUMN updated_seq INTEGER NOT NULL DEFAULT 0;`);
        // Seed existing rows from their current order so history is preserved.
        db.exec(`
          UPDATE conversations
             SET updated_seq = (
               SELECT COUNT(*) FROM conversations c2
                WHERE c2.updated_at < conversations.updated_at
                   OR (c2.updated_at = conversations.updated_at AND c2.rowid <= conversations.rowid)
             );
        `);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conversations_updated_seq
          ON conversations(updated_seq DESC);
      `);
    },
  },
  {
    version: 5,
    name: 'development tasks, agent runs and captured results',
    up(db) {
      // conversation_id has no foreign key: a development task is longer-lived
      // than the conversation that happened to spawn it, and must survive that
      // conversation being deleted.
      db.exec(`
        CREATE TABLE IF NOT EXISTS development_tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          success_criteria_json TEXT NOT NULL,
          scope TEXT,
          non_goals_json TEXT,
          constraints_json TEXT,
          decisions_json TEXT,
          relevant_files_json TEXT,
          status TEXT NOT NULL CHECK(status IN
            ('planned','in_progress','blocked','review','done','abandoned')),
          conversation_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dev_tasks_status
          ON development_tasks(status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES development_tasks(id) ON DELETE CASCADE,
          agent TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('implement','review','research','verify')),
          status TEXT NOT NULL CHECK(status IN
            ('pending','running','blocked','succeeded','failed','cancelled')),
          handoff_json TEXT NOT NULL,
          progress_json TEXT,
          blocked_reason TEXT,
          last_heartbeat_at TEXT,
          last_progress_at TEXT,
          started_at TEXT,
          ended_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_runs_task
          ON agent_runs(task_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_status
          ON agent_runs(status, last_heartbeat_at);

        CREATE TABLE IF NOT EXISTS agent_results (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
          outcome TEXT NOT NULL CHECK(outcome IN ('success','partial','failure')),
          summary TEXT NOT NULL,
          detail_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_results_run
          ON agent_results(run_id, created_at DESC);
      `);
    },
  },
  {
    version: 6,
    name: 'future feature register (intent, verification and repository reality)',
    up(db) {
      // Three deliberately separate axes (§28/§29): what we intend to do, how
      // far it has been verified, and whether it actually exists in the repo.
      // Collapsing them is exactly the confusion the handoff warns against —
      // "reported implemented" is not "present", and "present" is not "works
      // in real life".
      db.exec(`
        CREATE TABLE IF NOT EXISTS future_features (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          domain TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'CURRENT','NEXT','PLANNED','DEFERRED','EXPERIMENTAL',
            'REAL_WORLD_VERIFICATION_REQUIRED','BLOCKED','PROHIBITED',
            'OUT_OF_SCOPE','EXPLICIT_DECISION_REQUIRED','REJECTED','COMPLETED'
          )),
          verification TEXT NOT NULL CHECK(verification IN (
            'NONE','DESIGNED','IMPLEMENTED','UNIT_VERIFIED','FIXTURE_VERIFIED',
            'RUNTIME_VERIFIED','REAL_WORLD_VERIFIED','PILOT_VALIDATED'
          )),
          reality TEXT NOT NULL CHECK(reality IN (
            'VERIFIED_PRESENT','PARTIAL','REPORTED_BUT_NOT_FOUND','NOT_IMPLEMENTED'
          )),
          priority TEXT NOT NULL CHECK(priority IN ('P0','P1','P2','P3','P4','NONE')),
          reason TEXT NOT NULL,
          resume_condition TEXT,
          dependencies_json TEXT,
          evidence_json TEXT,
          source TEXT NOT NULL,
          risk TEXT,
          notes TEXT,
          last_reviewed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_future_features_status
          ON future_features(status, priority);
        CREATE INDEX IF NOT EXISTS idx_future_features_domain
          ON future_features(domain, status);
        CREATE INDEX IF NOT EXISTS idx_future_features_review
          ON future_features(last_reviewed_at);
      `);
    },
  },
  {
    version: 7,
    name: 'topics and their association with conversations',
    up(db) {
      // A topic is deliberately not a conversation attribute: it exists across
      // threads, which is the whole point. "Which thread did I say that in?"
      // is the question this table set exists to stop the user from having to
      // answer (decision 8.3).
      db.exec(`
        CREATE TABLE IF NOT EXISTS topics (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          description TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('project','subject','person','place','other')),
          status TEXT NOT NULL CHECK(status IN ('active','paused','done','archived')),
          /* Alternate names used to recognise the topic in text. */
          aliases_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_active_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status, last_active_at DESC);

        CREATE TABLE IF NOT EXISTS conversation_topics (
          conversation_id TEXT NOT NULL
            REFERENCES conversations(id) ON DELETE CASCADE,
          topic_id TEXT NOT NULL
            REFERENCES topics(id) ON DELETE CASCADE,
          /* How the link was made and how much to trust it — the same
             provenance the memory admission gate will need later (§8.15). */
          source TEXT NOT NULL CHECK(source IN ('user','model','heuristic')),
          confidence REAL NOT NULL,
          evidence TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (conversation_id, topic_id)
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_topics_topic
          ON conversation_topics(topic_id, created_at DESC);
      `);
    },
  },
  {
    version: 8,
    name: 'run origin on pending approvals',
    up(db) {
      // A run started from an inferred situation may not reach an irreversible
      // tool. That rule has to survive an approval: without this column, a
      // resumed run forgot it was ever a guess, and the restriction quietly
      // lifted halfway through.
      //
      // Existing rows default to 'user' — they were all typed by someone,
      // since nothing could start an inferred run before this migration.
      db.exec(`
        ALTER TABLE pending_approvals
          ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
          CHECK(origin IN ('user','inferred'));
      `);
    },
  },
  {
    version: 9,
    name: 'opt-in persistence for situational observations',
    up(db) {
      // A record of when someone was home is not the same kind of record as a
      // conversation, and it is not one to start keeping by default. So the
      // policy table is the switch: an observation kind with no row here is
      // never written. Absence means off, and off is the initial state of
      // everything.
      db.exec(`
        CREATE TABLE IF NOT EXISTS context_retention (
          kind TEXT PRIMARY KEY,
          /* Both required at enable time. There is no "keep forever" here:
             an unbounded log of a person's movements is not a default
             anyone should be able to arrive at by omission. */
          retain_ms INTEGER NOT NULL CHECK(retain_ms > 0),
          max_rows INTEGER NOT NULL CHECK(max_rows > 0),
          enabled_at TEXT NOT NULL,
          /* Who decided, and why. The decision is auditable because it is
             the user's decision, not the system's. */
          decided_by TEXT NOT NULL,
          note TEXT
        );

        CREATE TABLE IF NOT EXISTS context_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          value_json TEXT NOT NULL,
          /* What the source claimed, and what it was worth after its
             calibration ceiling. Both, so a later reader can tell a measured
             sensor from an unmeasured one without guessing. */
          confidence REAL NOT NULL,
          effective_confidence REAL NOT NULL,
          evidence TEXT,
          observed_at TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_obs_kind
          ON context_observations(kind, observed_at DESC);
      `);
    },
  },
  {
    version: 10,
    name: 'pronunciation dictionary for speech output',
    up(db) {
      // Japanese medical vocabulary is full of compounds a general-purpose
      // voice reads by the wrong rule: 平滑筋 as へいかつすじ rather than
      // へいかつきん, 弛緩 as ちかん rather than しかん. That is a property of
      // the language and the domain, not of any one vendor, so it is fixed
      // before the text reaches an engine rather than per engine.
      db.exec(`
        CREATE TABLE IF NOT EXISTS pronunciations (
          term TEXT PRIMARY KEY,
          /* Kana. Sent in place of the term; the displayed text is untouched. */
          reading TEXT NOT NULL,
          note TEXT,
          /* 'seed' for the shipped list, 'user' for corrections made here.
             A user entry always wins, because they heard it and we did not. */
          source TEXT NOT NULL CHECK(source IN ('seed','user')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 11,
    name: 'full-text search across conversations',
    up(db) {
      // Topics say which threads belong together; this says what was actually
      // said in them. Without it, anything never linked to a topic is
      // effectively lost — and the handoff is explicit that sending every
      // conversation to the model on each turn is not an acceptable answer.
      //
      // trigram rather than the default unicode61: measured on this machine,
      // unicode61 cannot match 平滑筋 inside 気管支平滑筋を弛緩させる at all,
      // because it has no word boundaries to find in Japanese. trigram indexes
      // overlapping three-character runs, which does match — at the cost of a
      // three-character minimum on queries, which the search layer reports as
      // "too short" rather than as "nothing found". Those are different
      // answers and must not look the same.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
          content,
          message_id UNINDEXED,
          conversation_id UNINDEXED,
          role UNINDEXED,
          created_at UNINDEXED,
          tokenize = 'trigram'
        );
      `);

      // Everything already said, so search does not start blind on a database
      // that has been in use for months.
      db.exec(`
        INSERT INTO message_search (content, message_id, conversation_id, role, created_at)
        SELECT content, id, conversation_id, role, created_at FROM conversation_messages;
      `);

      // Kept in step by the database rather than by remembering to call
      // something: a search index maintained by convention drifts the first
      // time a new write path is added.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS message_search_insert
        AFTER INSERT ON conversation_messages BEGIN
          INSERT INTO message_search (content, message_id, conversation_id, role, created_at)
          VALUES (new.content, new.id, new.conversation_id, new.role, new.created_at);
        END;

        CREATE TRIGGER IF NOT EXISTS message_search_delete
        AFTER DELETE ON conversation_messages BEGIN
          DELETE FROM message_search WHERE message_id = old.id;
        END;

        CREATE TRIGGER IF NOT EXISTS message_search_update
        AFTER UPDATE ON conversation_messages BEGIN
          DELETE FROM message_search WHERE message_id = old.id;
          INSERT INTO message_search (content, message_id, conversation_id, role, created_at)
          VALUES (new.content, new.id, new.conversation_id, new.role, new.created_at);
        END;
      `);
    },
  },
  {
    version: 12,
    name: 'oauth credentials for external tool servers',
    up(db) {
      // Tokens for MCP servers that require OAuth — Google's hosted servers
      // do. Stored so a restart does not mean re-consenting, which would make
      // an unattended service impossible.
      //
      // These are bearer credentials for the user's mail, calendar and files.
      // Nothing reads this table except the token store, nothing returns its
      // contents over HTTP, and nothing writes it to a log.
      db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          server_id TEXT PRIMARY KEY,
          tokens_json TEXT NOT NULL,
          /* Recorded separately so expiry can be reported without decoding
             the credential itself. */
          expires_at TEXT,
          scope TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        /* One row per authorization attempt, deleted when it completes.
           Holds the PKCE verifier and the CSRF state — both are one-use and
           neither is a credential once the flow has finished. */
        CREATE TABLE IF NOT EXISTS oauth_flows (
          state TEXT PRIMARY KEY,
          server_id TEXT NOT NULL,
          code_verifier TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 13,
    name: 'model availability checks',
    up(db) {
      // When each configured model was last confirmed to exist.
      //
      // The failure this guards against has already happened: a configured
      // Gemini model became unavailable and it took a fix on the machine.
      // Discovery answers "does it exist now"; this answers "when did we last
      // know", which is the question that matters after a restart, and which
      // an in-memory result cannot answer at all.
      //
      // `present` is nullable on purpose. Not being able to reach a provider
      // and a model having been retired are different facts, and storing the
      // first as `false` would turn every network blip into a retirement.
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_checks (
          setting TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          present INTEGER,
          note TEXT,
          checked_at TEXT NOT NULL,
          /* The last time it was seen present, kept across later failures so
             "it was fine an hour ago" stays answerable. */
          last_present_at TEXT
        );
      `);
    },
  },
  {
    version: 14,
    name: 'memories with their provenance',
    up(db) {
      // Deliberately not one undifferentiated table, which is the whole point
      // of the entry this implements. The columns that look like metadata are
      // the design: without them a sentence copied out of an external tool's
      // documentation is recalled later as something the user said.
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          /* user | measured | inferred | external. Nothing outranks user. */
          provenance TEXT NOT NULL,
          /* Specific enough to go back to. A provenance with no source is a
             claim about a claim. */
          source TEXT NOT NULL,
          confidence REAL NOT NULL,
          /* durable | until | session */
          retention TEXT NOT NULL,
          expires_at TEXT,
          /* shareable | local_only. Checked at recall, because a boundary
             that depends on every future call site remembering it has
             already been crossed somewhere. */
          privacy TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '[]',
          topic_ref TEXT,
          created_at TEXT NOT NULL,
          /* Contradicted rather than deleted: what was believed, and when it
             stopped being believed, are both worth keeping. */
          superseded_by TEXT
        );

        CREATE INDEX IF NOT EXISTS memories_kind ON memories (kind);
        CREATE INDEX IF NOT EXISTS memories_live ON memories (superseded_by, retention);
      `);
    },
  },
  {
    version: 15,
    name: 'decision traces',
    up(db) {
      // The activity log records that decisions happened. This records why,
      // which is the question that actually gets asked later and the one that
      // otherwise survives only as long as the conversation does.
      db.exec(`
        CREATE TABLE IF NOT EXISTS decisions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          decided TEXT NOT NULL,
          /* user | iris | constraint. The user deciding not to build
             something and IRIS concluding the same carry different weight
             when the question is reopened. */
          decided_by TEXT NOT NULL,
          grounds_json TEXT NOT NULL,
          /* Empty is allowed and meaningful: it says no alternatives were
             weighed, rather than leaving that to be assumed either way. */
          alternatives_json TEXT NOT NULL DEFAULT '[]',
          rule TEXT,
          /* What it would take to undo this. Reversibility decides how much
             care a decision deserved and is invisible afterwards. */
          reversal TEXT,
          affects_json TEXT NOT NULL DEFAULT '[]',
          topic_ref TEXT,
          created_at TEXT NOT NULL,
          /* Revised, never deleted. A decision that was later reversed is
             the most useful kind to be able to read. */
          revised_by TEXT
        );

        CREATE INDEX IF NOT EXISTS decisions_live ON decisions (revised_by, created_at);
      `);
    },
  },
  {
    version: 16,
    name: 'experiences',
    up(db) {
      // What happened when something was tried. One row per attempt, with the
      // observation count kept rather than collapsed — 過去の成功は根拠であって
      // 法則ではない, and a store that forgets how many times it saw something
      // cannot express the difference.
      db.exec(`
        CREATE TABLE IF NOT EXISTS experiences (
          id TEXT PRIMARY KEY,
          /* Normalised form of the attempt, so the same thing tried twice
             accumulates instead of duplicating. */
          attempt_key TEXT NOT NULL UNIQUE,
          attempt TEXT NOT NULL,
          /* The conditions. An experience without them is a superstition. */
          situation TEXT NOT NULL,
          outcome TEXT NOT NULL,
          /* Every outcome seen, in order. A method that stopped working shows
             up here before it shows up anywhere else. */
          outcomes_json TEXT NOT NULL DEFAULT '[]',
          learned TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '[]',
          affects_json TEXT NOT NULL DEFAULT '[]',
          observations INTEGER NOT NULL DEFAULT 1,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS experiences_outcome ON experiences (outcome, observations);
      `);
    },
  },
  {
    version: 17,
    name: 'agent_schedule',
    up(db) {
      // Work the user queued before going to bed.
      //
      // Persisted rather than held in memory, because the whole point is that
      // it survives the hours nobody is watching — and a restart at 2am that
      // silently emptied the queue would look identical to a night when
      // nothing was scheduled. That distinction is the one this project keeps
      // paying for when it is missing.
      //
      // The row is the authorization. Queueing is the moment the user decided,
      // and the run inherits that decision rather than needing a new one, so
      // nothing here reaches the approval boundary or asks it for an exception.
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_schedule (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          repo TEXT NOT NULL,
          /* When it becomes eligible. Never a recurrence: a repeating unattended
             run is a different decision from a single one. */
          due_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          /* queued | started | cancelled | failed */
          state TEXT NOT NULL DEFAULT 'queued',
          /* The run it became, once it started. */
          run_id TEXT,
          /* Why it did not start, when it did not. Kept so a morning with no
             branch has an answer rather than a silence. */
          note TEXT,
          settled_at TEXT
        );

        CREATE INDEX IF NOT EXISTS agent_schedule_due ON agent_schedule (state, due_at);
      `);
    },
  },
  {
    version: 18,
    name: 'finance',
    up(db) {
      // Money, kept under a stricter rule than anything else here.
      //
      // Two tables rather than one, because they have different lifetimes and
      // different privacy. Line items say where a person was and when; they
      // expire (13 months, chosen as the least that still allows a
      // year-on-year comparison) and never leave the machine. Aggregates say
      // "食費 42,000 in July"; they are kept indefinitely and may go into a
      // prompt. Storing both in one table would force one rule onto both, and
      // the rule that lost would be the strict one.
      //
      // The user decided this on 2026-08-20, along with keeping the files
      // themselves outside the workspace so `read_file` — which auto-executes
      // as READ — cannot reach them.
      db.exec(`
        CREATE TABLE IF NOT EXISTS finance_transactions (
          id TEXT PRIMARY KEY,
          /* Which import produced this, so a bad file can be undone whole. */
          import_id TEXT NOT NULL,
          account TEXT NOT NULL,
          occurred_on TEXT NOT NULL,
          /* Minor units (yen has none, but the column should not decide that). */
          amount INTEGER NOT NULL,
          description TEXT NOT NULL,
          category TEXT,
          imported_at TEXT NOT NULL,
          /* When this row is due to be deleted. Written at import so the
             retention promise does not depend on remembering to apply it. */
          expires_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS finance_tx_expiry ON finance_transactions (expires_at);
        CREATE INDEX IF NOT EXISTS finance_tx_month ON finance_transactions (occurred_on);
        /* The same line twice from a re-imported file is not two purchases. */
        CREATE UNIQUE INDEX IF NOT EXISTS finance_tx_identity
          ON finance_transactions (account, occurred_on, amount, description);

        CREATE TABLE IF NOT EXISTS finance_monthly (
          /* YYYY-MM */
          month TEXT NOT NULL,
          category TEXT NOT NULL,
          total INTEGER NOT NULL,
          count INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (month, category)
        );

        CREATE TABLE IF NOT EXISTS finance_imports (
          id TEXT PRIMARY KEY,
          file_name TEXT NOT NULL,
          format TEXT NOT NULL,
          rows INTEGER NOT NULL,
          skipped INTEGER NOT NULL,
          imported_at TEXT NOT NULL,
          note TEXT
        );
      `);
    },
  },
  {
    version: 19,
    name: 'finance_occurrence',
    up(db) {
      // Identity for a transaction, which is not what it looks like.
      //
      // Version 18 deduped on (account, date, amount, description). The
      // register had already written down why that is wrong —
      // `finance_import_idempotency`: 日付＋金額＋店舗だけの重複判定は、
      // 正当な複数決済を誤削除する — and it was built that way anyway, because
      // nobody read the entry before writing the table.
      //
      // Two coffees at the same shop on the same day for the same price are
      // two purchases. The old index silently kept one. `occurrence` is the
      // position among otherwise-identical rows *within a file*, so a
      // re-imported file matches row for row while a genuine second purchase
      // gets its own slot.
      db.exec(`
        ALTER TABLE finance_transactions ADD COLUMN occurrence INTEGER NOT NULL DEFAULT 0;
        DROP INDEX IF EXISTS finance_tx_identity;
        CREATE UNIQUE INDEX IF NOT EXISTS finance_tx_identity
          ON finance_transactions (account, occurred_on, amount, description, occurrence);
      `);
    },
  },
  {
    version: 20,
    name: 'finance_kind',
    up(db) {
      // Money moving between the user's own accounts is not spending.
      //
      // Importing a bank statement and a card statement for the same month
      // counts the card bill twice: once as the individual purchases, once as
      // the lump withdrawal that paid for them. The month then reports double
      // what was actually spent, and the number looks entirely plausible.
      //
      // Which withdrawal is a card payment is not inferred. A description has
      // to match a rule the user wrote, exactly — a heuristic tuned against
      // one bank's wording is the thing `finance_reconciliation` already warns
      // about (実データで測定して調整する). Anything unmatched stays counted
      // as spending, so a missing rule overstates the total rather than
      // hiding money.
      db.exec(`
        ALTER TABLE finance_transactions ADD COLUMN kind TEXT NOT NULL DEFAULT 'spending';

        CREATE TABLE IF NOT EXISTS finance_transfer_rules (
          id TEXT PRIMARY KEY,
          /* Matched against the description with =, never LIKE. */
          description TEXT NOT NULL,
          /* NULL applies the rule to every account. */
          account TEXT,
          note TEXT,
          created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS finance_transfer_rule_identity
          ON finance_transfer_rules (description, COALESCE(account, ''));
      `);

      // The aggregate must carry the kind, or the spending total is computed
      // from rows it was supposed to exclude.
      db.exec(`
        DROP TABLE IF EXISTS finance_monthly;
        CREATE TABLE finance_monthly (
          month TEXT NOT NULL,
          kind TEXT NOT NULL,
          category TEXT NOT NULL,
          total INTEGER NOT NULL,
          count INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (month, kind, category)
        );
      `);
    },
  },
  {
    version: 21,
    name: 'finance_pending',
    up(db) {
      // A purchase seen twice, from two sources, is still one purchase.
      //
      // A card notification email arrives within minutes; the CSV that
      // confirms it arrives at the end of the month. Both describe the same
      // ¥1,200, and adding them gives ¥2,400 — the register wrote this down
      // before either existed (`finance_pending_confirmed_model`: Gmail 利用
      // 通知は Pending、CSV は Confirmed。同一支出を二重計上しない).
      //
      // So a row has a status. `pending` counts toward the running total
      // because it is the only record of that money so far; when a confirmed
      // row matches it, the pending row becomes `superseded` and stops
      // counting — the confirmed one takes over. Nothing is deleted, so
      // "when did IRIS first know about this" stays answerable.
      db.exec(`
        ALTER TABLE finance_transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';
        ALTER TABLE finance_transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'csv';
        /* The confirmed row that replaced this pending one. */
        ALTER TABLE finance_transactions ADD COLUMN superseded_by TEXT;

        CREATE INDEX IF NOT EXISTS finance_tx_status ON finance_transactions (status, occurred_on);
      `);

      // The aggregate carries status for the same reason it carries kind: a
      // total computed across rows it was meant to exclude is wrong in a way
      // that looks like data.
      db.exec(`
        DROP TABLE IF EXISTS finance_monthly;
        CREATE TABLE finance_monthly (
          month TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          category TEXT NOT NULL,
          total INTEGER NOT NULL,
          count INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (month, kind, status, category)
        );
      `);
    },
  },
  {
    version: 22,
    name: 'delegation',
    up(db) {
      // Approval given once, with limits, instead of asked for every time.
      //
      // The same reasoning as `agent_schedule` above: the row is the
      // authorization, and the dispatch inherits the decision rather than
      // needing a new one. What differs is that a schedule authorizes one run
      // and this authorizes a class of them, so every bound a single run does
      // not need is written down here — how much, how many at once, which
      // repositories, and until when.
      //
      // Superseded rather than updated. "When did I agree to this, and to
      // what" has to stay answerable after the terms change, and a row that is
      // edited in place cannot answer it. Revoking is the same act: a
      // `revoked_at`, never a DELETE.
      db.exec(`
        CREATE TABLE IF NOT EXISTS delegation_grants (
          id TEXT PRIMARY KEY,
          /* One tool per grant. Never a pattern — scope is stated, not matched. */
          tool TEXT NOT NULL,
          /* JSON array of absolute repository paths. Exact matches only. */
          repos_json TEXT NOT NULL,
          daily_usd_cap REAL NOT NULL,
          max_concurrent INTEGER NOT NULL,
          /* A grant without an end is a setting, and a setting is what someone
             turns on in April and has forgotten by August. */
          expires_at TEXT NOT NULL,
          granted_at TEXT NOT NULL,
          /* What the person was agreeing to, for when they are asked again. */
          note TEXT,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS delegation_grants_tool
          ON delegation_grants (tool, revoked_at, expires_at);

        /* Every dispatch made under a grant.
         *
         * Separate from agent_runs because this is the spending record the
         * daily cap is computed from, and it has to survive a run row being
         * cleaned up. A cap computed from rows that can disappear is a cap
         * that quietly rises. */
        CREATE TABLE IF NOT EXISTS delegation_uses (
          id TEXT PRIMARY KEY,
          grant_id TEXT NOT NULL,
          run_id TEXT,
          repo TEXT NOT NULL,
          agent TEXT NOT NULL,
          used_at TEXT NOT NULL,
          /* Null until the run ends, and null forever if the meter could not
             read it. Never 0 as a stand-in — an unreadable cost is treated as
             over budget, not free. */
          usd REAL
        );

        CREATE INDEX IF NOT EXISTS delegation_uses_day ON delegation_uses (used_at);
      `);
    },
  },
  {
    version: 23,
    name: 'allowance_accounting',
    /**
     * What each dispatch cost in allowance, which is the quantity that runs out.
     *
     * The dollar figure was already here and it is not the constraint: both
     * agents run on subscriptions, and measured 2026-08-22 two Codex runs
     * costing $0.018 each moved that week's meter from 16% to 26%. Ten points
     * for four cents. Budgeting in dollars was budgeting in the wrong unit,
     * and there was no unit for the right one.
     *
     * Recorded as a before and an after rather than a delta, because the
     * subtraction is only valid when both ends came from the same week — a
     * reset between them turns a large spend into a large saving, and the two
     * numbers make that visible where one would not.
     */
    up(db) {
      db.exec(`
        ALTER TABLE delegation_uses ADD COLUMN week_before REAL;
        ALTER TABLE delegation_uses ADD COLUMN week_after REAL;
        /* Which allowance the percentages belong to. A run against Claude and
           one against Codex spend different weeks, and adding their points
           together would be adding fractions of different wholes. */
        ALTER TABLE delegation_uses ADD COLUMN vendor TEXT;
        /* What the dispatch was for. Allocation needs to know which share a
           run drew from, and "implement" and "audit" are the two that exist. */
        ALTER TABLE delegation_uses ADD COLUMN purpose TEXT;
      `);
    },
  },
  {
    version: 24,
    name: 'allowance_history',
    /**
     * Snapshots, because the sources do not keep history.
     *
     * The weekly percentage is a live reading that resets every seven days
     * and remembers nothing; the per-project figures are recounted from
     * transcripts each time they are asked for, and transcripts are files on
     * a disk that somebody may tidy. Both answer "right now" and neither
     * answers "what did the last month look like" — which is the question an
     * allocation has to be argued from.
     *
     * `week_resets_at` travels with each reading so a week boundary is
     * visible in the series. Without it a drop from 90 to 3 is
     * indistinguishable from a correction.
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS allowance_history (
          at TEXT NOT NULL,
          vendor TEXT NOT NULL,
          week_percent REAL,
          session_percent REAL,
          week_resets_at TEXT,
          PRIMARY KEY (at, vendor)
        );

        /* One row per project per snapshot. Weighted by list price, because
           raw tokens rank projects by how often they re-read a file: cache
           reads outnumber output by two orders of magnitude and cost a tenth
           of input. */
        CREATE TABLE IF NOT EXISTS project_usage_history (
          at TEXT NOT NULL,
          project TEXT NOT NULL,
          window_days INTEGER NOT NULL,
          weighted_usd REAL NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          messages INTEGER NOT NULL,
          PRIMARY KEY (at, project)
        );

        CREATE INDEX IF NOT EXISTS allowance_history_at ON allowance_history (at);
        CREATE INDEX IF NOT EXISTS project_usage_history_at ON project_usage_history (at);
      `);
    },
  },
  {
    version: 25,
    name: 'delegation_model_and_tokens',
    /**
     * Which model ran it, and what it actually consumed.
     *
     * The table recorded the vendor and the dollars and stopped there. On
     * 2026-08-26 the third agent began choosing a model from the role — Claude
     * Opus for a review, Gemini Flash for a verification, Gemini Pro for the
     * rest — and none of that was written down. So the question the routing
     * exists to answer, whether the heavier model was worth it, could not be
     * asked of the record at all.
     *
     * Tokens for the same reason the week replaced the dollar: the plans are
     * subscriptions and the dollar figure is indicative, while tokens are what
     * was actually spent. `usd` stays because it is what the transcripts
     * report and removing a column loses four days of it.
     *
     * All nullable, and that is the honest shape. The third agent files no
     * cost anywhere IRIS can read, so its rows carry a model and no tokens —
     * which is a fact about that agent worth being able to see, rather than a
     * gap to be filled with zeroes.
     */
    up(db) {
      db.exec(`
        ALTER TABLE delegation_uses ADD COLUMN model TEXT;
        ALTER TABLE delegation_uses ADD COLUMN output_tokens INTEGER;
        ALTER TABLE delegation_uses ADD COLUMN input_tokens INTEGER;
        ALTER TABLE delegation_uses ADD COLUMN cache_read_tokens INTEGER;
      `);
    },
  },
  {
    version: 26,
    name: 'file_locks',
    /**
     * The ledger behind the kernel's flag.
     *
     * `chflags uchg` is what actually stops a deletion, and it holds no reason
     * and no history — the disk knows a file is protected and nothing knows
     * why, or who decided, or when it stopped being protected. This is that
     * half.
     *
     * The unlocking is the row worth reading. A lock nobody removed is a lock
     * doing its job quietly; one that came off in the middle of a night is the
     * thing to go and look at, which is why the reason for removal is stored
     * beside the reason for applying it rather than replacing it.
     *
     * Keyed by path, one row per file, updated in place: the question is
     * always "is this protected now, and what happened to it", and a table
     * that grew a row per toggle would answer it more slowly and no better.
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_locks (
          path TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          locked_by TEXT NOT NULL,
          unlocked_at TEXT,
          unlocked_reason TEXT
        );
      `);
    },
  },
  {
    version: 27,
    name: 'fdp_task_holds',
    /**
     * A task deliberately parked, and the date that stops it being parked.
     *
     * The ledger could say a task had not moved for 29 days and could not say
     * whether that was a decision or a lapse. Both look identical in
     * 最終更新日, so the panel had to report the stalled ones and the paused
     * ones in the same words, and the reader learned to discount both.
     *
     * `held_until` is NOT NULL on purpose. A pause with a reason but no end
     * date does not expire, so a task parked in March is still "on hold" in
     * September and forgetting has been given a respectable name. The date is
     * what makes the pause temporary by construction: when it passes, the row
     * stops applying and the task goes back to being judged like any other.
     * A reason is worth having and is not worth trusting on its own.
     *
     * `set_by` is here because sessions write this table, not only the person.
     * A task that quietly came off hold needs to be traceable to whoever did
     * it, and "IRIS did it" is not an answer when three of them are running.
     *
     * One row per task, replaced in place: the question asked is always "is
     * this parked right now", and released holds are kept in `released_at`
     * rather than as history, for the same reason `file_locks` does it.
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fdp_task_holds (
          task_id TEXT PRIMARY KEY,
          held_until TEXT NOT NULL,
          reason TEXT,
          set_by TEXT NOT NULL,
          set_at TEXT NOT NULL,
          released_at TEXT,
          released_by TEXT
        );
      `);
    },
  },
  {
    version: 28,
    name: 'fdp_tasks',
    /**
     * The task ledger itself, moved in from the spreadsheet.
     *
     * It moved because of who updates it. A ledger a person edits by hand once
     * a week can live in a sheet; one that sessions write to cannot — every
     * session would need the Apps Script path and a Google authorisation that
     * expires every seven days on this machine, to reach a store that is
     * slower and less available than the database already open beside them.
     *
     * The columns keep their sheet names in spirit but not in wording: a
     * store read by code should not need the reader to know Japanese column
     * headers. `source_row_json` keeps the row exactly as it arrived, so a
     * column this schema forgot is not lost by importing.
     *
     * `updated_by` is the reason the move is worth making at all. The sheet
     * recorded 最終更新日 and nothing else, so a date moving told you the task
     * had been touched and never by whom. With three sessions and a person
     * writing here, "it changed on Tuesday" is not an answer.
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fdp_tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          field TEXT,
          priority TEXT,
          start_date TEXT,
          due_date TEXT,
          status TEXT,
          progress REAL,
          estimated_hours REAL,
          actual_hours REAL,
          last_updated TEXT,
          done_criteria TEXT,
          next_action TEXT,
          osaka_link TEXT,
          bucket TEXT,
          source_row_json TEXT NOT NULL,
          imported_at TEXT,
          updated_by TEXT,
          updated_at TEXT
        );

        /**
         * Every write, kept.
         *
         * The row above says what a task looks like now. This says how it got
         * that way, which is the question actually asked when a task turns out
         * to have been wrong — and with sessions writing, "when did this
         * become 完了, and which one decided that" has to be answerable.
         */
        CREATE TABLE IF NOT EXISTS fdp_task_writes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          field TEXT NOT NULL,
          old_value TEXT,
          new_value TEXT,
          written_by TEXT NOT NULL,
          written_at TEXT NOT NULL,
          mirrored_to_sheet INTEGER NOT NULL DEFAULT 0,
          mirror_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_fdp_writes_task ON fdp_task_writes(task_id, written_at);
      `);
    },
  },
  {
    version: 29,
    name: 'delegated_runs',
    /**
     * 委任した実行の台帳。**プロセスの外に置く。**
     *
     * `AgentProcessService` は走っている実行をメモリの `Map` で持っている。
     * IRIS が再起動すると、走っていたことごと消える —— 独立レビュー
     * （astra、2026-09-08）が「再起動をまたぐ委任監督が無い」と指摘した形。
     *
     * もう一つ、同じ穴から出ていた問題。`/api/telemetry/models` は
     * `agent_runs` を読むが、**あれは開発タスクに紐づいた実行と独立レビュー
     * だけ**が書く表で、`codex exec` を起こす本当の委任は一行も書いていない。
     * 実測 2026-09-08: `agent_runs` は8行、**全部 8月18日の2時間ぶん**で、
     * それ以降は空。一方 CLI 側では委任が動き続けている。だから telemetry は
     * 「どのモデルも判断できるだけの試行がない」と言い続ける —— 記録が
     * 足りないのではなく、**記録していないところで働いていた。**
     *
     * `agent_runs` に相乗りしないのは、あちらが `task_id` を要求するから。
     * 課題に紐づかない委任に、紐づけるための課題を作るのは本末転倒。
     *
     * `model` を別に持つのは、同じ `agent` が別の模型を回すため（2026-09-08
     * に codex の委任へ `-m` を渡すようにした）。**どの模型が効いたか**が
     * 知りたいことなので、agent だけでは足りない。
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS delegated_runs (
          id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          model TEXT,
          repo TEXT,
          branch TEXT,
          handoff_id TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          /** 'running' | 'stopped'。再起動をまたいで残る。 */
          state TEXT NOT NULL,
          /** completed / quota_exhausted / stopped_by_user など。 */
          stop_reason TEXT,
          exit_code INTEGER,
          /** 加入で走るので請求ではない。目安として残す。 */
          usd REAL
        );
        CREATE INDEX IF NOT EXISTS idx_delegated_started ON delegated_runs(started_at);
        CREATE INDEX IF NOT EXISTS idx_delegated_state ON delegated_runs(state);
      `);
    },
  },
  {
    version: 30,
    name: 'proactive_rules',
    /**
     * 先回りの規則を、プロセスの外に置く。
     *
     * `ProactiveService` は規則を配列で持っていて、**起動のたびに空**になる。
     * 足す口（`POST /api/proactive/rules`）はあるが、足したものは再起動で
     * 消える。だから規則は一つも無く、提案も一件も出たことがない
     * （実測 2026-09-08: 提案イベント0件。試験は399行ある）。
     *
     * **試験があって動く仕組みが、繋がっていないだけで空回りしていた。**
     * 保存する場所が無かったのが、繋がらなかった理由の半分。
     *
     * `conditions_json` は条件をそのまま持つ。列に開くと、条件の形が変わる
     * たびに移行が要る —— 規則の形はまだ動く。
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS proactive_rules (
          id TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          conditions_json TEXT NOT NULL,
          suggestion TEXT NOT NULL,
          cooldown_ms INTEGER NOT NULL,
          prompt TEXT,
          created_at TEXT NOT NULL,
          /** 止めたい規則を消さずに黙らせる。消すと、なぜ在ったかも消える。 */
          enabled INTEGER NOT NULL DEFAULT 1
        );
      `);
    },
  },
  {
    version: 31,
    name: 'lane_preferences',
    /**
     * 会話の出し先を、画面から選べるようにする。
     *
     * 声と文字で頼む相手を変える仕組みは入った（2026-09-11）が、決めるのは
     * `.env` の `IRIS_VOICE_PRIORITY` / `IRIS_TEXT_PRIORITY` だけだった。
     * **設定ファイルを編集して再起動しないと変えられない**のは、利用者が
     * 触れる設定ではない。
     *
     * 入力バーの chip には「読むだけで、押せない。ここから選ばせる口は
     * 無い」と書いてある。**その口をここに作る。**
     *
     * 汎用の key/value にしたのは、これ一つのために表を作ると、次の設定でも
     * また表が要るから。値は文字列で、意味は読む側が持つ。
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS preferences (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function getSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export function runMigrations(db: Database.Database): { from: number; to: number; applied: string[] } {
  const from = getSchemaVersion(db);
  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    const tx = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    tx();
    applied.push(`${migration.version}: ${migration.name}`);
  }

  return { from, to: getSchemaVersion(db), applied };
}

export interface OpenDatabaseOptions {
  /** WAL is persistent and pointless for :memory:, so tests can opt out. */
  wal?: boolean;
  verbose?: boolean;
}

export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): Database.Database {
  const db = new Database(filePath);

  // Must be set outside a transaction, and per-connection (not persisted).
  db.pragma('foreign_keys = ON');
  if (options.wal !== false && filePath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  const result = runMigrations(db);
  if (options.verbose && result.applied.length > 0) {
    console.log(`[db] schema ${result.from} -> ${result.to}`);
    for (const line of result.applied) console.log(`[db]   applied ${line}`);
  }

  assertHealthy(db);
  return db;
}

/** Fails fast if the connection is not in the state the rest of the system assumes. */
export function assertHealthy(db: Database.Database): void {
  const fk = db.pragma('foreign_keys', { simple: true });
  if (fk !== 1) {
    throw new Error('Database opened without foreign_keys enforcement.');
  }
  const version = getSchemaVersion(db);
  if (version !== LATEST_SCHEMA_VERSION) {
    throw new Error(`Database schema version ${version} != expected ${LATEST_SCHEMA_VERSION}.`);
  }
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    throw new Error(`Database integrity_check failed: ${integrity}`);
  }
}
