import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import { TopicService } from '../core/topic_service.js';
import { SearchService } from '../services/search.js';

/**
 * Topic tools.
 *
 * These let the model do what a conversation list cannot: pull together work
 * that spans threads. Creating and linking are WRITEs because they establish
 * durable structure that later retrieval will treat as authoritative.
 *
 * Note `source: 'model'` on the link tool. When the model judges that a
 * conversation belongs to a topic that is a stronger claim than a string
 * match but weaker than a person saying so, and it is stored as exactly that.
 */
export function createTopicTools(topics: TopicService, search?: SearchService): Tool[] {
  const tools: Tool[] = [
    {
      name: 'list_topics',
      description:
        'トピック（プロジェクトや継続的な話題）の一覧を返します。トピックは会話スレッドをまたいで存在します。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'paused', 'done', 'archived'] },
        },
      },
      async execute(args: any) {
        const list = topics.listTopics({ status: args?.status });
        return {
          count: list.length,
          topics: list.map((t) => ({
            slug: t.slug,
            name: t.name,
            kind: t.kind,
            status: t.status,
            conversations: t.conversationCount,
            messages: t.messageCount,
            lastActiveAt: t.lastActiveAt,
          })),
        };
      },
    },

    {
      name: 'get_topic',
      description:
        '特定トピックの詳細と、そのトピックに属する会話の一覧を返します。「あの件について今までに話したこと」を横断的に確認するために使います。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: { topic: { type: 'string', description: 'スラッグまたは ID。' } },
        required: ['topic'],
      },
      async execute(args: any) {
        const t = topics.getTopic(args.topic);
        return {
          slug: t.slug,
          name: t.name,
          description: t.description,
          kind: t.kind,
          status: t.status,
          aliases: t.aliases,
          conversations: t.conversations.map((c) => ({
            conversationId: c.conversationId,
            title: c.title,
            messages: c.messageCount,
            updatedAt: c.updatedAt,
            // Surfaced so the model can weigh a guess differently from a fact.
            linkedBy: c.link.source,
            confidence: c.link.confidence,
          })),
        };
      },
    },

    {
      name: 'create_topic',
      description:
        '新しいトピックを作成します。継続する仕事や話題に名前を与え、以後の会話を横断して紐付けられるようにします。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['project', 'subject', 'person', 'place', 'other'] },
          description: { type: 'string' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: '別名。会話中にこの語が現れたら自動で関連付けの候補になります。',
          },
        },
        required: ['name'],
      },
      async execute(args: any) {
        const topic = topics.createTopic({
          name: args.name,
          kind: args.kind ?? 'other',
          description: args.description ?? null,
          aliases: args.aliases ?? [],
        });
        return { slug: topic.slug, name: topic.name, kind: topic.kind };
      },
    },

    {
      name: 'link_conversation_to_topic',
      description:
        '現在の会話をトピックに関連付けます。会話の内容がそのトピックに属すると判断した場合に使用してください。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          topic: { type: 'string', description: 'スラッグまたは ID。' },
          reason: { type: 'string', description: 'そう判断した根拠。' },
        },
        required: ['conversationId', 'topic'],
      },
      async execute(args: any) {
        const link = topics.link({
          conversationId: args.conversationId,
          topicRef: args.topic,
          source: 'model',
          evidence: args.reason ?? null,
        });
        return { topicId: link.topicId, source: link.source, confidence: link.confidence };
      },
    },

    {
      name: 'suggest_topics_for_text',
      description:
        'テキストに含まれるトピック名・別名から、関連しそうなトピックを提案します。関連付けは行いません。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      async execute(args: any) {
        const suggestions = topics.suggest(args.text);
        return {
          count: suggestions.length,
          note: '文字列一致による候補です。確信度は上限0.6で、確定ではありません。',
          suggestions,
        };
      },
    },
  ];

  if (search) {
    tools.push({
      name: 'search_conversations',
      description:
        '過去の全会話から発言を検索します。「あの話どこでしたっけ」に答えるための手段です。' +
        'トピックに紐付いていない発言も見つかります。検索語は3文字以上必要です。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '検索する語句。3文字以上。' },
          limit: { type: 'number', description: '最大件数（既定20）。' },
          role: { type: 'string', enum: ['user', 'assistant'], description: '発言者で絞る。' },
        },
        required: ['query'],
      },
      async execute(args: any) {
        // Returned as a tool result rather than injected into every prompt:
        // sending whole conversations on each turn is ruled out by name in the
        // handoff, and a search costs a query instead of tokens.
        const result = search.search(String(args.query ?? ''), {
          limit: args.limit,
          role: args.role,
        });
        return {
          query: result.query,
          tooShort: result.tooShort,
          note: result.note,
          hits: result.hits.map((h) => ({
            conversationId: h.conversationId,
            title: h.conversationTitle,
            role: h.role,
            at: h.createdAt,
            snippet: h.snippet,
            topics: h.topics,
          })),
        };
      },
    });
  }

  return tools;
}
