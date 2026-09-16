import {
  SqliteTopicStore,
  Topic,
  TopicLink,
  CreateTopicInput,
  TopicStatus,
  TopicNotFoundError,
  suggestTopics,
} from '../services/topics_sqlite.js';
import { SqliteConversationStore } from '../services/conversation_sqlite.js';
import { SqliteActivityLogStore } from '../services/activity_log_sqlite.js';

export interface TopicView extends Topic {
  conversationCount: number;
  messageCount: number;
}

export interface TopicDetail extends Topic {
  conversations: Array<{
    conversationId: string;
    title: string | null;
    updatedAt: string;
    messageCount: number;
    link: TopicLink;
  }>;
}

/**
 * Topics across conversations.
 *
 * The problem this exists for is stated in decision 8.3: the user must not
 * have to remember which thread something was said in. A conversation list
 * cannot answer "show me everything about the cardiology work" when that work
 * spans six threads started weeks apart.
 *
 * Two disciplines carried from the surrounding system:
 *
 *   - Nothing is deleted automatically (8.5). Topics accumulate; merging and
 *     archiving are proposals for a person, not background behaviour.
 *   - Every link records who made it and how sure they were. A person saying
 *     so and a string match are both useful and must never be stored as the
 *     same claim — the memory admission gate will need exactly this
 *     distinction to decide what may be injected (§28).
 */
export class TopicService {
  constructor(
    private topics: SqliteTopicStore,
    private conversations: SqliteConversationStore,
    private activity: SqliteActivityLogStore
  ) {}

  createTopic(input: CreateTopicInput): Topic {
    const topic = this.topics.createTopic(input);
    this.activity.info('topic.created', {
      message: topic.name,
      detail: { topicId: topic.id, slug: topic.slug, kind: topic.kind },
    });
    return topic;
  }

  listTopics(options: { status?: TopicStatus; limit?: number } = {}): TopicView[] {
    return this.topics.listTopics(options).map((topic) => {
      const conversations = this.topics.conversationsForTopic(topic.id, 500);
      return {
        ...topic,
        conversationCount: conversations.length,
        messageCount: conversations.reduce((sum, c) => sum + c.messageCount, 0),
      };
    });
  }

  getTopic(ref: string): TopicDetail {
    const topic = this.topics.resolve(ref);
    return { ...topic, conversations: this.topics.conversationsForTopic(topic.id) };
  }

  updateTopic(ref: string, patch: Partial<CreateTopicInput>): Topic {
    const before = this.topics.resolve(ref);
    const topic = this.topics.updateTopic(ref, patch);
    if (patch.status && patch.status !== before.status) {
      this.activity.info('topic.status_changed', {
        message: `${topic.name}: ${before.status} → ${topic.status}`,
        detail: { topicId: topic.id },
      });
    }
    return topic;
  }

  link(input: {
    conversationId: string;
    topicRef: string;
    source: 'user' | 'model' | 'heuristic';
    confidence?: number;
    evidence?: string | null;
  }): TopicLink {
    if (!this.conversations.getConversation(input.conversationId)) {
      throw new Error(`Conversation not found: ${input.conversationId}`);
    }
    const link = this.topics.link(input);
    this.activity.info('topic.linked', {
      conversationId: input.conversationId,
      message: `${this.topics.resolve(input.topicRef).name} (${input.source}, ${link.confidence})`,
      detail: { topicId: link.topicId, source: link.source, confidence: link.confidence },
    });
    return link;
  }

  unlink(conversationId: string, topicRef: string): boolean {
    const removed = this.topics.unlink(conversationId, topicRef);
    if (removed) {
      this.activity.info('topic.unlinked', {
        conversationId,
        detail: { topicRef },
      });
    }
    return removed;
  }

  topicsForConversation(conversationId: string) {
    return this.topics.topicsForConversation(conversationId);
  }

  /**
   * Associates a conversation with topics it appears to be about.
   *
   * Deterministic name and alias matching, so it costs nothing and can run on
   * every turn — the same reasoning that kept conversation titles free of an
   * LLM call (8.4). The result is stored as a heuristic link with matching
   * confidence, never as fact: a string match is evidence, not understanding,
   * and a later consumer can filter on that.
   *
   * An existing stronger link is never downgraded, so a person's correction
   * survives every subsequent turn.
   */
  autoAssociate(conversationId: string, text: string): TopicLink[] {
    if (!text?.trim()) return [];

    const candidates = suggestTopics(text, this.topics.listTopics({ limit: 500 }));
    const created: TopicLink[] = [];

    for (const { topic, confidence, evidence } of candidates.slice(0, 5)) {
      try {
        created.push(
          this.topics.link({
            conversationId,
            topicRef: topic.id,
            source: 'heuristic',
            confidence,
            evidence,
          })
        );
      } catch {
        // A conversation deleted mid-turn should not fail the turn.
      }
    }

    if (created.length > 0) {
      this.activity.info('topic.auto_associated', {
        conversationId,
        message: created.map((l) => l.topicId).join(', '),
        detail: { count: created.length },
      });
    }

    return created;
  }

  /**
   * Suggests without committing, for a caller that wants to ask first.
   */
  suggest(text: string) {
    return suggestTopics(text, this.topics.listTopics({ limit: 500 })).map((s) => ({
      topicId: s.topic.id,
      slug: s.topic.slug,
      name: s.topic.name,
      confidence: s.confidence,
      evidence: s.evidence,
    }));
  }

  deleteTopic(ref: string): boolean {
    const topic = this.topics.resolve(ref);
    const removed = this.topics.deleteTopic(ref);
    if (removed) {
      // Deleting a topic is a real loss of structure, so it is a warning.
      this.activity.warn('topic.deleted', {
        message: topic.name,
        detail: { topicId: topic.id },
      });
    }
    return removed;
  }
}

export { TopicNotFoundError };
