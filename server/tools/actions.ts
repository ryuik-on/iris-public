import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Tool, RiskLevel, ToolTrust } from '../core/types.js';

/**
 * IRIS が「動かす」道具。どれも実行前に承認画面を通る。
 *
 * 利用者が渡すと決めたもの（2026-10-01）：カレンダーの予定の作成・変更、
 * アプリや URL を開くこと、ホームの中へのファイルの書き込み（`filesystem.ts`）。
 *
 * 予定の編集と削除は、2026-10-03 に渡した（利用者「IRIS にカレンダー編集権限を与えて
 * ほしい」）。削除は DESTRUCTIVE で、承認の画面に**消す予定の日付・題名を一件ずつ**出す。
 * 日付と題名で**一件に絞れたものだけ**を対象にし（二件あれば断る）、消す前の中身を
 * 控え（`.iris/schedule/undo/`）に残してから消す。控えが取れなければ消さない。
 * Google と iCloud の両方（iCloud の毎週の予定は「その回だけ」。2026-10-08 に iCloud も対応）。終日の予定は対象外。
 *
 * 渡していないもの：メールの送信、通知（この機械では許可が下りない — 実測済み）。メールの
 * 下書きは Gmail の書き込みの権限が要り、IRIS の OAuth は読み取りのみ（例外は
 * カレンダーの予定だけ）という決めと食い違うので、ここでは作らない。
 */

export type PostJson = (path: string, body: unknown) => Promise<any>;
export type GetJson = (path: string) => Promise<any>;
export type PatchJson = (path: string, body: unknown) => Promise<any>;

const SHAPE_TIMED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const SHAPE_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface OpenDeps {
  /** 開いてよいファイルか（読み取りを許した場所の中で、拒否されていないもの）。 */
  canReadPath: (p: string) => string;
  run: (command: string, args: string[]) => Promise<void>;
  appExists: (name: string) => boolean;
}

const defaultOpenDeps = (canReadPath: (p: string) => string): OpenDeps => ({
  canReadPath,
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 15_000 }, (err) => (err ? reject(err) : resolve()));
    }),
  appExists: (name) =>
    [path.join('/Applications', `${name}.app`), path.join(os.homedir(), 'Applications', `${name}.app`),
      path.join('/System/Applications', `${name}.app`)].some((p) => fs.existsSync(p)),
});

export function createActionTools(
  deps: { get: GetJson; post: PostJson; patch: PatchJson; canReadPath: (p: string) => string },
  open: OpenDeps = defaultOpenDeps(deps.canReadPath)
): Tool[] {
  return [
    {
      name: 'list_calendar_targets',
      description:
        '予定を書き込める先のカレンダー（Google・iCloud）の一覧。create_calendar_event に渡す calendarId と source を、ここから選びます。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: { type: 'object', properties: {} },
      async execute() { return deps.get('/api/calendar/targets'); },
    },

    {
      name: 'create_calendar_event',
      description:
        'カレンダーに予定を一件作ります（実行前に承認が必要）。日時は解決済みの絶対値で、終日でなければ YYYY-MM-DDTHH:mm、終日なら YYYY-MM-DD。「来週の火曜」のような相対表現は渡せません。' +
        '入れる先は list_calendar_targets で選びます。迷うときは勝手に決めず、利用者に聞いてください。直すのは update_calendar_event、消すのは delete_calendar_events。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: { type: 'string', description: 'YYYY-MM-DDTHH:mm（終日なら YYYY-MM-DD）' },
          end: { type: 'string', description: '同じ形。省略可' },
          allDay: { type: 'boolean' },
          location: { type: 'string' },
          calendarId: { type: 'string', description: 'list_calendar_targets の id' },
          source: { type: 'string', enum: ['google', 'icloud'], description: 'list_calendar_targets の source' },
        },
        required: ['title', 'start', 'calendarId', 'source'],
      },
      async execute(args: any) {
        const allDay = args?.allDay === true;
        const shape = allDay ? SHAPE_DAY : SHAPE_TIMED;
        if (!shape.test(String(args?.start ?? '')) || (args?.end && !shape.test(String(args.end)))) {
          throw new Error(`日時は解決済みの絶対値で渡してください（${allDay ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm'}）。`);
        }
        return deps.post('/api/calendar/events', {
          title: args.title, start: args.start, end: args.end ?? null, allDay, location: args.location ?? null,
          calendarId: args.calendarId, source: args.source,
        });
      },
    },

    {
      name: 'reschedule_calendar_event',
      description:
        'Google カレンダーの予定の時刻を直します（実行前に承認が必要）。日付と題名で一件に絞れたときだけ動きます（二件あれば断ります）。iCloud の予定は対象外。題名や場所も直すなら update_calendar_event、消すなら delete_calendar_events。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          calendarId: { type: 'string', description: 'Google のカレンダー id' },
          date: { type: 'string', description: '今の予定の日付 YYYY-MM-DD' },
          title: { type: 'string', description: '今の予定の題名' },
          newStart: { type: 'string', description: '新しい開始 YYYY-MM-DDTHH:mm' },
          newEnd: { type: 'string', description: '新しい終了。省略可' },
        },
        required: ['calendarId', 'date', 'title', 'newStart'],
      },
      async execute(args: any) {
        if (!SHAPE_DAY.test(String(args?.date ?? ''))) throw new Error('date は YYYY-MM-DD で渡してください。');
        if (!SHAPE_TIMED.test(String(args?.newStart ?? '')) || (args?.newEnd && !SHAPE_TIMED.test(String(args.newEnd)))) {
          throw new Error('newStart / newEnd は YYYY-MM-DDTHH:mm で渡してください。');
        }
        const found = await deps.post('/api/calendar/events/find', {
          calendarId: args.calendarId, items: [{ date: args.date, title: args.title }],
        });
        const hit = found?.found?.[0];
        // 二件あるときは選ばない。見つからなかったことと、選べなかったことは別。
        if (!hit?.id) {
          throw new Error(hit?.error
            ? `予定を探せませんでした: ${hit.error}`
            : `${args.date} の「${args.title}」を一件に絞れませんでした（無いか、同名が複数あります）。`);
        }
        const result = await deps.post('/api/calendar/events/settime', {
          calendarId: args.calendarId, confirm: true,
          items: [{ id: hit.id, start: args.newStart, end: args.newEnd ?? null }],
        });
        return { ...result, was: { date: args.date, title: args.title, start: hit.start } };
      },
    },

    {
      name: 'update_calendar_event',
      description:
        'カレンダー（Google・iCloud）の予定の題名・場所・時刻を直します（実行前に承認が必要）。日付と今の題名で一件に絞れたときだけ動きます（二件あれば断ります）。' +
        '毎週の繰り返しの予定は、**その回だけ**直します（毎週の定義は変えません）。直す前の中身は控えに残り、直したあとで読み直して確かめます。' +
        '直したい項目だけ渡してください（渡さない項目はそのまま）。calendarId は list_calendar_targets の id。終日の予定は対象外。削除は delete_calendar_events。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          calendarId: { type: 'string', description: 'list_calendar_targets の id（Google のカレンダー id、または iCloud の URL）' },
          date: { type: 'string', description: '今の予定の日付 YYYY-MM-DD' },
          title: { type: 'string', description: '今の予定の題名' },
          time: { type: 'string', description: '今の予定の開始 HH:mm。同じ日に似た題の予定があるときに、これで絞る' },
          newTitle: { type: 'string' },
          newLocation: { type: 'string' },
          newStart: { type: 'string', description: 'YYYY-MM-DDTHH:mm' },
          newEnd: { type: 'string', description: 'YYYY-MM-DDTHH:mm' },
          reason: { type: 'string', description: 'なぜ直すか（控えに残る）' },
        },
        required: ['calendarId', 'date', 'title'],
      },
      async execute(args: any) {
        if (!SHAPE_DAY.test(String(args?.date ?? ''))) throw new Error('date は YYYY-MM-DD で渡してください。');
        for (const k of ['newStart', 'newEnd']) {
          if (args?.[k] && !SHAPE_TIMED.test(String(args[k]))) throw new Error(`${k} は YYYY-MM-DDTHH:mm で渡してください。`);
        }
        if (!args?.newTitle && args?.newLocation === undefined && !args?.newStart && !args?.newEnd) throw new Error('直す項目（newTitle / newLocation / newStart / newEnd）を一つは渡してください。');
        const found = await deps.post('/api/calendar/events/find', { calendarId: args.calendarId, items: [{ date: args.date, title: args.title, ...(args.time ? { time: String(args.time) } : {}) }] });
        const hit = found?.found?.[0];
        if (!hit?.id) {
          throw new Error(hit?.error ? `予定を探せませんでした: ${hit.error}` : `${args.date} の「${args.title}」を一件に絞れませんでした（無いか、同名が複数あります。同じ日に似た題があるなら time で絞れます）。`);
        }
        const result = await deps.post('/api/calendar/events/update', {
          calendarId: args.calendarId, id: hit.id, confirm: true, reason: args.reason ?? null,
          title: args.newTitle ?? null, location: args.newLocation ?? null, start: args.newStart ?? null, end: args.newEnd ?? null,
        });
        return { ...result, was: { date: args.date, title: hit.title ?? args.title, start: hit.start } };
      },
    },

    {
      name: 'delete_calendar_events',
      description:
        'カレンダー（Google・iCloud）の予定を消します（実行前に承認が必要。承認の画面に、消す予定が一件ずつ出ます）。毎週の繰り返しの予定は、**その回だけ**消します（毎週の定義は残します）。' +
        '日付と題名で**一件に絞れた予定だけ**が対象で、一件でも絞れなければ、全体を止めて何も消しません。一度に最大 10 件。' +
        '消す前の中身は控えに残ります（控えが取れなければ消しません）。理由（reason）は必須。終日の予定は対象外。' +
        '「消したほうがいい」と提案するだけで終えず、利用者が望んでいるなら、これで消す案を出してください。',
      riskLevel: RiskLevel.DESTRUCTIVE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          calendarId: { type: 'string', description: 'list_calendar_targets の id（Google のカレンダー id、または iCloud の URL）' },
          items: {
            type: 'array',
            description: '消す予定。日付 YYYY-MM-DD と、今の題名。似た題が同じ日にあるときは time（開始 HH:mm）も',
            items: { type: 'object', properties: { date: { type: 'string' }, title: { type: 'string' }, time: { type: 'string', description: '開始時刻 HH:mm。同じ日に似た題の予定があるときに、これで絞る' }, location: { type: 'string', description: '場所。題も時刻も同じ重複を分けるときだけ。空文字は「場所の記入なし」' } }, required: ['date', 'title'] },
          },
          reason: { type: 'string', description: 'なぜ消すか（控えに残る）' },
        },
        required: ['calendarId', 'items', 'reason'],
      },
      async execute(args: any) {
        const items: Array<{ date: string; title: string; time?: string }> = Array.isArray(args?.items) ? args.items : [];
        if (!items.length) throw new Error('消す予定（items）がありません。');
        if (items.length > 10) throw new Error('一度に消せるのは 10 件までです。');
        if (!String(args?.reason ?? '').trim()) throw new Error('消す理由（reason）が要ります。');
        for (const it of items) {
          if (!SHAPE_DAY.test(String(it?.date ?? '')) || !String(it?.title ?? '').trim()) throw new Error('各 item は date（YYYY-MM-DD）と title が要ります。');
          if ((it as any).time && !/^\d{2}:\d{2}$/.test(String((it as any).time))) throw new Error('time は HH:mm で渡してください。');
        }
        const found = await deps.post('/api/calendar/events/find', { calendarId: args.calendarId, items });
        const hits: any[] = found?.found ?? [];
        const unresolved = hits.filter((h) => !h?.id);
        // 一件でも絞れなければ、全部止める。一部だけ消すと、承認された形と違うものになる。
        if (unresolved.length || hits.length !== items.length) {
          throw new Error(`一件に絞れない予定があるので、何も消していません: ${unresolved.map((h) => `${h.date}「${h.title}」`).join('、') || '（探せませんでした）'}（無いか、同名が複数あります）。`);
        }
        const result = await deps.post('/api/calendar/events/remove', {
          calendarId: args.calendarId, ids: hits.map((h) => h.id), confirm: true, reason: args.reason,
        });
        return { ...result, deleted: hits.map((h) => ({ date: h.date, title: h.title, start: h.start })) };
      },
    },

    {
      name: 'update_fdp_task',
      description:
        '学習・課題（FDP）の台帳を一件直します（実行前に承認が必要）。直せるのは 期限（dueDate）・状態（status: 未着手／進行中／完了）・次の行動（nextAction）・進捗率（progress: 0〜1）・開始予定日（startDate）。' +
        'IRIS の台帳が正本で、スプレッドシートへは後から反映されます。期限や状態を変えたいと言われたら、これを使います（変えられない、と答えない）。' +
        '日付は YYYY/MM/DD か YYYY-MM-DD。タスクの id は get_study_tasks で分かります（例: T005）。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '課題の id（例: T005）' },
          field: { type: 'string', enum: ['dueDate', 'status', 'nextAction', 'progress', 'startDate'] },
          value: { type: 'string', description: '新しい値。日付は YYYY/MM/DD、状態は 未着手／進行中／完了、進捗率は 0〜1 の数' },
        },
        required: ['id', 'field', 'value'],
      },
      async execute(args: any) {
        const id = String(args?.id ?? '').trim();
        const field = String(args?.field ?? '');
        let value = String(args?.value ?? '').trim();
        if (!/^T\d+$/.test(id)) throw new Error('id は T005 のような課題番号で渡してください。');
        if (field === 'dueDate' || field === 'startDate') {
          const m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(value);
          if (!m) throw new Error('日付は YYYY/MM/DD か YYYY-MM-DD で渡してください。');
          const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
          if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) throw new Error(`存在しない日付です: ${value}`);
          value = `${m[1]}/${String(m[2]).padStart(2, '0')}/${String(m[3]).padStart(2, '0')}`;
        } else if (field === 'status') {
          if (!['未着手', '進行中', '完了'].includes(value)) throw new Error('状態は 未着手／進行中／完了 のどれかです。');
        } else if (field === 'progress') {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('進捗率は 0〜1 の数で渡してください。');
        } else if (field !== 'nextAction') {
          throw new Error(`直せない項目です: ${field}`);
        }
        const result = await deps.patch(`/api/fdp/tasks/${encodeURIComponent(id)}`, { field, value, writtenBy: 'iris.chat（利用者の依頼）' });
        return {
          ...result,
          note: result?.mirror?.ok === false
            ? 'IRIS の台帳は更新しました。スプレッドシートへの反映は、時間がかかっている（タイムアウト）ので、あとで確かめてください。'
            : 'IRIS の台帳とスプレッドシートを更新しました。',
        };
      },
    },

    {
      name: 'hold_fdp_task',
      description:
        '学習・課題（FDP）の課題を、指定の日まで保留にします（実行前に承認が必要）。保留の間は遅れとして数えず、その日を過ぎると自動で戻ります。終わりの日は必須です。' +
        '着手できない・後回しにすると言われたら、これを使います。日付は YYYY-MM-DD か YYYY/MM/DD。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '課題の id（例: T005）' },
          until: { type: 'string', description: '保留の終わりの日' },
          reason: { type: 'string', description: '理由。省略可' },
        },
        required: ['id', 'until'],
      },
      async execute(args: any) {
        const id = String(args?.id ?? '').trim();
        if (!/^T\d+$/.test(id)) throw new Error('id は T005 のような課題番号で渡してください。');
        const m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(String(args?.until ?? '').trim());
        if (!m) throw new Error('until は YYYY-MM-DD か YYYY/MM/DD で渡してください。');
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) throw new Error(`存在しない日付です: ${args.until}`);
        const until = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
        return deps.post(`/api/fdp/tasks/${encodeURIComponent(id)}/hold`, {
          heldUntil: until, reason: args?.reason ? String(args.reason) : null, setBy: 'iris.chat（利用者の依頼）',
        });
      },
    },

    {
      name: 'open_target',
      description:
        'Mac で URL・アプリ・ファイルを開きます（実行前に承認が必要）。URL は http / https のみ。アプリは名前（例: Notes）で、インストール済みのものだけ。ファイルは読み取りを許した場所の中のものだけ（既定のアプリで開く）。',
      riskLevel: RiskLevel.EXTERNAL_ACTION,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'https://… の URL、アプリ名、または ~/ か絶対パスのファイル' },
        },
        required: ['target'],
      },
      async execute(args: any) {
        const target = String(args?.target ?? '').trim();
        if (!target) throw new Error('開く先が指定されていません。');

        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
          let url: URL;
          try { url = new URL(target); } catch { throw new Error(`URL として読めません: ${target}`); }
          if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new Error(`開けるのは http / https の URL だけです（${url.protocol}）。`);
          }
          await open.run('open', [url.toString()]);
          return { opened: url.toString(), kind: 'url' };
        }

        if (target.startsWith('/') || target.startsWith('~')) {
          const file = open.canReadPath(target);
          if (!fs.existsSync(file)) throw new Error(`ありません: ${file}`);
          await open.run('open', [file]);
          return { opened: file, kind: 'file' };
        }

        if (!/^[\p{L}\p{N} ._+-]+$/u.test(target) || !open.appExists(target)) {
          throw new Error(`アプリが見つかりません: ${target}（名前で、インストール済みのものだけ）。`);
        }
        await open.run('open', ['-a', target]);
        return { opened: target, kind: 'app' };
      },
    },
  ];
}
