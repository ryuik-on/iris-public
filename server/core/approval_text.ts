/**
 * 承認を求める画面の、人が読む文。
 *
 * 「この画面どうにかならん？人間が読む用の文章じゃない」（利用者、2026-09-30）。
 * 画面の本文には**道具の説明（模型に向けた取扱説明）**がそのまま出ていた ——
 * 「provenance は user / measured / inferred / external から選び…」。
 * 承認する人が知りたいのは道具の使い方ではなく、**IRIS がいま何をしようと
 * しているか**と、**それを許すと何が残るか。**
 *
 * だから道具ごとに、問い（見出し）と一文（本文）と、判断に要る事実だけを
 * 人の言葉で組む。元の説明と引数は消さずに「技術情報」の中へ回す（画面側）。
 *
 * 知らない道具は、**それらしい文を作らない。**名前と「何をするかは技術情報に」
 * とだけ言う —— 推測で書いた説明は、承認の判断を誤らせる。
 */

export interface ApprovalText {
  /** 問い。「覚えておきますか？」のように、はい／いいえで答えられる形。 */
  heading: string;
  /** 何が起きるかを一文で。中身は「」で括って見せる。 */
  summary: string;
  /** 判断に要る事実。空の値は出さない。 */
  facts: Array<{ label: string; value: string }>;
}

const PROVENANCE: Record<string, string> = {
  user: 'あなたが言ったこと',
  measured: 'IRIS が測って確かめたこと',
  inferred: 'IRIS の推測',
  external: '外部の資料に書いてあったこと',
};
const PRIVACY: Record<string, string> = {
  local_only: 'この機械の中だけ（模型にも外部にも出さない）',
  shareable: '会話の材料として使ってよい',
};
const RETENTION: Record<string, string> = {
  durable: 'ずっと',
  until: '期限まで',
  session: 'この会話のあいだだけ',
};
const OUTCOME: Record<string, string> = { worked: 'うまくいった', failed: '失敗した', partial: '一部うまくいった' };

const text = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).join('、');
  return String(v).trim();
};
const quote = (v: unknown, max = 80): string => {
  const s = text(v).replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
function facts(pairs: Array<[string, unknown]>): ApprovalText['facts'] {
  return pairs.map(([label, v]) => ({ label, value: text(v) })).filter((f) => f.value !== '');
}

export function describeApproval(toolName: string, args: any): ApprovalText {
  const a = args ?? {};
  switch (toolName) {
    case 'remember': {
      const until = a.retention === 'until' && a.expiresAt ? `（${String(a.expiresAt).slice(0, 10)} まで）` : '';
      return {
        heading: '覚えておきますか？',
        summary: `「${quote(a.content, 120)}」を IRIS の記憶に残します。次の会話からもこれを前提に話します。`,
        facts: facts([
          ['どこから', PROVENANCE[a.provenance] ?? a.provenance],
          ['根拠', a.source],
          ['見せる範囲', a.privacy ? PRIVACY[a.privacy] ?? a.privacy : ''],
          ['いつまで', a.retention ? `${RETENTION[a.retention] ?? a.retention}${until}` : ''],
        ]),
      };
    }
    case 'record_experience':
      return {
        heading: 'この経験を残しますか？',
        summary: `「${quote(a.attempt)}」が${OUTCOME[a.outcome] ?? 'どうだったか'}ことを記録します。次に同じことをする前に IRIS が思い出します。`,
        facts: facts([['状況', a.situation], ['次はどうするか', a.learned]]),
      };
    case 'record_development_decision':
      return {
        heading: '決まったこととして残しますか？',
        summary: `「${quote(a.decision, 120)}」を開発の決定として記録します。`,
        facts: facts([['課題', a.taskId], ['理由', a.rationale ?? a.reason]]),
      };
    case 'create_development_task':
      return {
        heading: '開発タスクを登録しますか？',
        summary: `「${quote(a.title)}」を開発タスクとして登録します。作業はまだ始めません。`,
        facts: facts([['目的', a.goal], ['完了の条件', a.successCriteria], ['リポジトリ', a.repo]]),
      };
    case 'start_coding_agent':
      return {
        heading: '作業を任せて始めますか？',
        summary: `「${quote(a.title)}」をコーディングエージェントに任せ、いまから作業を始めます。`,
        facts: facts([
          ['目的', a.goal],
          ['完了の条件', a.successCriteria],
          ['守ること', a.constraints],
          ['リポジトリ', a.repo],
          ['ネットワーク', a.needsNetwork === true ? '使う' : a.needsNetwork === false ? '使わない' : ''],
        ]),
      };
    case 'write_file':
      return {
        heading: 'ファイルを書き換えますか？',
        summary: `${quote(a.path)} に書き込みます。すでにある場合は中身が置き換わります。`,
        facts: facts([['書く内容', quote(a.content, 200)]]),
      };
    case 'delete_file':
      return {
        heading: 'ファイルを消しますか？',
        summary: `${quote(a.path)} を消します。元に戻せないことがあります。`,
        facts: [],
      };
    case 'create_topic':
      return {
        heading: '話題を作りますか？',
        summary: `「${quote(a.name)}」という話題を作り、関係する会話をまとめられるようにします。`,
        facts: facts([['説明', a.description]]),
      };
    case 'link_conversation_to_topic':
      return {
        heading: 'この会話を話題にまとめますか？',
        summary: `この会話を「${quote(a.topic)}」の話題に入れます。`,
        facts: facts([['理由', a.reason]]),
      };
    case 'add_future_feature':
      return {
        heading: '「あとでやること」に入れますか？',
        summary: `「${quote(a.title)}」を、いまはやらないこととして記録します。`,
        facts: facts([['理由', a.reason], ['見直す条件', a.resumeCondition], ['優先度', a.priority]]),
      };
    case 'mark_feature_reviewed':
      return {
        heading: '見直し済みにしますか？',
        summary: `「${quote(a.key)}」を見直した、と記録します。`,
        facts: facts([['結論', a.note]]),
      };
    default:
      return {
        heading: 'この操作を実行しますか？',
        summary: `IRIS が「${toolName}」を実行しようとしています。何をするかは下の技術情報にあります。`,
        facts: [],
      };
  }
}
