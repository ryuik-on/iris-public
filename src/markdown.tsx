import React from 'react';

/**
 * The small part of Markdown that model replies actually contain.
 *
 * Until now the transcript rendered `{m.content}` as plain text, so an answer
 * about today's calendar arrived on screen as `- **件名:** そよかぜ書店` — asterisks
 * and hyphens included. The same text is handed to the voice, where it was
 * read aloud as 「アスタリスク」; that half is fixed in normalizeForSpeech, and
 * this is the other half.
 *
 * Written rather than installed. The subset a reply uses is bold, italic,
 * inline code, fenced code, headings and lists — six things, none of which
 * justify a parser and its transitive dependencies. More importantly this
 * returns React elements and never touches dangerouslySetInnerHTML, so model
 * output cannot become markup no matter what it contains. A general parser
 * would be the more capable choice and the less safe one.
 *
 * Anything it does not recognise is left exactly as written. Text that looks
 * like an unclosed emphasis, or a lone `*` between numbers, stays on screen as
 * the author typed it — silently swallowing a character would be worse than
 * showing one.
 */

/**
 * `**強調**`, `*強調*`, `` `code` `` — non-greedy, and never across a line.
 *
 * 中身から `*` `_` `` ` `` を除いていたので、**中に別の印を含む強調が一つも
 * 通らなかった** — 「**あなたの `agy` や Mac をバックエンドにする場合**」が
 * アスタリスクごと画面に出ていたのはこれ。中に印があるのは珍しくない。
 *
 * 中身から除くのは**その印そのものだけ**（先読みで見る）。全部の印を除くと
 * 中に `code` を含む強調が通らず、`[^\n]` まで緩めると単独の `*` が別の
 * 対の片割れまで飲み込む — 一度そうして、文章が消えた。
 *
 * 中身は空白で始まらず、空白で終わらない。これが無いと `2 * 3 * 4` の星が
 * 対に見えて、**掛け算が斜体になり星が消える**（元からそうだった）。
 *
 * `code` だけは中身を素のまま扱うので、そこはバッククォートを除いたまま。
 * 強調の中身は**もう一度この関数に通す**ので、入れ子も解ける。
 */
const INLINE = /(\*\*\*|\*\*|__)(\S(?:(?:(?!\1)[^\n])*?\S)?)\1|(\*|_)(\S(?:(?:(?!\3)[^\n])*?\S)?)\3|`([^\n`]+?)`/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  /**
   * 走査ごとに新しい正規表現を作る。
   *
   * `g` 付きの正規表現は `lastIndex` を持つので、**入れ子で同じものを使うと
   * 内側の走査が外側の位置を書き換える** — 強調の中身をこの関数に通すように
   * した時点で、共有していたら壊れていた。
   */
  const scan = new RegExp(INLINE.source, 'g');

  while ((match = scan.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    // 1 は印そのもの、2 が強調の中身、3 は斜体の印、4 が斜体の中身、5 が
    // code。一つずつ手前を読んでいて、**印を中身として描いていた**（画面に
    // `**` が出て、囲まれた文章が消えていたのはこれ）。
    const [, , strongInner, , emInner, codeInner] = match;
    const key = `${keyPrefix}-${match.index}`;

    if (codeInner !== undefined) {
      out.push(
        <code key={key} className="hud-mono px-1 py-0.5 text-[0.92em] bg-white/[0.06] text-sky-200">
          {codeInner}
        </code>
      );
    } else if (emInner !== undefined) {
      out.push(<em key={key}>{renderInline(emInner, key)}</em>);
    } else {
      // ** and *** both read as emphasis here. Distinguishing bold from
      // bold-italic buys nothing in a chat transcript.
      out.push(
        <strong key={key} className="font-medium text-sky-100">
          {renderInline(strongInner ?? '', key)}
        </strong>
      );
    }
    last = match.index + match[0].length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out.length > 0 ? out : [text];
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; lines: string[]; lang: string }
  | { kind: 'table'; head: string[]; rows: string[][] };

/**
 * Grouped a line at a time, because a reply is short and the alternative is a
 * grammar. A list ends when a line stops looking like a list item; a fence
 * ends at the next fence or at the end of the text, so an unterminated fence
 * shows its contents rather than eating the rest of the reply.
 */
function toBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  const last = () => blocks[blocks.length - 1];

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence, or the end
      blocks.push({ kind: 'code', lines: body, lang: fence[1] });
      continue;
    }

    /**
     * A table, which needs its separator row to be one.
     *
     * Added when the reading layer arrived: a long answer is exactly where a
     * model reaches for a table, and without this the pipes and dashes were
     * shown as the literal characters — the same failure the asterisks were,
     * one level up. Two lines are checked before committing, so a sentence
     * containing a pipe is still a sentence.
     */
    const nextLine = lines[i + 1] ?? '';
    if (line.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(nextLine) && nextLine.includes('-')) {
      const cells = (row: string) =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(cells(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'h', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    const bullet = /^\s*[-*+•]\s+(.*)$/.exec(line);
    if (bullet) {
      const prev = last();
      if (prev?.kind === 'ul') prev.items.push(bullet[1]);
      else blocks.push({ kind: 'ul', items: [bullet[1]] });
      i++;
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      const prev = last();
      if (prev?.kind === 'ol') prev.items.push(numbered[1]);
      else blocks.push({ kind: 'ol', items: [numbered[1]] });
      i++;
      continue;
    }

    if (line.trim() === '') {
      // A blank line closes whatever was open, which is what makes two
      // adjacent lists stay two lists.
      blocks.push({ kind: 'p', lines: [] });
      i++;
      continue;
    }

    const prev = last();
    if (prev?.kind === 'p' && prev.lines.length > 0) prev.lines.push(line);
    else blocks.push({ kind: 'p', lines: [line] });
    i++;
  }

  return blocks.filter((b) => !(b.kind === 'p' && b.lines.length === 0));
}

export function Markdown({ text }: { text: string }) {
  const blocks = React.useMemo(() => toBlocks(text), [text]);

  return (
    <div className="space-y-2">
      {blocks.map((block, bi) => {
        switch (block.kind) {
          case 'h':
            return (
              <div
                key={bi}
                className="hud-label text-sky-300/80 pt-1"
                style={{ fontSize: block.level <= 2 ? '11px' : '10px' }}
              >
                {renderInline(block.text, `h${bi}`)}
              </div>
            );

          case 'code':
            return (
              <pre
                key={bi}
                className="hud-mono text-[11px] leading-relaxed overflow-x-auto p-2.5 bg-black/40 border border-white/[0.07] text-sky-200/90"
              >
                <code>{block.lines.join('\n')}</code>
              </pre>
            );

          case 'table':
            return (
              /* Scrolls itself rather than widening its container. A table
                 wider than the reading layer must not make the layer wider. */
              <div key={bi} className="overflow-x-auto -mx-1 px-1">
                <table className="w-full text-[14px] border-collapse">
                  <thead>
                    <tr>
                      {block.head.map((cell, ci) => (
                        <th
                          key={ci}
                          className="text-left font-medium text-sky-200/80 border-b border-white/10 py-1.5 pr-4 align-top"
                        >
                          {renderInline(cell, `th${bi}-${ci}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci} className="border-b border-white/[0.05] py-1.5 pr-4 align-top">
                            {renderInline(cell, `td${bi}-${ri}-${ci}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          case 'ul':
          case 'ol':
            return (
              <ul key={bi} className="space-y-1">
                {block.items.map((item, ii) => (
                  <li key={ii} className="flex gap-2">
                    <span className="hud-mono text-[10px] text-sky-400/50 pt-[3px] select-none shrink-0">
                      {block.kind === 'ol' ? `${ii + 1}.` : '·'}
                    </span>
                    <span className="min-w-0">{renderInline(item, `l${bi}-${ii}`)}</span>
                  </li>
                ))}
              </ul>
            );

          default:
            return (
              <p key={bi} className="whitespace-pre-wrap">
                {block.lines.map((line, li) => (
                  <React.Fragment key={li}>
                    {li > 0 && <br />}
                    {renderInline(line, `p${bi}-${li}`)}
                  </React.Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
