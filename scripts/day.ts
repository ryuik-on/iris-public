/**
 * 今日を一枚、端末に。
 *
 * 「コマンドで一発で出せる？」（利用者、2026-09-09）。画面の帯と同じものを
 * 端末で見るためのもの。**同じ口（`/api/schedule`）を読む** —— 別に数えると、
 * 画面と端末で違うことを言う日が来る。
 *
 * Run: npm run day  ／  npm run day -- 2
 */

const BASE = process.env.IRIS_URL ?? 'http://127.0.0.1:3002';
const FROM = 8 * 60;
const TO = 24 * 60;
/** 一行が何分か。30分だと32行になって端末に収まらない。 */
const STEP = 60;
/** 帯の幅（文字）。 */
const WIDTH = 28;

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[38;5;75m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[38;5;179m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface Ev { title: string; start: string; end: string | null; allDay: boolean }

const minutes = (iso: string) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const span = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}` : `${m}分`);

async function main() {
  const days = Math.max(1, Math.min(7, Number(process.argv[2]) || 1));
  let reading: any;
  try {
    const res = await fetch(`${BASE}/api/schedule?days=${days}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    reading = await res.json();
  } catch (err: any) {
    // **読めなかったことを、予定が無いことにしない。**
    console.error(`IRIS を読めませんでした: ${err?.message ?? err}`);
    process.exit(1);
  }

  if (reading.blocked) console.log(c.amber(reading.blocked) + '\n');

  const byDay = new Map<string, Ev[]>();
  for (const e of reading.events as Ev[]) {
    const key = e.start.slice(0, 10);
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(e);
  }

  const now = new Date();
  const today = now.toLocaleDateString('sv');
  const free = new Map((reading.free ?? []).map((f: any) => [f.date, f]));

  for (const date of [...byDay.keys()].sort().slice(0, days)) {
    const events = (byDay.get(date) ?? []).filter((e) => !e.allDay && e.start.length >= 16);
    const allDay = (byDay.get(date) ?? []).filter((e) => e.allDay);
    const at = new Date(`${date}T00:00:00`);
    const w = '日月火水木金土'[at.getDay()];
    const head = `${at.getMonth() + 1}/${at.getDate()}(${w})${date === today ? ' 今日' : ''}`;

    const slots = (free.get(date) as any)?.slots ?? [];
    const left = slots.map((s: any) => `${s.from}-${s.to}`).join('  ');
    const last = events.length
      ? Math.max(...events.map((e) => (e.end && e.end.length >= 16 ? minutes(e.end) : minutes(e.start))))
      : null;
    console.log(`\n${c.bold(head)}  ${last !== null ? c.dim(`終わり ${clock(last)}`) : ''}   ${c.dim(left || '空きなし')}`);
    // 終日は帯に置けない（始まりも終わりも無い）ので、見出しの下に並べる。
    for (const e of allDay) console.log(c.dim(`  終日  ${e.title}`));

    const nowM = now.getHours() * 60 + now.getMinutes();
    for (let m = FROM; m < TO; m += STEP) {
      const covered = (a: number, b: number) =>
        events.some((e) => {
          const s = minutes(e.start);
          const t = e.end && e.end.length >= 16 ? minutes(e.end) : s + 30;
          return s < b && t > a;
        });
      // 一行を WIDTH 区画に割って、埋まっている区画だけ塗る。1文字 = 2.5分。
      let bar = '';
      for (let i = 0; i < WIDTH; i++) {
        const a = m + (STEP / WIDTH) * i;
        bar += covered(a, a + STEP / WIDTH) ? '█' : '·';
      }
      const label = events
        .filter((e) => { const s = minutes(e.start); return s >= m && s < m + STEP; })
        .map((e) => {
          const s = minutes(e.start);
          const t = e.end && e.end.length >= 16 ? minutes(e.end) : null;
          return `${clock(s)}${t !== null ? `-${clock(t)}` : ''}  ${e.title}`;
        })
        .join('  /  ');
      const hour = m % 120 === 0 ? String(m / 60).padStart(2, '0') : '  ';
      const here = date === today && nowM >= m && nowM < m + STEP;
      const mark = here ? c.amber('◀') : ' ';
      console.log(`  ${c.dim(hour)} ${c.blue(bar)} ${mark} ${label}`.trimEnd());
    }
  }
  console.log('');
}

main();
