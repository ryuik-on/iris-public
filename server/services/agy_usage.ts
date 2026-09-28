import { execFile } from 'child_process';
import { request } from 'https';

/**
 * Antigravity（`agy`）に残っている枠。
 *
 * The other two assistants leave their limits in files on disk. This one does
 * not: it keeps them in a language server that is started with the desktop
 * app, listens on HTTPS on a port that changes every launch, and answers only
 * to a CSRF token that is passed to it on its own command line. So this is the
 * one meter on the machine that is read over a socket.
 *
 * `RetrieveUserQuotaSummary` is not a documented endpoint. It was found in the
 * binary, and it will break when Antigravity is updated. That is acceptable
 * because breaking is *visible* here — an unreadable meter draws a dashed ring
 * and says why, which is the shape everything on this machine is supposed to
 * fail into.
 *
 * The reading is only available while the Antigravity app is running. That is
 * a fact about the product, not a fault, and it is reported as such.
 */

/** 一つの窓。**使った割合**で持つ — 契約側は残量で返してくるので、ここで反転する。 */
export interface AgyWindow {
  usedPercent: number;
  resetsAtMs: number | null;
}

export interface AgyQuota {
  /** Gemini 系のモデル。 */
  gemini: { week: AgyWindow | null; session: AgyWindow | null };
  /** Antigravity 経由の Claude / GPT。Claude Code の契約とは別のもの。 */
  thirdParty: { week: AgyWindow | null; session: AgyWindow | null };
}

/**
 * 応答を、この機械の言葉に直す。
 *
 * **`remainingFraction` は残量で、この機械が使う `usedPercent` は使用量。**
 * 1 は「まだ手つかず」であって「使い切った」ではない。ここを取り違えると、
 * 手つかずの契約が満杯に見え、満杯の契約が手つかずに見える — 8月に Codex で
 * 起きたのと同じ事故が、向きだけ逆になって起きる。だから変換はこの一箇所に
 * 閉じ込め、名前で用途を言い切る。
 *
 * 窓は `window` の文字列で選ぶ。順番でも `bucketId` でもなく、意味を持つ欄で
 * 選ぶのは、Codex の5時間の窓を週の窓として読んだ一件のあと決めたこと。
 */
export function parseQuotaSummary(payload: unknown): AgyQuota | null {
  const groups = (payload as any)?.response?.groups;
  if (!Array.isArray(groups)) return null;

  const read = (match: (name: string) => boolean) => {
    const group = groups.find((g: any) => typeof g?.displayName === 'string' && match(g.displayName));
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    const pick = (window: string): AgyWindow | null => {
      const bucket = buckets.find((b: any) => b?.window === window);
      if (!bucket || typeof bucket.remainingFraction !== 'number') return null;
      const remaining = Math.min(Math.max(bucket.remainingFraction, 0), 1);
      const resets = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : NaN;
      return {
        usedPercent: Math.round((1 - remaining) * 100),
        resetsAtMs: Number.isFinite(resets) ? resets : null,
      };
    };
    return { week: pick('weekly'), session: pick('5h') };
  };

  const quota = {
    gemini: read((name) => name.includes('Gemini')),
    thirdParty: read((name) => name.includes('Claude') || name.includes('GPT')),
  };
  // どちらの群からも一つも読めなかったなら、形が変わったということ。
  const any = [quota.gemini, quota.thirdParty].some((g) => g.week || g.session);
  return any ? quota : null;
}

/** 言語サーバの居場所。起動ごとに変わるので、そのつど探す。 */
export interface AgyEndpoint {
  port: number;
  token: string;
}

/**
 * 動いている言語サーバから、港と合鍵を見つける。
 *
 * 合鍵はコマンドラインに載っている。行儀の良い置き場所ではないが、こちらが
 * 決めたことではない。見つからなければ `null` — **推測しない。**
 */
/**
 * 待たずに走らせる。**同期の子プロセスをサーバの輪で回さない。**
 *
 * `read()` から `ps` と `lsof` を `execFileSync` で呼んでいた。普段は数十 ms
 * だが、機械が混んでいるときは伸びる —— 実測 2026-09-28、`/api/usage/cli` が
 * **2.57秒** サーバ全体を止めた（見張りがその名で記録）。これで三度目の
 * 同じ形（セッション走査・使用量の掃き直し・ここ）。
 */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

export async function findEndpoint(
  ps: () => string | Promise<string> = () => run('ps', ['-eo', 'pid,command']),
  ports: (pid: number) => string | Promise<string> = (pid) =>
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)])
): Promise<AgyEndpoint | null> {
  let table: string;
  try {
    table = await ps();
  } catch {
    return null;
  }
  const line = table
    .split('\n')
    .find((l) => l.includes('language_server') && l.includes('--csrf_token'));
  if (!line) return null;

  const pid = Number(line.trim().split(/\s+/)[0]);
  const token = line.match(/--csrf_token\s+([0-9a-fA-F-]{8,})/)?.[1];
  if (!Number.isFinite(pid) || !token) return null;

  let listening: string;
  try {
    listening = await ports(pid);
  } catch {
    return null;
  }
  const port = Number(listening.match(/:(\d+)\s+\(LISTEN\)/)?.[1]);
  return Number.isFinite(port) ? { port, token } : null;
}

const RPC = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

/**
 * 一度だけ叩く。
 *
 * 証明書は自己署名。相手は自分の機械の中の、自分で起動した処理なので、検証を
 * 切っている。**外へは出さない** — ホストは必ず 127.0.0.1。
 */
export function fetchQuota(endpoint: AgyEndpoint, timeoutMs = 4000): Promise<AgyQuota | null> {
  return new Promise((resolve) => {
    const body = '{}';
    const req = request(
      {
        host: '127.0.0.1',
        port: endpoint.port,
        path: RPC,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': endpoint.token,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(parseQuotaSummary(JSON.parse(text)));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

export interface AgyReading {
  quota: AgyQuota | null;
  /** 読めなかった理由。読めたときは `null`。 */
  reason: string | null;
  /** `quota` が最後に読めた値で、いま取れたものではないこと。 */
  stale?: boolean;
  /** その値の古さ。`stale` のときだけ入る。 */
  ageMinutes?: number;
  checkedAt: string;
}

const REFRESH_MS = 5 * 60_000;

/**
 * 最後に読めた値を、どこまで出し続けるか。
 *
 * Antigravity を閉じると読めなくなる。そのたびに点線へ落とすと、**使って
 * いないから閉じている相手が、壊れているように見える。**週の枠は週の単位で
 * 動くので、六時間前の値はほぼそのまま正しい。
 *
 * ただし**古さを必ず言う**こと。それを言わずに出すのは、この計画がずっと
 * 直してきた失敗そのもの。六時間を過ぎたら捨てて、読めないと言う。
 */
const KEEP_MS = 6 * 60 * 60_000;

/**
 * 読めた最後の値を持ち、裏で取り直す。
 *
 * 帯やレールは数秒ごとに聞いてくる。そのたびにソケットを開くと、Antigravity
 * が落ちているあいだは毎回タイムアウトを待つことになる。
 */
export class AgyUsageService {
  private cached: AgyReading | null = null;
  private cachedAt = 0;
  private reading = false;
  /** 最後に本当に読めたもの。アプリが閉じているあいだ、これを歳とともに出す。 */
  private lastGood: { quota: AgyQuota; at: number } | null = null;

  /** 読めなかったときの答え。持っているものがあれば、古さを付けて出す。 */
  private fallback(reason: string, now: number): AgyReading {
    const held = this.lastGood;
    if (held && now - held.at < KEEP_MS) {
      return {
        quota: held.quota,
        reason,
        stale: true,
        ageMinutes: Math.floor((now - held.at) / 60_000),
        checkedAt: new Date(now).toISOString(),
      };
    }
    return { quota: null, reason, checkedAt: new Date(now).toISOString() };
  }

  constructor(
    private locate: () => AgyEndpoint | null | Promise<AgyEndpoint | null> = findEndpoint,
    private fetch: (e: AgyEndpoint) => Promise<AgyQuota | null> = fetchQuota
  ) {}

  read(now = Date.now()): AgyReading {
    if (!this.cached || now - this.cachedAt >= REFRESH_MS) void this.sweep(now);
    return (
      this.cached ?? {
        quota: null,
        reason: 'まだ問い合わせていません。',
        checkedAt: new Date(now).toISOString(),
      }
    );
  }

  /** いま取り直して、終わるまで待つ。押した人はその結果を見たい。 */
  async refresh(now = Date.now()): Promise<void> {
    this.cachedAt = 0;
    await this.sweep(now);
  }

  private async sweep(now = Date.now()): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const endpoint = await this.locate();
      if (!endpoint) {
        this.cached = this.fallback('Antigravity が起動していません。', now);
        this.cachedAt = now;
        return;
      }
      const quota = await this.fetch(endpoint);
      if (quota) {
        this.lastGood = { quota, at: now };
        this.cached = { quota, reason: null, checkedAt: new Date(now).toISOString() };
      } else {
        this.cached = this.fallback('言語サーバが残量を返しませんでした。', now);
      }
      this.cachedAt = now;
    } finally {
      this.reading = false;
    }
  }
}
