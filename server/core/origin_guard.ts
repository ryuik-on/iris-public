/**
 * 別のサイトのページから、IRIS の API を叩かれないようにする。
 *
 * IRIS は 127.0.0.1 で動き、同じ機械からの要求は認証なしで通す。ブラウザで開いた
 * **どのページも**、利用者の機械から 127.0.0.1 へ要求を送れる。だから、要求の
 * `Origin`（ブラウザが必ず付ける、送り元のサイト）が、この API 自身のサイトと
 * 違う場合は、読ませも書かせもしない。
 *
 * `Origin` を付けない道（HUD や curl、同じサイトからの GET の一部）は対象外。
 * そちらは、ブラウザ経由ではない。
 */
export function isForeignOrigin(origin: string | undefined, host: string | undefined, allowed: string[] = []): boolean {
  if (!origin) return false;
  // `null` は、サンドボックス化された枠や、ファイルから開いたページの印。**同じサイトではない。**
  if (origin === 'null') return true;
  let hostOfOrigin: string;
  try { hostOfOrigin = new URL(origin).host; } catch { return true; }
  if (host && origin.toLowerCase() === `http://${host.toLowerCase()}`) return false;
  return !allowed.some((a) => a.trim() && a.trim().toLowerCase() === origin.toLowerCase());
}

/**
 * 同じ機械から来た要求の `Host` が、IRIS 自身の名前かどうか。
 *
 * `Origin` と `Host` が同じなら通す、だけでは足りない。攻撃者のサイト名を
 * 127.0.0.1 に向けさせる（DNS リバインディング）と、ブラウザには「同じサイトへの
 * 要求」に見え、`Origin` も `Host` も攻撃者の名前で揃ってしまう。だから、**同じ機械
 * から来た要求は、`Host` が 127.0.0.1・localhost・[::1]（IRIS の口）のどれかでなければ断る**。
 * 別の機器からの要求（スマホなど）は、合言葉（token）が要るので、対象にしない。
 */
export function isUntrustedLoopbackHost(host: string | undefined, fromLoopback: boolean, port: number, extra: string[] = []): boolean {
  if (!fromLoopback) return false;
  if (!host) return true;
  const h = host.toLowerCase();
  const trusted = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...extra.map((x) => x.trim().toLowerCase()).filter(Boolean)];
  return !trusted.includes(h);
}
