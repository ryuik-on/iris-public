/**
 * Reading a card notification without guessing.
 *
 * `finance_gmail_intake` states the rule this file exists to obey: Unknown
 * Template は安全に失敗する。認識できないメールから金額を推測して記録しない。
 * A general-purpose "find a number followed by 円" would work on every example
 * anyone tests it against and then charge a month for a points-award notice —
 * and a wrong amount in a spending total looks like spending, not like a bug.
 *
 * So a template is written per issuer, against a real message, and anything
 * that does not match one is skipped and reported by name.
 *
 * The three here come from actual mail on 2026-08-20, and they disagree about
 * everything:
 *
 *   ポケットカード puts the label on its own line and the value on the next.
 *   JCB puts both on one line, inside 【】.
 *   JCB's two notice types come from the same address and differ only in the
 *     body — so the sender cannot select the template, and a marker does.
 *   JCB's settled notice carries several purchases in one message, under
 *     ◆ご利用１, ◆ご利用２ …; reading only the first would silently drop the
 *     rest.
 *
 * One thing the issuers say themselves, which the code relies on: JCB's
 * settled notice covers 「カードご利用時に通知していないもの」 only, so the
 * two JCB templates describe disjoint sets and cannot double-count each other.
 */

export type FieldLayout =
  /** `■ご利用金額` on one line, `600円` on the next. */
  | 'label_then_value'
  /** `【ご利用金額】　1,000円` on a single line. */
  | 'inline';

export interface EmailTemplate {
  id: string;
  label: string;
  /** Substring of the From address. Necessary, never sufficient. */
  sender: string;
  /**
   * Text that must appear in the body for this template to apply.
   *
   * How the two JCB notices are told apart: they share a sender and differ
   * only here.
   */
  requires: string[];
  /** Text that must NOT appear. Keeps the realtime template off settled mail. */
  excludes?: string[];
  layout: FieldLayout;
  /**
   * Where each purchase starts, for messages carrying several.
   *
   * Absent means the whole body is one purchase.
   */
  repeatMarker?: string;
  fields: {
    /** Any of these label spellings; the first present wins. */
    date: string[];
    amount: string[];
    merchant: string[];
  };
  /**
   * A merchant string the issuer sends in place of a real name.
   *
   * ポケットカード sends `Mastercard加盟店` for every purchase. Recorded as
   * unknown rather than as a shop called that, because a category rule built
   * on it would silently cover everything.
   */
  placeholderMerchants?: string[];
}

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: 'pocketcard',
    label: 'ポケットカード（ZOZOCARD 等）',
    sender: 'pocketcard.co.jp',
    requires: ['カード利用のお知らせ', '■ご利用金額'],
    layout: 'label_then_value',
    fields: {
      date: ['■ご利用日時'],
      amount: ['■ご利用金額'],
      merchant: ['■ご利用先'],
    },
    placeholderMerchants: ['Mastercard加盟店', 'Visa加盟店', 'JCB加盟店'],
  },
  {
    id: 'jcb_realtime',
    label: 'JCB（利用時の即時通知）',
    sender: 'jcb.co.jp',
    requires: ['【ご利用日時'],
    // The settled notice uses 【ご利用日】 and groups purchases under ◆ご利用.
    excludes: ['◆ご利用'],
    layout: 'inline',
    fields: {
      date: ['【ご利用日時(日本時間)】', '【ご利用日時】'],
      amount: ['【ご利用金額】'],
      merchant: ['【ご利用先】'],
    },
  },
  {
    id: 'jcb_settled',
    label: 'JCB（売上到着分）',
    sender: 'jcb.co.jp',
    requires: ['◆ご利用'],
    layout: 'inline',
    // Several purchases per message. Reading only the first would drop the
    // rest with nothing to show that it had.
    repeatMarker: '◆ご利用',
    fields: {
      date: ['【ご利用日】'],
      amount: ['【ご利用金額】'],
      merchant: ['【ご利用先】'],
    },
  },
];

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  /** When the message arrived, as a fallback for nothing. */
  receivedAt?: string;
}

export interface ExtractedPurchase {
  occurredOn: string;
  /** Negative: a notification always describes money leaving. */
  amount: number;
  description: string;
  /** True when the issuer sent a placeholder instead of a merchant name. */
  merchantUnknown: boolean;
}

export interface EmailParseResult {
  ok: boolean;
  template?: EmailTemplate;
  purchases: ExtractedPurchase[];
  /** Why nothing was taken from this message. */
  reason?: string;
  /** Blocks inside a matched message that could not be read. */
  skipped: Array<{ block: number; reason: string }>;
}

/** Full-width digits, colons and spaces appear throughout these messages. */
export function normalizeWidth(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':')
    .replace(/／/g, '/')
    .replace(/　/g, ' ');
}

export function detectTemplate(
  message: EmailMessage,
  templates: EmailTemplate[] = EMAIL_TEMPLATES
): EmailTemplate | null {
  const from = message.from.toLowerCase();
  const haystack = `${message.subject}\n${message.body}`;
  return (
    templates.find(
      (t) =>
        from.includes(t.sender.toLowerCase()) &&
        t.requires.every((r) => haystack.includes(r)) &&
        !(t.excludes ?? []).some((x) => haystack.includes(x))
    ) ?? null
  );
}

/** `2026/08/20 00:05:08` or `2026/07/23` → `2026-08-20`. */
export function parseEmailDate(raw: string): string | null {
  const value = normalizeWidth(raw).trim();
  const match = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  // A date that does not exist must not roll into the next month.
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== Number(d)) return null;
  return iso;
}

/** `1,000円` → 1000. Returns null rather than 0 when it cannot tell. */
export function parseEmailAmount(raw: string): number | null {
  const value = normalizeWidth(raw).replace(/[,円\s]/g, '');
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/** The value belonging to a label, by the template's layout. */
function valueFor(lines: string[], labels: string[], layout: FieldLayout): string | null {
  for (const label of labels) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(label)) continue;
      if (layout === 'inline') {
        const after = line.slice(line.indexOf(label) + label.length).trim();
        if (after) return after;
        continue;
      }
      // label_then_value: the value is the next non-empty line. A blank line
      // between them is normal in these messages.
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next) return next;
      }
    }
  }
  return null;
}

export function parseEmail(
  message: EmailMessage,
  templates: EmailTemplate[] = EMAIL_TEMPLATES
): EmailParseResult {
  const template = detectTemplate(message, templates);
  if (!template) {
    // Named, not counted. A tally of unread messages is not something anyone
    // can act on; a sender and a subject is.
    return {
      ok: false,
      purchases: [],
      skipped: [],
      reason: `対応するテンプレートがありません（${message.from} / ${message.subject}）`,
    };
  }

  const blocks = template.repeatMarker
    ? message.body.split(template.repeatMarker).slice(1)
    : [message.body];

  const purchases: ExtractedPurchase[] = [];
  const skipped: Array<{ block: number; reason: string }> = [];

  blocks.forEach((block, index) => {
    const lines = block.split(/\r?\n/);
    const rawDate = valueFor(lines, template.fields.date, template.layout);
    const rawAmount = valueFor(lines, template.fields.amount, template.layout);
    const rawMerchant = valueFor(lines, template.fields.merchant, template.layout);

    const occurredOn = rawDate ? parseEmailDate(rawDate) : null;
    const amount = rawAmount ? parseEmailAmount(rawAmount) : null;

    if (!occurredOn || amount === null) {
      // Both are required. A purchase with a date and no amount is not a
      // partial record, it is a guess waiting to be made.
      skipped.push({
        block: index + 1,
        reason: !occurredOn ? `日付を読めません: ${rawDate ?? '(なし)'}` : `金額を読めません: ${rawAmount ?? '(なし)'}`,
      });
      return;
    }

    const merchant = (rawMerchant ?? '').trim();
    const placeholder = (template.placeholderMerchants ?? []).includes(merchant);
    purchases.push({
      occurredOn,
      // A usage notification always describes money leaving.
      amount: -amount,
      description: placeholder || !merchant ? '(利用先不明)' : merchant,
      merchantUnknown: placeholder || !merchant,
    });
  });

  return { ok: purchases.length > 0, template, purchases, skipped };
}
