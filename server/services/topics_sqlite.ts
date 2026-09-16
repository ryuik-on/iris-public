import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type TopicKind = 'project' | 'subject' | 'person' | 'place' | 'other';
export type TopicStatus = 'active' | 'paused' | 'done' | 'archived';
export type LinkSource = 'user' | 'model' | 'heuristic';

export interface Topic {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: TopicKind;
  status: TopicStatus;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
}

export interface TopicLink {
  conversationId: string;
  topicId: string;
  source: LinkSource;
  /** 1.0 only for a human saying so; heuristics never claim certainty. */
  confidence: number;
  evidence: string | null;
  createdAt: string;
}

export interface CreateTopicInput {
  name: string;
  kind?: TopicKind;
  description?: string | null;
  aliases?: string[];
  status?: TopicStatus;
}

export class TopicNotFoundError extends Error {
  constructor(public readonly ref: string) {
    super(`Topic not found: ${ref}`);
    this.name = 'TopicNotFoundError';
  }
}

/**
 * Topics, and which conversations belong to them.
 *
 * A topic is not a property of a conversation — it spans them. That is the
 * point: the user should not have to remember which thread something was said
 * in (decision 8.3), and a per-conversation label cannot express "these six
 * threads are the same piece of work".
 *
 * Every link records how it was made and how confident that was. A heuristic
 * guess and a person saying so are both useful and must not be stored as if
 * they were the same thing — the same provenance discipline the memory
 * admission gate will need (§8.15).
 *
 * Schema is owned by db.ts migration 7.
 */
export class SqliteTopicStore {
  constructor(private db: Database.Database) {}

  createTopic(input: CreateTopicInput): Topic {
    const name = input.name?.trim();
    if (!name) throw new Error('name は必須です。');

    const now = new Date().toISOString();
    const id = randomUUID();
    const slug = toSlug(name);

    const existing = this.getBySlug(slug);
    if (existing) {
      throw new Error(`同じ名前のトピックが既に存在します: ${existing.name}`);
    }

    this.db
      .prepare(
        `INSERT INTO topics
           (id, slug, name, description, kind, status, aliases_json,
            created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        id,
        slug,
        name,
        input.description ?? null,
        input.kind ?? 'other',
        input.status ?? 'active',
        JSON.stringify(normaliseAliases(input.aliases)),
        now,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): Topic | null {
    const row = this.db.prepare(`SELECT * FROM topics WHERE id = ?`).get(id) as any;
    return row ? mapTopic(row) : null;
  }

  getBySlug(slug: string): Topic | null {
    const row = this.db.prepare(`SELECT * FROM topics WHERE slug = ?`).get(slug) as any;
    return row ? mapTopic(row) : null;
  }

  /** Accepts an id or a slug, so callers need not know which they hold. */
  resolve(ref: string): Topic {
    const topic = this.getById(ref) ?? this.getBySlug(toSlug(ref));
    if (!topic) throw new TopicNotFoundError(ref);
    return topic;
  }

  listTopics(options: { status?: TopicStatus; limit?: number } = {}): Topic[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = options.status
      ? (this.db
          .prepare(
            `SELECT * FROM topics WHERE status = ?
              ORDER BY COALESCE(last_active_at, updated_at) DESC LIMIT ?`
          )
          .all(options.status, limit) as any[])
      : (this.db
          .prepare(
            `SELECT * FROM topics
              ORDER BY COALESCE(last_active_at, updated_at) DESC LIMIT ?`
          )
          .all(limit) as any[]);
    return rows.map(mapTopic);
  }

  updateTopic(ref: string, patch: Partial<CreateTopicInput>): Topic {
    const topic = this.resolve(ref);
    const merged = { ...topic, ...patch };
    this.db
      .prepare(
        `UPDATE topics
            SET name = ?, description = ?, kind = ?, status = ?, aliases_json = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        merged.name,
        merged.description ?? null,
        merged.kind,
        merged.status,
        JSON.stringify(normaliseAliases(merged.aliases)),
        new Date().toISOString(),
        topic.id
      );
    return this.getById(topic.id)!;
  }

  /**
   * Links a conversation to a topic.
   *
   * A stronger claim replaces a weaker one — a person confirming what a
   * heuristic guessed should upgrade the link, not be rejected as a duplicate.
   * A weaker claim never downgrades an existing stronger one.
   */
  link(input: {
    conversationId: string;
    topicRef: string;
    source: LinkSource;
    confidence?: number;
    evidence?: string | null;
  }): TopicLink {
    const topic = this.resolve(input.topicRef);
    const confidence = clampConfidence(input.confidence ?? defaultConfidence(input.source));
    const now = new Date().toISOString();

    const existing = this.db
      .prepare(`SELECT * FROM conversation_topics WHERE conversation_id = ? AND topic_id = ?`)
      .get(input.conversationId, topic.id) as any;

    if (existing && rank(existing.source) >= rank(input.source) && existing.confidence >= confidence) {
      return mapLink(existing);
    }

    try {
      this.db
        .prepare(
          `INSERT INTO conversation_topics
             (conversation_id, topic_id, source, confidence, evidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id, topic_id) DO UPDATE SET
             source = excluded.source,
             confidence = excluded.confidence,
             evidence = COALESCE(excluded.evidence, conversation_topics.evidence)`
        )
        .run(input.conversationId, topic.id, input.source, confidence, input.evidence ?? null, now);
    } catch (err: any) {
      if (String(err?.message).includes('FOREIGN KEY')) {
        throw new Error(`会話またはトピックが存在しません: ${input.conversationId} / ${input.topicRef}`);
      }
      throw err;
    }

    this.touch(topic.id, now);
    return this.getLink(input.conversationId, topic.id)!;
  }

  unlink(conversationId: string, topicRef: string): boolean {
    const topic = this.resolve(topicRef);
    return (
      this.db
        .prepare(`DELETE FROM conversation_topics WHERE conversation_id = ? AND topic_id = ?`)
        .run(conversationId, topic.id).changes > 0
    );
  }

  getLink(conversationId: string, topicId: string): TopicLink | null {
    const row = this.db
      .prepare(`SELECT * FROM conversation_topics WHERE conversation_id = ? AND topic_id = ?`)
      .get(conversationId, topicId) as any;
    return row ? mapLink(row) : null;
  }

  /** Topics a conversation belongs to. A conversation may have several (§8.13). */
  topicsForConversation(conversationId: string): Array<Topic & { link: TopicLink }> {
    const rows = this.db
      .prepare(
        `SELECT t.*, ct.source, ct.confidence, ct.evidence, ct.created_at AS link_created_at
           FROM conversation_topics ct
           JOIN topics t ON t.id = ct.topic_id
          WHERE ct.conversation_id = ?
          ORDER BY ct.confidence DESC, t.name`
      )
      .all(conversationId) as any[];

    return rows.map((row) => ({
      ...mapTopic(row),
      link: {
        conversationId,
        topicId: row.id,
        source: row.source,
        confidence: row.confidence,
        evidence: row.evidence,
        createdAt: row.link_created_at,
      },
    }));
  }

  /** Conversations under a topic — the cross-thread view that is the point. */
  conversationsForTopic(topicRef: string, limit = 100): Array<{
    conversationId: string;
    title: string | null;
    updatedAt: string;
    messageCount: number;
    link: TopicLink;
  }> {
    const topic = this.resolve(topicRef);
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.updated_at, ct.source, ct.confidence, ct.evidence,
                ct.created_at AS link_created_at,
                (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count
           FROM conversation_topics ct
           JOIN conversations c ON c.id = ct.conversation_id
          WHERE ct.topic_id = ?
          ORDER BY c.updated_at DESC
          LIMIT ?`
      )
      .all(topic.id, Math.min(Math.max(limit, 1), 500)) as any[];

    return rows.map((row) => ({
      conversationId: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      link: {
        conversationId: row.id,
        topicId: topic.id,
        source: row.source,
        confidence: row.confidence,
        evidence: row.evidence,
        createdAt: row.link_created_at,
      },
    }));
  }

  /**
   * Retention (decision 8.5): nothing is removed automatically. This exists
   * for an explicit delete. Links go with it; the conversations do not.
   */
  deleteTopic(ref: string): boolean {
    const topic = this.resolve(ref);
    return this.db.prepare(`DELETE FROM topics WHERE id = ?`).run(topic.id).changes > 0;
  }

  touch(topicId: string, at = new Date().toISOString()) {
    this.db.prepare(`UPDATE topics SET last_active_at = ?, updated_at = ? WHERE id = ?`)
      .run(at, at, topicId);
  }
}

/**
 * Suggests topics for a piece of text by matching names and aliases.
 *
 * Deliberately deterministic and free: spending a model call to label every
 * conversation would cost more than it saves, and the same reasoning that kept
 * titles deterministic applies here (decision 8.4). It suggests only — the
 * caller decides whether to link, and a suggestion is stored as a heuristic
 * with matching confidence, never as fact.
 */
export function suggestTopics(
  text: string,
  topics: Topic[]
): Array<{ topic: Topic; confidence: number; evidence: string }> {
  const haystack = text.toLowerCase();
  const suggestions: Array<{ topic: Topic; confidence: number; evidence: string }> = [];

  for (const topic of topics) {
    if (topic.status === 'archived') continue;

    const terms = [topic.name, ...topic.aliases].filter((t) => t.trim().length >= 2);
    const hit = terms.find((term) => haystack.includes(term.toLowerCase()));
    if (!hit) continue;

    // A longer term matching is less likely to be coincidence than a short one.
    // Capped well below certainty: this is a string match, not understanding.
    const confidence = Math.min(0.6, 0.3 + hit.length * 0.02);
    suggestions.push({ topic, confidence, evidence: `「${hit}」に一致` });
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

function defaultConfidence(source: LinkSource): number {
  // Only a person gets certainty. A model's judgement is good but fallible; a
  // string match is weaker still.
  return source === 'user' ? 1 : source === 'model' ? 0.7 : 0.4;
}

function rank(source: LinkSource): number {
  return source === 'user' ? 3 : source === 'model' ? 2 : 1;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normaliseAliases(aliases?: string[]): string[] {
  if (!Array.isArray(aliases)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    const trimmed = String(alias ?? '').trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

function mapTopic(row: any): Topic {
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(row.aliases_json ?? '[]');
    if (Array.isArray(parsed)) aliases = parsed;
  } catch {
    /* a corrupt alias list must not make the topic unreadable */
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    status: row.status,
    aliases,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
  };
}

function mapLink(row: any): TopicLink {
  return {
    conversationId: row.conversation_id,
    topicId: row.topic_id,
    source: row.source,
    confidence: row.confidence,
    evidence: row.evidence,
    createdAt: row.created_at,
  };
}
