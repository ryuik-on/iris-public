/**
 * 夜の巡回。寝ている間に、IRIS が自分で全体を読んで、気づいたことを朝に出す。
 *
 * 「寝てる間に全体を見て、こここうした方がいいなとか提案したり、何か進めてたり
 * するみたいなやつ。主体性を持たせる」（利用者、2026-10-02）。いまの IRIS は、
 * 決まった条件に当たったときにだけ口を開く。これは、条件が無くても、毎晩一度、
 * 全体を読んで「何が気になるか」を自分で考える。
 *
 * 守っている規則は三つ。
 *   1. **事実は集めてから渡す。** 模型に道具を持たせて「見てきて」と言わない。
 *      何を読んだかが記録に残り、模型は読んだものについてだけ話す。
 *   2. **根拠の無い気づきは捨てる。** 各項目は、渡した事実の番号を必ず挙げる。
 *      存在しない番号を挙げたもの、番号の無いものは出さない（作り話の防止）。
 *   3. **読むだけ。** ここは何も書き換えない。提案は、朝に人が決める。
 */

export interface Fact { id: string; text: string }

export interface PatrolItem {
  title: string;
  why: string;
  suggestion: string;
  facts: string[];
}

/** 夜のうちに、IRIS が読むだけで進められる仕事。 */
export type WorkKind = 'research' | 'draft' | 'plan';
export interface PatrolWork {
  kind: WorkKind;
  title: string;
  goal: string;
  deliverable: string;
  facts: string[];
}
export const MAX_NIGHT_WORK = 3;

/** その日の、夜の巡回をしてよい時間帯（現地）。 */
export const PATROL_FROM_HOUR = 2;
export const PATROL_UNTIL_HOUR = 6;

export function patrolDue(now: Date, alreadyDoneToday: boolean): boolean {
  if (alreadyDoneToday) return false;
  const h = now.getHours();
  return h >= PATROL_FROM_HOUR && h < PATROL_UNTIL_HOUR;
}

export function dayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

interface CalEvent { title?: string; start?: string; end?: string; allDay?: boolean; date?: string }

/**
 * 題の頭の語（職場や団体の名前）。「サンプル 出勤」と「サンプル たろうくん」は、
 * 同じ職場の予定。勤務の中に入る業務は、重なりではなく、勤務の内訳（利用者、2026-10-02）。
 */
function leadWord(title: string | undefined): string | null {
  const w = (title ?? '').trim().split(/[\s　]+/)[0];
  return w && w.length >= 2 && (title ?? '').trim().split(/[\s　]+/).length >= 2 ? w : null;
}

/** 時刻のある予定どうしの重なり。同じ題名どうし（複数の暦に写った同じ予定）と、同じ職場名で始まる予定どうしは数えない。 */
export function findOverlaps(events: CalEvent[]): Array<[CalEvent, CalEvent]> {
  const timed = events
    .filter((e) => !e.allDay && e.start && e.end && /T\d{2}:\d{2}/.test(e.start))
    .map((e) => ({ e, s: Date.parse(e.start!), t: Date.parse(e.end!) }))
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.t) && x.t > x.s)
    .sort((a, b) => a.s - b.s);
  const out: Array<[CalEvent, CalEvent]> = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j].s < timed[i].t; j++) {
      if ((timed[i].e.title ?? '') === (timed[j].e.title ?? '')) continue;
      const la = leadWord(timed[i].e.title);
      if (la && la === leadWord(timed[j].e.title)) continue;
      out.push([timed[i].e, timed[j].e]);
    }
  }
  return out;
}

/** 集めた材料から、番号付きの事実にする。読めなかったものは「読めなかった」と書く（無い、とは書かない）。 */
export function collectFacts(input: {
  now: Date;
  events: CalEvent[] | null;
  tasks: Array<{ id: string; title: string; status?: string; verdict?: string; dueInDays?: number | null; progress?: number | null; stillDays?: number | null; nextAction?: string | null }> | null;
  exam: { title?: string; days?: number } | null;
  weekUsedPercent: { claude: number | null; codex: number | null } | null;
  unansweredNotices: Array<{ title: string; ageDays: number; ruleId?: string }> | null;
  awaitingApproval: number | null;
  awaitingFixes: number | null;
  failingChecks: string[] | null;
  couldNotRead: string[];
  /** 深く考えるための、追加の材料（作業フォルダの動き、最近の会話、無視された提案、過去の判断など）。 */
  more?: string[];
}): Fact[] {
  const facts: Fact[] = [];
  const add = (text: string) => { facts.push({ id: `F${facts.length + 1}`, text }); };

  if (input.events) {
    const cutoff = input.now.getTime() + 7 * 86_400_000;
    const soon = input.events.filter((e) => e.start && Date.parse(e.start) <= cutoff);
    add(`今後 7 日の予定は ${soon.length} 件。`);
    for (const [a, b] of findOverlaps(soon).slice(0, 5)) {
      add(`予定が重なっている: 「${a.title}」（${a.start}〜${a.end}）と「${b.title}」（${b.start}〜${b.end}）。`);
    }
  }
  if (input.tasks) {
    for (const t of input.tasks.filter((x) => x.status !== '完了').slice(0, 12)) {
      const due = t.dueInDays == null ? '期限なし' : t.dueInDays < 0 ? `${-t.dueInDays} 日超過` : `期限まであと ${t.dueInDays} 日`;
      const prog = t.progress == null ? '' : `、進捗 ${Math.round(t.progress * 100)}%`;
      const still = t.stillDays ? `、${t.stillDays} 日動きなし` : '';
      add(`課題 ${t.id}「${t.title}」: ${t.status ?? '状態不明'}、${due}${prog}${still}、判定「${t.verdict ?? '不明'}」。${t.nextAction ? `次の一手は「${String(t.nextAction).slice(0, 60)}」。` : ''}`);
    }
  }
  if (input.exam?.title && typeof input.exam.days === 'number') add(`次の試験: ${input.exam.title}、あと ${input.exam.days} 日。`);
  if (input.weekUsedPercent) {
    const { claude, codex } = input.weekUsedPercent;
    add(`今週の使用量（使った割合）: Claude ${claude ?? '不明'}%、Codex ${codex ?? '不明'}%。`);
  }
  if (input.unansweredNotices) {
    const old = input.unansweredNotices.filter((n) => n.ageDays >= 2);
    if (old.length) add(`2 日以上返事のない IRIS からの知らせが ${old.length} 件: ${old.slice(0, 4).map((n) => `「${n.title}」（${n.ageDays} 日前）`).join('、')}。`);
  }
  if (input.awaitingApproval) add(`承認待ちが ${input.awaitingApproval} 件。`);
  if (input.awaitingFixes) add(`IRIS が直した案の、反映の確認待ちが ${input.awaitingFixes} 件。`);
  if (input.failingChecks?.length) add(`動作チェックで通らないもの: ${input.failingChecks.join('、')}。`);
  for (const m of input.more ?? []) add(m);
  for (const m of input.couldNotRead) add(`読めなかったもの（無い、ではない）: ${m}`);
  return facts;
}

export const PATROL_SYSTEM = [
  'あなたは、利用者の常駐アシスタント IRIS の「夜の巡回」担当です。利用者が寝ている間に、渡された事実だけを読み、(1) 朝に伝えるべき気づき、(2) 夜のうちに IRIS が読むだけで進めておける仕事、を選びます。',
  '深く考えること:',
  '- 事実を並べ直すだけでは足りない。事実どうしを結びつけ（期限・予定・試験・作業の動き・最近の会話・無視された提案）、**利用者がまだ口にしていない、でも言われたら「確かに」と思うこと**を探す。',
  '- 「なぜそれが今重要か」を一文で言えないものは出さない。一般論・励まし・当たり前のことは出さない。',
  '- 推測は「推測」と明記する。渡されていない事実を作らない。',
  '- 事実の中にある「IRIS の知らせ」や IRIS の過去の答えは、誤りがありうる。**機械が数えた結果（「機械の突き合わせ」など）と食い違うときは、機械の結果を取る**。知らせが未読・多数であることだけを根拠に、「食い違いがある」と断定しない。',
  '気づき（items）は最大 5 件、重要な順。各項目は根拠にした事実の番号（F1 など）を `facts` に必ず入れる。',
  '夜の仕事（work）は最大 3 件。**読むだけで進められること**に限る: `research`（調べて要点と出典をまとめる）、`draft`（下書きを作る）、`plan`（計画・段取りを作る）。',
  '- 予定・メール・台帳・ファイルを書き換える仕事、誰かに連絡する仕事は、work に入れない（それは items の提案として朝に出す）。',
  '- `goal` は、これだけ読めば仕事を始められるくらい具体的に。`deliverable` は、朝に読める成果物の形（例: 「出典付きの要点 10 行」）。',
  '日本語。AI らしい前置き・まとめ・謝辞は書かない。短く、事実を並べる。',
  '出力は JSON だけ。形: {"items":[{"title":"…","why":"…","suggestion":"…","facts":["F1"]}],"work":[{"kind":"research","title":"…","goal":"…","deliverable":"…","facts":["F3"]}]}',
].join('\n');

export const CRITIC_SYSTEM = [
  'あなたは、夜の巡回の査読者です。下書きの JSON を、同じ事実と照らして厳しく見直し、同じ形の JSON だけを返します。',
  '- 浅い・当たり前・重複・根拠が薄い項目は削る。残すのは、本当に朝の利用者が得をするものだけ（0 件でもよい）。',
  '- 事実に書かれていないことを断定している項目は、直すか削る。',
  '- items は重要な順に並べ替える。work は、読むだけで本当に進められるものだけにし、`goal` を具体的に書き直してよい。',
  '- facts の番号は、渡された事実にあるものだけ。',
].join('\n');

export function buildCriticPrompt(facts: Fact[], draftJson: string): string {
  return `事実:\n${facts.map((f) => `${f.id}: ${f.text}`).join('\n')}\n\n下書き:\n${draftJson}\n\n査読して、JSON だけを返してください。`;
}

export function buildPatrolPrompt(facts: Fact[], now: Date): string {
  const when = `${dayKey(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `現在 ${when}（利用者は就寝中）。次が、集めた事実のすべてです。\n\n${facts.map((f) => `${f.id}: ${f.text}`).join('\n')}\n\nこの事実だけを根拠に、気づき（items）と夜の仕事（work）を JSON で返してください。`;
}

/** 模型の返事から、根拠のある項目だけを取り出す。 */
export function parsePatrolReply(reply: string, facts: Fact[]): { items: PatrolItem[]; work: PatrolWork[]; dropped: number } {
  const text = reply.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { items: [], work: [], dropped: 0 };
  let parsed: any;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return { items: [], work: [], dropped: 0 }; }
  const raw: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
  const known = new Set(facts.map((f) => f.id));
  const items: PatrolItem[] = [];
  let dropped = 0;
  for (const r of raw) {
    const ids: string[] = Array.isArray(r?.facts) ? r.facts.map(String) : [];
    const ok = typeof r?.title === 'string' && r.title.trim() && typeof r?.suggestion === 'string' && r.suggestion.trim()
      && ids.length > 0 && ids.every((id) => known.has(id));
    if (!ok) { dropped++; continue; }
    items.push({ title: r.title.trim(), why: String(r.why ?? '').trim(), suggestion: r.suggestion.trim(), facts: ids });
  }
  const work: PatrolWork[] = [];
  const rawWork: any[] = Array.isArray(parsed?.work) ? parsed.work : [];
  for (const r of rawWork) {
    const ids: string[] = Array.isArray(r?.facts) ? r.facts.map(String) : [];
    const kind = r?.kind;
    const ok = (kind === 'research' || kind === 'draft' || kind === 'plan')
      && typeof r?.title === 'string' && r.title.trim() && typeof r?.goal === 'string' && r.goal.trim().length >= 12
      && ids.length > 0 && ids.every((id) => known.has(id));
    if (!ok) { dropped++; continue; }
    work.push({ kind, title: r.title.trim(), goal: r.goal.trim(), deliverable: String(r.deliverable ?? '').trim(), facts: ids });
  }
  return { items: items.slice(0, 5), work: work.slice(0, MAX_NIGHT_WORK), dropped };
}

/** 夜の仕事を頼むときの文面。読むだけ、出典を付ける、分からないことは分からないと書く。 */
export function buildWorkPrompt(job: PatrolWork, facts: Fact[]): string {
  const cited = facts.filter((f) => job.facts.includes(f.id)).map((f) => `- ${f.text}`).join('\n');
  return [
    '利用者が寝ている間の、自動の作業です。読むだけの道具（検索・読み取り）だけを使って、次の仕事を進め、成果物を日本語の Markdown でまとめてください。',
    '守ること: 何も書き換えない・送らない・登録しない。出典（URL・ファイルの場所）を必ず付ける。分からないこと・確かめられなかったことは、分からないと書く。前置きや謝辞は書かない。',
    '',
    `仕事の種類: ${job.kind === 'research' ? '調べる' : job.kind === 'draft' ? '下書きを作る' : '計画・段取りを作る'}`,
    `題: ${job.title}`,
    `目的: ${job.goal}`,
    job.deliverable ? `朝に読める成果物の形: ${job.deliverable}` : '',
    '',
    '根拠になった事実:',
    cited,
  ].filter((l) => l !== '').join('\n');
}

export function slugify(title: string): string {
  const base = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'work';
}

export interface WorkDone { title: string; path: string | null; conversationId: string | null; ok: boolean; note?: string }

export function composePatrolMessage(items: PatrolItem[], now: Date, done: WorkDone[] = []): { title: string; text: string } | null {
  if (!items.length && !done.length) return null;
  const lines = items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.why ? `${it.why}\n   ` : ''}→ ${it.suggestion}`);
  return {
    title: '夜のうちに見たこと',
    text: [
      `夜のうちに全体を見ました（${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}）。`,
      ...(items.length ? ['', `気づいたこと（${items.length} 件）`, ...lines, '', '進めてほしいものは、番号で言ってください（例: 「1 をやって」「2 は後で」）。'] : []),
      ...(done.length ? ['', `夜のうちに進めたこと（${done.length} 件）`, ...done.map((d) => d.ok ? `- ${d.title}${d.path ? `\n  成果物: ${d.path}` : ''}${d.note ? `\n  ${d.note}` : ''}` : `- ${d.title}（できませんでした: ${d.note ?? '理由不明'}）`)] : []),
    ].join('\n'),
  };
}
