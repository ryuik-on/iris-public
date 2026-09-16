/**
 * 予定の題名を、それと分かる部分まで切り詰める。
 *
 * Calendar titles arrive carrying how they are filed: 「病理学Ⅱ25-26」 is a
 * lecture range, 「微生物・免疫学試験（後半）」 a half. By the time somebody is
 * reading a list of what is coming, the numbers tell them nothing they do not
 * already know, and they push everything else off the line.
 *
 * The band has done this since 2026-08-26, in Swift. This is the same rule on
 * the server, so the web list and anything else added later read the same
 * shortened title rather than each growing a copy of the regexes. The Swift
 * one stays because a band cannot call this — but the rule is written down
 * once here, and the tests are here.
 */

/** 末尾の括弧書き。閉じていなくても、先に別の処理で切られた場合があるため。 */
const PARENTHETICAL = /[\s]*[（(][^）)]*[）)]?[\s]*$/;
/** 末尾の算用数字。範囲も含む。全角も。 */
const FILING = /[\s]*[0-9０-９]+(?:[-‐‑–—~〜][0-9０-９]+)?[\s]*$/;

export function subject(title: string): string {
  let text = title;
  for (const pattern of [PARENTHETICAL, FILING]) {
    const match = text.match(pattern);
    if (!match) continue;
    const trimmed = text.slice(0, match.index);
    /**
     * 全部消すのは短縮ではない。
     *
     * A title that is nothing but a number keeps it, and one that is nothing
     * but a parenthetical keeps that too.
     */
    if (trimmed.trim()) text = trimmed;
  }
  return text.trim();
}
