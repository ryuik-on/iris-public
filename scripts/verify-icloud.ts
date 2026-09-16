/**
 * One live read of the iCloud calendars, over CalDAV.
 *
 *   npx tsx scripts/verify-icloud.ts
 */
import 'dotenv/config';
import { CaldavCalendarClient } from '../server/services/caldav_calendar.js';
import { CalendarUnavailableError } from '../server/services/calendar.js';

async function main() {
  const client = new CaldavCalendarClient({
    appleId: process.env.ICLOUD_APPLE_ID?.trim() ?? '',
    appPassword: process.env.ICLOUD_APP_PASSWORD?.trim() ?? '',
    onEvent: ({ type, detail }) => console.log(`  · ${type}`, JSON.stringify(detail ?? {}, null, 0)),
  });

  if (!client.configured()) {
    console.log('ICLOUD_APPLE_ID と ICLOUD_APP_PASSWORD を .env に設定してください。');
    process.exit(1);
  }

  try {
    const reading = await client.read(14);
    console.log(`\nカレンダー ${reading.calendarsVisible} 件: ${reading.calendarNames.join(' / ')}`);
    console.log(`繰り返しの展開: ${reading.expanded ? 'サーバ側で実施' : '未実施（サーバが対応していない）'}`);
    console.log(`予定 ${reading.events.length} 件 / ${reading.elapsedMs}ms\n`);
    for (const e of reading.events) {
      console.log(`  ${(e.start ?? '').padEnd(26)} ${e.title}  [${e.calendar}]`);
    }
  } catch (err) {
    const e = err as CalendarUnavailableError;
    console.log(`\n失敗: ${e.message}`);
    if (e.code) console.log(`コード: ${e.code}`);
    if (e.hint) console.log(`対処: ${e.hint}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
