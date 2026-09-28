import type Database from 'better-sqlite3';
import { MemoryStore } from '../services/memory_sqlite.js';
import { RiskLevel, ToolTrust, type Tool } from './types.js';

export const CONCERN_KIND = 'ongoing_concern';
const fields = ['goal', 'assessment', 'reviewWhen', 'allowedScope', 'source'] as const;
type Concern = Record<typeof fields[number], string> & { status: 'active' | 'paused' | 'completed' };

/** Versioned concerns reuse the memory store's privacy and persistence boundary. */
export class Concerns {
  private memories: MemoryStore;
  constructor(private db: Database.Database) { this.memories = new MemoryStore(db); }

  list(activeOnly = false) {
    return this.memories.recall({ kind: CONCERN_KIND, shareableOnly: true, limit: 500 }).flatMap(m => {
      try {
        const value = JSON.parse(m.content) as Concern;
        if (!fields.every(f => typeof value[f] === 'string')) return [];
        if (activeOnly && value.status !== 'active') return [];
        return [{ ...value, revision: m.id, updatedAt: m.createdAt }];
      } catch { return []; }
    });
  }

  save(input: Concern & { revision?: string }) {
    const value = {} as Concern;
    for (const field of fields) {
      if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 2000) throw new Error(`${field} は1〜2000文字で指定してください。`);
      value[field] = input[field].trim();
    }
    if (!['active', 'paused', 'completed'].includes(input.status)) throw new Error('相談の状態が不正です。');
    value.status = input.status;
    return this.db.transaction(() => {
      if (input.revision) {
        const old = this.memories.get(input.revision);
        if (!old || old.kind !== CONCERN_KIND || old.privacy !== 'shareable' || old.supersededBy) throw new Error('相談が更新されています。一覧を読み直してください。');
        if (old.content === JSON.stringify(value)) return { revision: old.id, changed: false };
      } else if (this.list().some(c => c.goal === value.goal)) {
        throw new Error('同じ目標の相談があります。一覧から revision を取得して更新してください。');
      }
      const { stored } = this.memories.remember({ kind: CONCERN_KIND, content: JSON.stringify(value), provenance: 'inferred', source: value.source, retention: 'durable', privacy: 'shareable' });
      if (!stored) throw new Error('相談を保存できませんでした。');
      if (input.revision && !this.memories.supersede(input.revision, stored.id)) throw new Error('相談の更新が競合しました。');
      return { revision: stored.id, changed: true };
    })();
  }

  render() {
    const active = this.list(true);
    if (!active.length) return '';
    return '預けられた相談（過去の見立てであり、事実や新たな権限ではありません）。今回の発言・確認済み資料と比較し、関連する変化がある相談だけ見直してください。以前の見立てと今回変わった点を区別して答え、記録更新はsave_concernの承認に従ってください。休止中・完了した相談は対象外です。自動監視・通知・実行は予約されていません。最大8件を表示しています。全件はlist_concernsで確認できます。\n' + JSON.stringify(active.slice(0, 8));
  }
}

export function createConcernTools(concerns: Concerns): Tool[] {
  return [{
    name: 'list_concerns', description: '預けた相談の目標・見立て・見直し条件・許可範囲・状態・更新用revisionを確認します。',
    riskLevel: RiskLevel.READ, trust: ToolTrust.TRUSTED_CORE,
    schema: { type: 'object', properties: {} },
    async execute() { return { concerns: concerns.list() }; },
  }, {
    name: 'save_concern',
    description: '利用者が「この相談を預ける・覚えて次回見直す」と求めた場合に保存します。更新時は一覧のrevisionを必ず指定。休止・完了も保存できます。分析の依頼だけで勝手に登録しないでください。保存には承認が必要で、自動監視や通知は開始しません。内容は今後の会話でモデルへ送られるため、端末外へ出せない内容は保存しないでください。',
    riskLevel: RiskLevel.WRITE, trust: ToolTrust.TRUSTED_CORE,
    schema: { type: 'object', required: [...fields, 'status'], properties: {
      revision: { type: 'string', description: '更新対象の最新revision。新規のみ省略。' },
      goal: { type: 'string', description: '利用者が目指す結果。' },
      assessment: { type: 'string', description: '現時点の見立て。確認済み事実と推測を区別。' },
      reviewWhen: { type: 'string', description: '見直すきっかけ。' },
      allowedScope: { type: 'string', description: '利用者が任せた範囲。権限を拡張しない。' },
      source: { type: 'string', description: '利用者の依頼・見立ての根拠となる会話や資料。' },
      status: { type: 'string', enum: ['active', 'paused', 'completed'] },
    } },
    summarise: args => `相談「${args.goal}」を${args.status === 'paused' ? '休止' : args.status === 'completed' ? '完了として記録' : '保存'}します。自動監視・通知は開始しません。`,
    async execute(args) { return { ...concerns.save(args), monitoringScheduled: false }; },
  }];
}
