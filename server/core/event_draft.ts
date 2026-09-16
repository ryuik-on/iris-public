/**
 * 打った一行を、予定の下書きにする。
 *
 * ここは**書く前**の段。実際にカレンダーへ入れるのは承認のあと。
 *
 * この機能でいちばん危ないのは、**取り違えた予定が正しい顔で座ること。**
 * 「来週の火曜3時」を一週ずらして読んでも、出来上がった予定は本物と
 * 見分けが付かない —— 日付が書いてあり、題名が付いていて、あなたのカレンダー
 * に並ぶ。読み違えは画面に出ないので、当日まで気づかない。
 *
 * だから三つ決めてある。
 *
 * **一。模型には絶対値しか書かせない。**「来週の火曜」ではなく
 * `2026-09-09T15:00`。確認の画面に出るのが解決済みの日付なら、**一週ずれて
 * いれば目で分かる。**言い回しをそのまま出すと、読み違えも一緒に隠れる。
 *
 * **二。分からなかったものは `null`。**既定の長さも、既定の場所も入れない。
 * 「1時間」と埋めてしまうと、**推測が入力と同じ顔になる。**
 *
 * **三。疑わしいものを数える。**過去の日付、一年より先、終わりが始まりより
 * 前 —— どれも「読み違えたときに出る形」で、正しい入力ではめったに出ない。
 * 出たら黙って直さず、疑いとして持ち上げる。
 */

/** 予定の下書き。**まだ何も書き込んでいない。** */
export interface EventDraft {
  title: string;
  /** `2026-09-09T15:00` の形。地方時、帯なし。終日なら `2026-09-09`。 */
  start: string;
  /** 終わり。**分からなければ `null`。既定の長さは入れない。** */
  end: string | null;
  allDay: boolean;
  location: string | null;
  /** 解釈できなかったもの。人に見せて、要るなら足してもらう。 */
  missing: string[];
  /** 解釈はしたが、読み違えの形をしているもの。 */
  doubts: string[];
}

/**
 * 時刻を指す言葉。**時計の数字ではないが、時刻が意図されている印。**
 *
 * これがあるのに終日で返ってきたら、時刻が落ちている。
 */
const TIME_WORDS = ['朝', '昼', '夕方', '夕', '夜', '午前', '午後', '晩', 'ランチ', 'ディナー'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * 模型に渡す文。
 *
 * **いまが何日かを渡す。**渡さないと「明日」を訓練時点から数える。これは
 * 一度どこかで必ず起きる種類の間違いで、渡すのは一行で済む。
 *
 * 曜日も渡す。「来週の火曜」を解くのに要るのは日付ではなく曜日で、
 * **模型に曜日を計算させると、そこが外れる。**
 */
export function buildPrompt(text: string, now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const w = '日月火水木金土'[now.getDay()];
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return [
    '次の一行を、カレンダーの予定として解釈してください。',
    '',
    `いまは ${y}-${m}-${d}（${w}曜）${hh}:${mm} です。`,
    '',
    `入力: ${text}`,
    '',
    'JSON だけを返してください。説明は要りません。',
    '',
    '{',
    '  "title": "予定の題名",',
    '  "start": "2026-09-09T15:00",',
    '  "end": "2026-09-09T16:00" または null,',
    '  "allDay": false,',
    '  "location": "場所" または null',
    '}',
    '',
    '決まり:',
    '- `start` と `end` は必ず絶対値。「来週の火曜」のような言い回しで返さない。',
    '- 終日の予定なら `allDay` を true にして、`start` は "2026-09-09" の形。',
    '- **書かれていないことは推測せず null。**終了時刻が書かれていなければ',
    '  `end` は null。長さを勝手に決めない。場所も同じ。',
    '- 題名は入力にある言葉で。無ければ入力そのものを短くしたものを使う。',
  ].join('\n');
}

/**
 * 模型の返事を下書きにする。読めなければ `null`。
 *
 * 前後に付いてくる ```json や説明文は落とす。**落とせなかったら諦める** ——
 * 部分的に読めた JSON から予定を組み立てると、欠けた場所に既定値が入る。
 */
export function parseDraft(raw: string, now: Date, heard?: string): EventDraft | null {
  const text = raw.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let value: any;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;

  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const allDay = value.allDay === true;
  const startAt = typeof value.start === 'string' ? value.start.trim() : '';
  const endAt = typeof value.end === 'string' && value.end.trim() ? value.end.trim() : null;
  const location =
    typeof value.location === 'string' && value.location.trim() ? value.location.trim() : null;

  // 始まりが無ければ予定にならない。**題名だけの予定は作らない。**
  const shape = allDay ? DATE : DATETIME;
  if (!shape.test(startAt)) return null;
  if (endAt !== null && !shape.test(endAt)) return null;

  const missing: string[] = [];
  const doubts: string[] = [];
  if (!title) missing.push('題名');
  if (!allDay && !endAt) missing.push('終了時刻');
  if (!location) missing.push('場所');

  /*
   * 疑いは、**読み違えたときに出る形**を数えたもの。
   *
   * 正しく打った予定がこの形になることはめったに無い。逆に、年を落として
   * 今年として読む・週を一つずらす・「来週」を月またぎで外す —— どれも
   * ここに落ちる。**直さずに持ち上げる**のは、直し方がこちらには分からない
   * から。日付を勝手にずらす方が、間違ったまま出すより悪い。
   */
  const startMs = Date.parse(allDay ? `${startAt}T00:00:00` : `${startAt}:00`);
  if (Number.isFinite(startMs)) {
    const dayMs = 86_400_000;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (startMs < today) doubts.push('過去の日付になっています');
    if (startMs > now.getTime() + 365 * dayMs) doubts.push('一年より先になっています');
  } else {
    return null;
  }
  if (endAt) {
    const endMs = Date.parse(allDay ? `${endAt}T00:00:00` : `${endAt}:00`);
    if (!Number.isFinite(endMs)) return null;
    if (endMs < startMs) doubts.push('終わりが始まりより前になっています');
  }

  /*
   * 時間帯の言葉があるのに終日になっているとき。
   *
   * 「金曜の夜ごはん」が `allDay: true` で返ってきた（実測）。**時刻を
   * 落としたことが、終日という意図的な指定に化けている。**「9/20 出張」の
   * 終日と画面上で見分けが付かないので、見ても気づけない。
   *
   * 何時かはこちらにも分からない —— 「夜」は 18時かもしれないし 20時
   * かもしれない。**だから埋めずに、落ちたことだけを言う。**
   */
  if (allDay && heard && TIME_WORDS.some((w) => heard.includes(w))) {
    const said = TIME_WORDS.filter((w) => heard.includes(w)).join('・');
    doubts.push(`「${said}」とありますが終日になっています`);
  }

  return { title, start: startAt, end: endAt, allDay, location, missing, doubts };
}

/**
 * 人に見せる一行。**確認はこれを読んで行う。**
 *
 * 解決済みの絶対値だけを出す。打った言い回し（「来週の火曜」）は出さない
 * ——並べると、読み違えていても「そう書いたから」で通ってしまう。**確認は
 * 入力との一致ではなく、結果が正しいかを見る作業。**
 */
export function describeDraft(draft: EventDraft): string {
  const day = draft.start.slice(0, 10);
  const at = new Date(`${day}T00:00:00`);
  const w = '日月火水木金土'[at.getDay()];
  const date = `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日(${w})`;
  if (draft.allDay) return `${date} 終日`;
  const from = draft.start.slice(11);
  return draft.end ? `${date} ${from}〜${draft.end.slice(11)}` : `${date} ${from}〜`;
}
