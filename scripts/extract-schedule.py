#!/usr/bin/env python3
"""講義日程 PDF から試験を取り出して JSON にする。

なぜ Python か。PDF を読むのに使えるものがこの機械には PyMuPDF しかなく、
Node 側に PDF 依存を増やすより、**一度だけ走らせて JSON にする**方が良いと判断した。
日程表は版で管理されている資料で、毎回パースするものではない。
IRIS は出来上がった JSON だけを読む。

格子の形（実測 2026-08-27、2026-09-04 に訂正）:
  1日 = 8列。左端が日付、続く7列が1〜7限。1行が1週で、月〜金が横に並ぶ。
  **曜日は月ブロックの先頭の週にしか書かれていない。**
  **月見出しは左端の細い列にある** — 数字の下に「月」が置かれている。

2026-09-04 の訂正。もとは「日付行の下に曜日行がある」ことを日付行の条件に
していたので、曜日行を持たない週（＝ほとんどの週）の日付が捨てられ、**曜日行を
持つ別の週まで遡って、そこの日番号を使っていた。**7件中5件が最大3週ずれていた。

検算に使っていた2件（神経科学本試験 8/24・微生物免疫学試験 8/28）は月ブロックの
先頭の週にあったので、たまたま正しく出ていた。**通った検算が、壊れた仕組みを
正しく見せていた。**

いまは月を読む。(日, 曜日) から月を推測することはしない。曜日は計算して、
列の並びと合っているかの**検算**にだけ使う。

使い方:
  python3 scripts/extract-schedule.py <pdf> <出力json> [開始年] [学年]

学年（M1〜M6）を指定すると、そのページだけを見る。日程表は学年ごとに
ページが分かれていて（p2-3=M1, p4-5=M2, …）、指定しないと他学年の
CBT本試験や総合試験まで拾ってしまう — 自分が受けない試験のカウントダウンは
出してはいけない。
"""
import bisect
import json
import re
import sys
from datetime import date

WEEKDAYS = '月火水木金土日'
# `server/services/exam.ts` と同じ規則。二重定義しないため、変えるときは両方。
EXAM = re.compile(r'試験|考査|模試|CBT|OSCE')
RETAKE = re.compile(r'再試|追試|\(再\)|（再）|（再$|\(再$')
# 他学年の予定が M2 のページに注記として載っている。自分が受けない試験の
# カウントダウンは害にしかならないので落とす。特別編入学試験と CBT 説明会も
# 学生本人が受けるものではない。「設営」は試験そのものではなく会場の準備で、
# その日に何かがあるわけではない。
OTHERS = re.compile(r'[（(]M[13456][）)]|特別編入学試験|CBT説明会|OSCE|設営')


def rules(page):
    """罫線から列境界と行境界を作る。

    単語の x 間隔から列を推測してはならない。実測では、隣り合う日の間隔が 272 で
    二日離れた間隔が 899 だった — 間隔は一定ではない。
    """
    xs, ys = set(), set()
    # 縦線は y の範囲ごと覚える。**どこまで伸びているかが、結合セルの境目。**
    verticals = []
    for item in page.get_drawings():
        for op in item['items']:
            if op[0] == 'l':
                (x0, y0), (x1, y1) = op[1], op[2]
                if abs(x0 - x1) < 1.5:
                    xs.add(round(x0, 1))
                    verticals.append((round(x0, 1), min(y0, y1), max(y0, y1)))
                if abs(y0 - y1) < 1.5:
                    ys.add(round(y0, 1))
            elif op[0] == 're':
                r = op[1]
                xs.update([round(r.x0, 1), round(r.x1, 1)])
                ys.update([round(r.y0, 1), round(r.y1, 1)])
                verticals.append((round(r.x0, 1), r.y0, r.y1))
                verticals.append((round(r.x1, 1), r.y0, r.y1))

    def dedup(values, tol=3):
        out = []
        for v in sorted(values):
            if not out or v - out[-1] > tol:
                out.append(v)
        return out

    return dedup(xs), dedup(ys), verticals


def page_weekdays(words):
    """ページの一番上に並ぶ曜日の見出し。

    レイアウトが二種類ある。週ブロックごとに「日付の行 → 曜日の行」が並ぶページと、
    曜日がページ全体の見出しとして最上部に一度だけ置かれ、日付だけが各週に並ぶ
    ページ。後者では週ブロックの直下に曜日が無いので、こちらを使う。
    """
    marks = [w for w in words if w[4] in WEEKDAYS]
    if len(marks) < 3:
        return []
    top = min(w[1] for w in marks)
    return sorted([w for w in marks if w[1] < top + 5], key=lambda w: w[0])


DAY_COLUMN_TOL = 8


def month_labels(words):
    """左端の細い列にある月見出し。数字の下に「月」が置かれている。

    月は**読む**。(日, 曜日) から推測すると候補が複数残り、絞れないものを
    埋めた瞬間に一週間ずれた日付が出る。読める見出しがあるなら読む。
    """
    found = {}
    for word in words:
        if word[4] != '月' or word[0] >= 120:
            continue
        above = [
            w for w in words
            if w[0] < 120 and re.fullmatch(r'\d{1,2}', w[4]) and 0 < word[1] - w[1] < 30
        ]
        if above:
            nearest = min(above, key=lambda w: word[1] - w[1])
            found[round(nearest[1])] = int(nearest[4])
    return sorted(found.items())


def day_columns(rows, words):
    """日番号が立っている x を、頻度から学ぶ。

    時限の中にも数字はある（「病理学Ⅱ43-44」の 43 など）。x で切らないと
    それを日付として拾い、その行の月が一つ進んでしまう。日番号の x は
    ページ内で一定なので、多い順に5本取れば日付の列になる。
    """
    seen = {}
    for r in range(len(rows)):
        y0 = rows[r]
        y1 = rows[r + 1] if r + 1 < len(rows) else float('inf')
        for w in words:
            if y0 <= w[1] < y1 and re.fullmatch(r'\d{1,2}', w[4]) and w[0] >= 120:
                seen[round(w[0])] = seen.get(round(w[0]), 0) + 1
    picked = []
    for x, _ in sorted(seen.items(), key=lambda kv: -kv[1]):
        if all(abs(x - p) > DAY_COLUMN_TOL * 3 for p in picked):
            picked.append(x)
        if len(picked) == 5:
            break
    return sorted(picked)


def day_rows(rows, words, columns):
    """週の行。日付の列に立っている数字だけを数える。"""
    out = []
    for r in range(len(rows)):
        y0 = rows[r]
        y1 = rows[r + 1] if r + 1 < len(rows) else float('inf')
        nums = [
            w for w in words
            if y0 <= w[1] < y1 and re.fullmatch(r'\d{1,2}', w[4])
            and any(abs(w[0] - c) <= DAY_COLUMN_TOL for c in columns)
        ]
        nums.sort(key=lambda w: w[0])
        if 3 <= len(nums) <= 5:
            out.append((y0, y1, nums))
    return out


def grid(rows, words, year_start):
    """ページを (週の上端, 下端, [(x, 日付)]) の並びにする。

    月は見出しから取り、日番号が前より小さくなったところで次の月に進む。
    ページ最初の週が月をまたいでいる場合は、見出しの一つ前の月から始める
    （10月の見出しの下で 9/28 から始まる週がある）。
    """
    labels = month_labels(words)
    columns = day_columns(rows, words)
    weeks = day_rows(rows, words, columns)
    if not labels or not weeks:
        return []

    first = [int(w[4]) for w in weeks[0][2]]
    wraps = any(b < a for a, b in zip(first, first[1:]))
    month = labels[0][1] - (1 if wraps else 0)
    year = year_start if month >= 4 else year_start + 1
    if month == 0:
        month, year = 12, year_start

    out = []
    previous = 0
    for y0, y1, nums in weeks:
        cells = []
        for w in nums:
            day = int(w[4])
            if day < previous:
                month += 1
                if month == 13:
                    month, year = 1, year + 1
            previous = day
            try:
                cells.append((w[0], date(year, month, day)))
            except ValueError:
                cells.append((w[0], None))
        out.append((y0, y1, cells))
    return out


def breaks(week_grid):
    """日付の並びが壊れている箇所。**格子が読めているかの検算。**

    ここが空でなければ、月の繰り上げか日付の列取りが狂っている。件数を
    返すだけで直しはしない — 直せない狂いを黙って埋めるのが、この道具で
    一番やってはいけないこと。

    もとは「1日違いでなければ不一致」だった。**大学は日を飛ばす。**
    2027-02-08 の週は 月8・火9・水10・木11（建国記念の日）ときて、
    五列目が **土13** —— 金12 を飛ばして土曜を振替に使っている。
    実在する紙面を「読み違い」と呼んで、二月以降の突き合わせを丸ごと
    拒んでいた。

    捕まえたいのは**戻る**日付と**大きく飛ぶ**日付。もとの不具合（7件中5件が
    最大3週ずれた）はどちらもこの形で出る。週の中で2〜3日進むのは、
    振替と祝日の並びであって狂いではない。
    """
    found = []
    for y0, _, cells in week_grid:
        for (_, a), (_, b) in zip(cells, cells[1:]):
            if not a or not b:
                continue
            step = (b - a).days
            if step < 1 or step > 3:
                found.append((round(y0), a.isoformat(), b.isoformat()))
    return found


def date_of(word, week_grid):
    """ある語の日付。週の行を見つけ、その語より左にある一番近い日付の列。"""
    row = next((cells for y0, y1, cells in week_grid if y0 <= word[1] < y1), None)
    if row is None:
        return None
    fits = [d for x, d in row if x <= word[0] + 5]
    return fits[-1] if fits else None


def pages_for(doc, grade):
    """その学年のページ番号（0始まり）。

    日程表は学年ごとにページが分かれていて、見出しに M1〜M6 が入っている。
    指定しなければ全ページ — ただしそれは他学年の試験まで拾うということで、
    自分が受けない試験のカウントダウンを出すのは害にしかならない。
    """
    if not grade:
        return list(range(doc.page_count))
    out = []
    for i in range(doc.page_count):
        # ページ全体を見る。見出しは先頭にあるとは限らず、テキスト順では
        # 時限の数字が先に並ぶ。そして `\bM2\b` は効かない —
        # 「M2講義」の 2 と 講 の間に語境界は無い（どちらも語構成文字）。
        text = doc[i].get_text()
        if re.search(rf'{grade}講義|{grade}本試験|{grade}および|{grade}学士|{grade}[（(]', text):
            out.append(i)
    return out


def words_split_at_rules(page, verticals):
    """語を、列の罫線をまたぐところで割る。

    PyMuPDF の `get_text('words')` は空白で語を切る。隣り合うセルの文字列に
    空白が無いと**二つのセルが一語になる** —— 「（精神）★地域」が x=1365〜1473 で
    列の境 1419 をまたぎ、語の左端で列を決める `cells` が丸ごと 5限に落とした。
    6限には二行目の「医療1」だけが残り、題名は「療4」のような断片になった
    （実測 2026-09-15、地域医療1〜4 が暦と突き合わなかった原因）。

    文字ごとの箱（`rawdict`）で読み直し、次の文字が罫線の向こう側にあれば
    そこで語を切る。切る罫線は**その文字の高さに実在するもの**だけ。ページ
    全体の縦線で切ると、他の行の仕切りが結合セルの文字列を割る（「薬理学52-54」
    が「薬 理学52- 54」になった）。

    行の中では span をまたいで続ける。`get_text('words')` と同じく、空白と、
    ここで足す罫線だけが語の切れ目。返す形は同じ八つ組。
    """
    out = []

    def side(x, y):
        return sum(1 for vx, vy0, vy1 in verticals if vx <= x and vy0 - 2 <= y <= vy1 + 2)

    raw = page.get_text('rawdict')
    for bi, block in enumerate(raw.get('blocks', [])):
        for li, line in enumerate(block.get('lines', [])):
            chars = [ch for span in line.get('spans', []) for ch in span.get('chars', [])]
            cur = None  # [x0, y0, x1, y1, text, side]
            wi = 0
            for ch in chars:
                c = ch['c']
                x0, y0, x1, y1 = ch['bbox']
                if c.isspace():
                    if cur:
                        out.append((cur[0], cur[1], cur[2], cur[3], cur[4], bi, li, wi)); wi += 1; cur = None
                    continue
                sd = side((x0 + x1) / 2, (y0 + y1) / 2)
                if cur and sd != cur[5]:
                    out.append((cur[0], cur[1], cur[2], cur[3], cur[4], bi, li, wi)); wi += 1; cur = None
                if cur is None:
                    cur = [x0, y0, x1, y1, c, sd]
                else:
                    cur[2] = max(cur[2], x1); cur[1] = min(cur[1], y0); cur[3] = max(cur[3], y1); cur[4] += c
            if cur:
                out.append((cur[0], cur[1], cur[2], cur[3], cur[4], bi, li, wi))
    return out


def cells(page, cols, rows, words, verticals):
    """セル単位のテキスト。

    語単位で拾うと題名が割れる — 「16定期試験」「期試験」「（試験」のような
    断片が並び、何の試験か分からなくなる。セルの中の語をまとめて一つにする。

    **列はその行に実在する縦線だけで作る。**ページ中の縦線をすべて使うと、
    別の行の仕切りが結合セルを横切って題名を割る。「分子細胞生物学中間試験(1)
    （該当者）」の「（該当者）」が落ちていたのがそれで、**再実施の回が本試験と
    同じ顔で並んでいた。**
    """
    out = []
    for ri in range(len(rows) - 1):
        top, bottom = rows[ri], rows[ri + 1]
        height = bottom - top
        here = sorted({
            x for x, y0, y1 in verticals
            if y0 <= top + height * 0.25 and y1 >= bottom - height * 0.25
        })
        bounds = [c for c in cols if any(abs(c - x) < 3 for x in here)]
        if len(bounds) < 2:
            bounds = list(cols)
        for ci in range(len(bounds) - 1):
            inside = [
                w for w in words
                if bounds[ci] <= w[0] < bounds[ci + 1] and top <= w[1] < bottom
            ]
            if not inside:
                continue
            inside.sort(key=lambda w: (round(w[1]), w[0]))
            text = ' '.join(w[4] for w in inside).strip()
            if text:
                # セルの左右も返す。**結合セルの幅が、そのまま何コマぶんか。**
                out.append((text, inside[0], bounds[ci], bounds[ci + 1]))
    return out


# ── 時限の時刻 ────────────────────────────────────────────
#
# **PDF には書かれていない。**13ページを全部見て、時刻らしき記載は
# 「16:30/18:00」（2ページ）と「16:20/17:50」（10-11ページ）だけで、
# どれも個別の催しのもの。時限の対応表は載っていない。
#
# なので**カレンダーから測った。**2026-08-18〜09-08 の3週間で、授業らしき
# 予定の開始時刻を数えた結果:
#
#     08:30 ×7   09:40 ×1   10:50 ×1   12:50 ×8   14:00 ×2
#
# 70分刻みで、昼を挟んで 12:50 から後半。6限・7限はこの期間に出て
# いないので、**同じ刻みの外挿**として書いてある —— measured ではない。
# 印を分けてあるのは、外挿を実測の顔で出さないため。
PERIOD_TIMES = {
    1: ('08:30', 'measured'),
    2: ('09:40', 'measured'),
    3: ('10:50', 'measured'),
    4: ('12:50', 'measured'),
    5: ('14:00', 'measured'),
    6: ('15:10', 'extrapolated'),
    7: ('16:20', 'extrapolated'),
}

# 授業として出さないもの。日付そのもの、丸括弧だけの注記（部屋や担当）、
# そして他学年・催しの類。**試験は `exams` の側にあるので重複させない。**
NOT_A_LECTURE = re.compile(r'^[（(].*[）)]$|^\d{1,2}$|^[月火水木金土日]$')

# 祝日と休みは授業ではない。
#
# 最初の版は「敬老の日」を 3限の授業として出した —— 文字が日の真ん中に置かれる
# ので、列から時限を取ると 10:50 になる。**紙の上の位置は、意味ではない。**
#
# 名前を並べるのは、この PDF に祝日の印が無いから。国民の祝日は数が決まって
# いて増減が稀なので、規則より一覧の方が確か。増えたらここに足す。
HOLIDAY = re.compile(
    r'元日|成人の日|建国記念|天皇誕生日|春分の日|昭和の日|憲法記念日|みどりの日|'
    r'こどもの日|海の日|山の日|敬老の日|秋分の日|スポーツの日|文化の日|勤労感謝|'
    r'振替休日|国民の休日|休講|休業|夏季休業|冬季休業'
)


def day_bounds(cols, x_of_date):
    """その日の列の境目。日付の列の右から、60幅で7本。

    実測（2026-09-09 の週、M2）:
      1027.4 | 1059.2 | 1119.2 | 1179.2 | 1239.2 | 1299.2 | 1359.2 | 1419.2 | 1479.2
        日付      1限     2限      3限      4限      5限      6限      7限

    幅を決め打ちにせず、**その行に実在する縦線から取る。**紙の版が変われば
    幅も変わる。
    """
    right = [c for c in cols if c > x_of_date]
    return right[:8]


def span_of(left, right, bounds):
    """セルが何コマぶんか。**結合セルの幅から数える。**

    題名の番号（「病理学Ⅱ31-32」の 31-32）から数えていたが、番号を持たない
    授業が 77件中 59件あった（「琉大祭準備」「動物実験の基礎」など）。
    番号が無いものの長さを既定値で埋めると、**推測が予定の顔でカレンダーに
    入る。**紙の上の幅は測れるので、そちらを数える。
    """
    inside = [b for b in bounds if left - 2 <= b <= right + 2]
    return max(1, len(inside) - 1) if len(inside) >= 2 else None


def period_of(word_x, bounds):
    """語がどの時限の列にあるか。日付の列なら `None`。"""
    for i in range(len(bounds) - 1):
        if bounds[i] <= word_x < bounds[i + 1]:
            # bounds[0] は日付の列の右端＝1限の左端。
            return i + 1
    return None


def main():
    import fitz

    pdf, out = sys.argv[1], sys.argv[2]
    year_start = int(sys.argv[3]) if len(sys.argv) > 3 else 2026
    grade = sys.argv[4] if len(sys.argv) > 4 else None
    doc = fitz.open(pdf)

    exams, lectures, unresolved, faults = [], [], [], []
    for i in pages_for(doc, grade):
        page = doc[i]
        cols, rows, verticals = rules(page)
        # 語は列の罫線で割る。`get_text('words')` は空白でしか切らない。
        words = words_split_at_rules(page, verticals)
        week_grid = grid(rows, words, year_start)
        # 格子が読めていなければ、その紙の結果は信用しない。
        for y0, a, b in breaks(week_grid):
            faults.append({'page': i + 1, 'y': y0, 'between': [a, b]})

        for title, anchor, cell_left, cell_right in cells(page, cols, rows, words, verticals):
            # 空白を落としてから判定する。セルの中で語が折り返されると
            # 「（再 試）」のように空白が入り、**再試が本試験として通る。**
            probe = re.sub(r'\s+', '', title)

            when_any = date_of(anchor, week_grid)
            if (when_any and not EXAM.search(probe)
                    and not NOT_A_LECTURE.match(probe) and not HOLIDAY.search(probe)):
                bounds = day_bounds(cols, next(
                    (x for x, d in next(
                        (cs for y0, y1, cs in week_grid if y0 <= anchor[1] < y1), []
                    ) if d == when_any), anchor[0]
                ))
                # 時限は**セルの左端**から。文字の位置からではない。
                #
                # 一日ぶんに広がったセル（「琉大祭準備」）は文字が真ん中に
                # 置かれるので、語の x を見ると 3限になる。**紙の上の位置は
                # 意味ではない** —— 祝日を 10:50 の授業にしたのと同じ間違い。
                period = period_of(cell_left + 2, bounds) if bounds else None
                span = span_of(cell_left, cell_right, bounds) if bounds else None
                clock, basis = PERIOD_TIMES.get(period, (None, None))
                lectures.append({
                    'title': title,
                    'page': i + 1,
                    'date': when_any.isoformat(),
                    'weekday': WEEKDAYS[when_any.weekday()],
                    'period': period,
                    # 何コマぶんか。紙の上の幅から。読めなければ null。
                    'span': span,
                    # 時刻が決まらないものは `null`。**推測で埋めない。**
                    'start': clock,
                    # measured か extrapolated か。読む側が重みを変えられるように。
                    'startBasis': basis,
                })

            if not EXAM.search(probe) or RETAKE.search(probe) or OTHERS.search(probe):
                continue
            when = date_of(anchor, week_grid)
            row = {'title': title, 'page': i + 1, 'date': when.isoformat() if when else None}
            if when:
                row['weekday'] = WEEKDAYS[when.weekday()]
                row['day'] = when.day
                # 試験にも時限を。授業と同じく**セルの左端**から測る。
                #
                # 試験は日付だけ持っていて、時刻はカレンダーに入れる人が決めて
                # いた。2026-09-16 の再試は 10:50 で入っていて、紙は 9/17 の
                # 1〜3限だった —— 日も時刻も紙に根拠が無かった。**測れるものを
                # 測らずに人に決めさせると、決めた値が根拠の顔をする。**
                bounds = day_bounds(cols, next(
                    (x for x, d in next(
                        (cs for y0, y1, cs in week_grid if y0 <= anchor[1] < y1), []
                    ) if d == when), anchor[0]
                ))
                period = period_of(cell_left + 2, bounds) if bounds else None
                span = span_of(cell_left, cell_right, bounds) if bounds else None
                clock, basis = PERIOD_TIMES.get(period, (None, None))
                row.update({'period': period, 'span': span, 'start': clock, 'startBasis': basis})
            (exams if when else unresolved).append(row)

    exams.sort(key=lambda e: (e['date'], e['title']))
    lectures.sort(key=lambda e: (e['date'], e['period'] or 99, e['title']))
    json.dump(
        {
            'source': pdf.split('/')[-1],
            'yearStart': year_start,
            'exams': exams,
            # 授業。時限は列から、時刻は `PERIOD_TIMES` から。
            'lectures': lectures,
            'periodTimes': {str(k): {'start': v[0], 'basis': v[1]} for k, v in PERIOD_TIMES.items()},
            # Kept rather than dropped: an entry whose date could not be pinned
            # is a gap somebody should see, not one to fill with a guess.
            'unresolved': unresolved,
            # 空でなければ格子の読み違い。結果を鵜呑みにしないための印。
            'gridFaults': faults,
        },
        open(out, 'w', encoding='utf-8'),
        ensure_ascii=False,
        indent=2,
    )
    print(f'  試験 {len(exams)} 件 / 授業 {len(lectures)} 件 / 日付を決められなかったもの {len(unresolved)} 件 → {out}')
    noclock = sum(1 for l in lectures if not l['start'])
    if noclock:
        print(f'  ※ 時限を決められなかった授業 {noclock} 件（時刻は null のまま）')
    if faults:
        print(f'  ⚠ 格子の検算に {len(faults)} 件の不一致。日付を使う前に確かめてください:')
        for f in faults[:5]:
            print(f"    page {f['page']} y={f['y']}  {f['between'][0]} の次が {f['between'][1]}")


if __name__ == '__main__':
    main()
