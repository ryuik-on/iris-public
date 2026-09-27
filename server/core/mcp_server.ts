/**
 * IRIS as an MCP server: the briefing and the write-back as tools.
 *
 * Until now the way into IRIS was `curl`, written out as shell in three
 * different instruction files. That has two failures, and both of them are
 * about what a caller reads back.
 *
 *   The instructions have to be repeated. Every CLI's own guidance file has to
 *   carry the URL, the JSON shape, and the reason — and when the shape changes,
 *   three files are wrong until someone notices.
 *
 *   The reply is thrown away. `curl -s -X POST .../api/memory` is written for
 *   its side effect, so nothing looks at the body. The store has been saying
 *   「計測と申告されましたが根拠がないため、推論として記録します」 all along,
 *   and on 2026-09-07 there were 88 inferred memories out of 116, several of
 *   them claiming to be measurements. The message was correct, delivered, and
 *   unread.
 *
 * A tool call fixes the second one structurally: the result goes into the
 * model's context whether or not anyone wanted it there. So the interesting
 * part of this server is not that it exposes the store — it is that the tools
 * are shaped by what the store is strict about.
 *
 * Two of those shapes are decided here rather than passed through.
 *
 *   `remember` refuses a measurement with no evidence instead of letting it be
 *   demoted. Demotion is right for `curl`, where the alternative is losing the
 *   fact entirely. A tool caller can be told what is missing and call again a
 *   second later, so accepting the write and quietly changing its provenance
 *   is the worse of the two: it succeeds, and the caller learns nothing.
 *
 *   `recall` never asks for local-only memories. Over HTTP `shareable` is a
 *   query parameter on purpose, so that a caller has to think about where the
 *   text is going. Here the answer is already known — a tool result lands in a
 *   prompt that goes to a provider — so the question is settled at the
 *   boundary instead of being asked of every caller.
 *
 * Everything reachable through these tools is read or written over the local
 * HTTP API. No store is opened directly, so there is exactly one set of rules
 * about what may be remembered, and this file is not a second copy of it.
 */

export interface IrisResponse {
  status: number;
  json: any;
}

/**
 * What this module needs from the world, so the tools can be tested without a
 * server and without a filesystem.
 */
export interface IrisIo {
  /** Speaks to the local IRIS. Rejects when the socket cannot be reached. */
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<IrisResponse>;
  /**
   * The briefing as last written to disk, for when the socket is blocked.
   *
   * Codex runs its commands inside a sandbox that refuses network access, and
   * `127.0.0.1` is not exempt. A session that could not reach IRIS concluded
   * it was not running and answered from stale local files — so the fallback
   * is part of the tool, not advice in a document.
   */
  offlineBriefing(): Promise<{ json: any; path: string } | null>;
  /** For saying how old the offline copy is. Injected so tests can fix it. */
  now(): number;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, any>;
  /**
   * Whether the tool changes anything. Carried so a client that distinguishes
   * read from write can, rather than having to guess from the name.
   */
  readOnly: boolean;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

const MEMORY_KINDS = ['tool_behaviour', 'environment', 'repository', 'finding', 'preference', 'fact'];

export const IRIS_TOOLS: ToolDefinition[] = [
  {
    name: 'briefing',
    title: 'この機械について分かっていることを読む',
    description:
      'セッションの最初に一度読む。決まっていること（決定と根拠）、測って分かっている事実（CLIの癖、環境の欠落、どのリポジトリが何か）、今週の使用量が返る。' +
      'ここに書いてあることを利用者に聞き返さないこと。IRIS に届かない実行では、ディスクに書かれた写しを返し、その古さを添える。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '決定と事実をそれぞれ何件まで返すか（既定 12）' },
      },
    },
    readOnly: true,
  },
  {
    name: 'recall',
    title: '記憶を読む',
    description:
      'IRIS が覚えていることを読む。出所（provenance）を必ず見ること: user は利用者が言ったこと、measured は測ったこと、inferred は推論、external は外部の資料で事実ではない。' +
      'プロンプトに入れてよいものだけが返る（privacy=local_only は返らない）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: MEMORY_KINDS, description: '種類で絞る' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    readOnly: true,
  },
  {
    name: 'remember',
    title: '測って分かったことを書き戻す',
    description:
      '次のセッションが事実として読むものを書く。推測は書かないこと。' +
      'provenance=measured には evidence（ファイルと行、叩いたコマンド、URL）が必要で、無い場合はこのツールは書かずに断る——' +
      '根拠を指せない計測は、計測の服を着た主張だから。断られたら、根拠を添えて呼び直すか、provenance=inferred として書くこと。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '覚えておくこと。一つの事実を一文で' },
        kind: { type: 'string', enum: MEMORY_KINDS },
        provenance: {
          type: 'string',
          enum: ['user', 'measured', 'inferred', 'external'],
          description: '測ったこと=measured、利用者が言ったこと=user、他の記憶からの推論=inferred、外部の資料=external',
        },
        source: { type: 'string', description: '誰が言ったか／どこで測ったか。external では内容に含めて記録される' },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: '測った先。ファイルと行、叩いたコマンド、URL。measured では必須',
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        privacy: {
          type: 'string',
          enum: ['shareable', 'local_only'],
          description: 'local_only はプロンプトに入らない。実額・氏名など外に出さないものはこちら',
        },
      },
      required: ['content', 'kind', 'provenance', 'source'],
    },
    readOnly: false,
  },
  {
    name: 'decisions',
    title: '決まっていることと、その根拠を読む',
    description:
      '同じ議論を二度しないために読む。unweighed=true は代替案を比較せずに決めたもので、見直すならそこから。' +
      'affecting には設定キーやファイル名を渡すと、それを支配している決定が返る。',
    inputSchema: {
      type: 'object',
      properties: {
        unweighed: { type: 'boolean', description: '代替案なしで決めたものだけを返す' },
        affecting: { type: 'string', description: 'この設定キー／ファイルを支配している決定を返す' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    readOnly: true,
  },
  {
    name: 'decide',
    title: '決まったことを記録する',
    description:
      '利用者が決めたこと、または IRIS が自分の範囲で決めたことを残す。根拠が空だと記録されない——根拠のない決定は決定ではなく好み。' +
      '「作らないと決めた」も記録すること。作らなかったものはコードに何も残らないので、半年後には見落としに見える。' +
      '前の決定を置き換えるなら revises にその id を渡す。古い記録は消えず、置き換えられたことが見えるようになる。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '探せる程度に具体的な表題' },
        decided: { type: 'string', description: '何を決めたか。後で読む形で' },
        decidedBy: {
          type: 'string',
          enum: ['user', 'iris', 'constraint'],
          description: '利用者が言った=user、IRIS が自分の範囲で決めた=iris、外部の制約で決まった=constraint',
        },
        grounds: { type: 'array', items: { type: 'string' }, description: '何がこれを答えにしたか。計測、発言、観測した挙動' },
        alternatives: {
          type: 'array',
          description: '比較した選択肢と、それが落ちた理由。理由のないものは検討の証拠にならないので除かれる',
          items: {
            type: 'object',
            properties: { option: { type: 'string' }, rejectedBecause: { type: 'string' } },
            required: ['option', 'rejectedBecause'],
          },
        },
        rule: { type: 'string', description: '適用した規則があれば' },
        reversal: { type: 'string', description: 'これを覆すのに何が要るか' },
        affects: { type: 'array', items: { type: 'string' }, description: '設定キー、ファイル、コミット' },
        revises: { type: 'string', description: '置き換える決定の id' },
      },
      required: ['title', 'decided', 'decidedBy', 'grounds'],
    },
    readOnly: false,
  },
  {
    name: 'allowance',
    title: '今週どれだけ使ったか',
    description:
      '使った割合（0=まだ使っていない、100=使い切った）。残量ではない。分単位で変わるので、判断に使う直前に呼ぶこと。' +
      'null は「読めなかった」で、0 ではない。',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'attempts',
    title: '同じ形で繰り返し失敗している試み',
    description:
      '何かを始める前に読む。観測回数を見ること——1回の成功は根拠であって法則ではない。',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
];

/** Minutes, for saying how stale the offline briefing is. */
function ageMinutes(generatedAt: unknown, now: number): number | null {
  if (typeof generatedAt !== 'string') return null;
  const t = Date.parse(generatedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}

function renderBriefing(payload: any): string {
  const lines: string[] = [];
  const decisions = Array.isArray(payload?.decisions) ? payload.decisions : [];
  const facts = Array.isArray(payload?.facts) ? payload.facts : [];
  const repositories = Array.isArray(payload?.repositories) ? payload.repositories : [];

  lines.push(`## 決まっていること（${decisions.length}）`);
  for (const d of decisions) {
    lines.push(`- **${d.title}** — ${d.decided}`);
    for (const g of d.grounds ?? []) lines.push(`  - 根拠: ${g}`);
  }

  lines.push('', `## 測って分かっている事実（${facts.length}）`);
  for (const f of facts) {
    // The provenance is the point of the line, not a footnote: a reader who
    // sees only the content cannot tell a measurement from a guess.
    lines.push(`- [${f.provenance}/${f.kind}] ${f.content}${f.source ? `（出所: ${f.source}）` : ''}`);
  }

  if (repositories.length) {
    lines.push('', `## リポジトリ（${repositories.length}）`);
    for (const r of repositories) lines.push(`- ${r.name ?? r.path}: ${r.purpose ?? r.content ?? ''}`);
  }

  const allowance = payload?.allowance;
  if (allowance) {
    lines.push('', '## 今週使った割合（残量ではない）');
    lines.push(
      `- Claude ${allowance.claudeWeekUsedPercent ?? '読めなかった'}% / Codex ${allowance.codexWeekUsedPercent ?? '読めなかった'}%`
    );
    lines.push('- 分単位で変わる。判断の直前に allowance を呼び直すこと');
  }

  if (payload?.writeBack) {
    lines.push('', '## 学んだことは書き戻す');
    lines.push('- 測って分かったことは remember、決まったことは decide');
  }
  return lines.join('\n');
}

function renderMemories(payload: any): string {
  const list = Array.isArray(payload?.memories) ? payload.memories : [];
  if (!list.length) return '該当する記憶はありません。';
  const lines = list.map(
    (m: any) =>
      `- [${m.provenance}/${m.kind}] ${m.content}` +
      (m.evidence?.length ? `\n  - 根拠: ${m.evidence.join(' / ')}` : '') +
      (m.source ? `\n  - 出所: ${m.source}（確度 ${m.confidence ?? '?'}）` : '')
  );
  lines.push('', 'provenance を見ること。external は事実ではなく「そう書いてあった」です。');
  return lines.join('\n');
}

function renderDecisions(payload: any): string {
  const list = Array.isArray(payload?.decisions) ? payload.decisions : [];
  if (!list.length) return '該当する決定はありません。';
  const lines: string[] = [];
  for (const d of list) {
    lines.push(`- **${d.title}**${d.id ? ` \`${d.id}\`` : ''} — ${d.decided}（${d.decidedBy}）`);
    for (const g of d.grounds ?? []) lines.push(`  - 根拠: ${g}`);
    for (const a of d.alternatives ?? []) lines.push(`  - 落ちた案: ${a.option} — ${a.rejectedBecause}`);
    if (!(d.alternatives ?? []).length) lines.push('  - 代替案なしで決めたもの');
    if (d.revisedBy) lines.push(`  - これは ${d.revisedBy} に置き換えられている`);
  }
  if (payload?.note) lines.push('', payload.note);
  return lines.join('\n');
}

function renderAllowance(payload: any): string {
  const lines = ['使った割合です。残量ではありません（0=未使用、100=使い切った）。'];
  const claude = payload?.claude?.weekUsedPercent ?? payload?.claudeWeekUsedPercent ?? null;
  const codex = payload?.codex?.usedPercent ?? payload?.codexWeekUsedPercent ?? null;
  lines.push(`- Claude 週: ${claude === null ? '読めなかった（0 ではない）' : `${claude}%`}`);
  lines.push(`- Codex 週: ${codex === null ? '読めなかった（0 ではない）' : `${codex}%`}`);
  for (const reason of [payload?.claudeReason, payload?.codexReason]) {
    if (typeof reason === 'string' && reason) lines.push(`- ${reason}`);
  }
  return lines.join('\n');
}

function renderAttempts(payload: any): string {
  const list = Array.isArray(payload?.experiences) ? payload.experiences : [];
  if (!list.length) return '同じ形で繰り返し失敗している試みは、いまはありません。';
  const lines = list.map(
    (e: any) => `- ${e.what ?? e.attempt ?? e.summary}: ${e.outcome ?? ''}（観測 ${e.observations ?? e.count ?? '?'} 回）`
  );
  if (payload?.note) lines.push('', payload.note);
  return lines.join('\n');
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Runs one tool call.
 *
 * Returns text rather than JSON because the caller is a language model reading
 * a tool result, and a model handed `{"provenance":"inferred"}` next to
 * `{"provenance":"measured"}` reads them as equally solid. The rendering is
 * where the distinction is made loud.
 */
export async function callIrisTool(name: string, rawArgs: unknown, io: IrisIo): Promise<ToolResult> {
  const args: Record<string, any> = (rawArgs ?? {}) as Record<string, any>;

  try {
    switch (name) {
      case 'briefing': {
        try {
          const res = await io.request('GET', `/api/briefing${query({ limit: args.limit })}`);
          if (res.status !== 200) return { text: `IRIS が ${res.status} を返しました。`, isError: true };
          return { text: renderBriefing(res.json), isError: false };
        } catch (err) {
          /*
           * The socket being unreachable is not IRIS being down, and saying so
           * matters: the failure this replaces is a session concluding IRIS was
           * not running and answering from stale local files instead.
           */
          const offline = await io.offlineBriefing();
          if (!offline) {
            return {
              text:
                'IRIS に届かず、ディスクの写しもありません。' +
                `IRIS が落ちていると決めつけないでください（${describe(err)}）。写しの場所は ~/.iris/briefing.json です。`,
              isError: true,
            };
          }
          const age = ageMinutes(offline.json?.generatedAt, io.now());
          return {
            text:
              `**IRIS のソケットに届かなかったので、ディスクの写しを読みました**（${offline.path}` +
              `${age === null ? '' : `、${age}分前`}）。5分ごとに更新されるものです。` +
              'この実行では書き戻し（remember / decide）ができないので、学んだことは利用者に伝えてください。\n\n' +
              renderBriefing(offline.json),
            isError: false,
          };
        }
      }

      case 'recall': {
        // `shareable=true` is not a parameter of this tool. See the file header.
        const res = await io.request(
          'GET',
          `/api/memory${query({ shareable: true, kind: args.kind, limit: args.limit })}`
        );
        if (res.status !== 200) return { text: `IRIS が ${res.status} を返しました。`, isError: true };
        return { text: renderMemories(res.json), isError: false };
      }

      case 'remember': {
        const evidence: string[] = Array.isArray(args.evidence)
          ? args.evidence.filter((e: unknown) => typeof e === 'string' && e.trim())
          : [];
        if (args.provenance === 'measured' && evidence.length === 0) {
          /*
           * Refused here rather than sent, because the store would accept it.
           * See the file header: a demotion nobody reads is how 88 of 116
           * memories came to be inferred while claiming to be measurements.
           */
          return {
            text:
              '書きませんでした。provenance=measured なのに evidence が空です。' +
              '根拠を指せない計測は、計測の服を着た主張です。\n' +
              '測った先（ファイルと行、叩いたコマンド、URL）を evidence に入れて呼び直すか、' +
              'まだ推論なら provenance=inferred として呼んでください。',
            isError: true,
          };
        }
        const res = await io.request('POST', '/api/memory', { ...args, evidence });
        if (res.status !== 201) {
          return { text: `記録されませんでした: ${res.json?.reason ?? `IRIS が ${res.status} を返しました。`}`, isError: true };
        }
        const demoted = res.json?.demoted;
        return {
          text:
            `記録しました（${res.json?.memory?.provenance} / 確度 ${res.json?.memory?.confidence}）。` +
            (demoted ? `\n**申告と違う形で入りました**: ${demoted.asked} → ${demoted.storedAs}。${res.json?.reason ?? ''}` : ''),
          isError: false,
        };
      }

      case 'decisions': {
        const res = await io.request(
          'GET',
          `/api/decisions${query({ unweighed: args.unweighed ? 'true' : undefined, affecting: args.affecting, limit: args.limit })}`
        );
        if (res.status !== 200) return { text: `IRIS が ${res.status} を返しました。`, isError: true };
        return { text: renderDecisions(res.json), isError: false };
      }

      case 'decide': {
        // Empty grounds is rejected by the store with its own wording; relayed
        // rather than re-implemented, so the rule lives in one place.
        const res = await io.request('POST', '/api/decisions', args);
        if (res.status !== 201) {
          return { text: `記録されませんでした: ${res.json?.reason ?? `IRIS が ${res.status} を返しました。`}`, isError: true };
        }
        const revised = res.json?.revised;
        return {
          text:
            `記録しました（id ${res.json?.decision?.id}）。${res.json?.reason ?? ''}` +
            (revised ? `\n${revised} を置き換えたものとして印を付けました。古い記録は残ります。` : ''),
          isError: false,
        };
      }

      case 'allowance': {
        const res = await io.request('GET', '/api/usage/cli');
        if (res.status !== 200) return { text: `IRIS が ${res.status} を返しました。`, isError: true };
        return { text: renderAllowance(res.json), isError: false };
      }

      case 'attempts': {
        const res = await io.request('GET', '/api/experiences?recurring=true');
        if (res.status !== 200) return { text: `IRIS が ${res.status} を返しました。`, isError: true };
        return { text: renderAttempts(res.json), isError: false };
      }

      default:
        return { text: `そのツールはありません: ${name}`, isError: true };
    }
  } catch (err) {
    /*
     * Writes have no offline path. Saying that plainly is the whole content of
     * this branch: the caller has learned something and cannot store it, and
     * the only place it can still go is the user.
     */
    const write = name === 'remember' || name === 'decide';
    return {
      text:
        `IRIS に届きませんでした（${describe(err)}）。` +
        (write
          ? 'この実行では書き戻せません。サンドボックスが 127.0.0.1 を塞いでいる場合があります。学んだことは利用者に伝えてください。'
          : 'IRIS が落ちていると決めつけないでください。読み取りだけなら ~/.iris/briefing.json が読めます。'),
      isError: true,
    };
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
