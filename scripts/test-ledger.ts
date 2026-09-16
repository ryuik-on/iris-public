/**
 * Reading somebody else's canonical record.
 *
 * The assertions that matter are the ones about not answering. A ledger reader
 * that returns an empty task list when the table moved, or when a row lost a
 * column, reports a quiet week — and a quiet week is what a broken check looks
 * like from the outside. Every failure here has to be countable.
 *
 * Run: npx tsx scripts/test-ledger.ts
 */
import {
  readTable,
  plain,
  identifier,
  taskStatus,
  summarise,
} from '../server/core/ledger_parse.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) {
  console.log(`\n▸ ${name}`);
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
    console.log(`  ✗ ${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
  }
}

const LEDGER = `# Active_Projects.md

## 管理対象外

旧課題は対象外です。

| 旧ID | 帰属 |
| --- | --- |
| T001 | Founder Development Program |

## Project 一覧

| Project ID | Project Name | Status | Notes |
| --- | --- | --- | --- |
| PRJ-001 | Recall | Active | Phase 2 Active (\`DEC-007\`)。 |

## Task 一覧

| Task ID | Project ID | Task | Status | Notes / Blocker |
| --- | --- | --- | --- | --- |
| TSK-001 | PRJ-001 | North Starを反映 | Done | 反映済み。 |
| TSK-010 | PRJ-001 | 結果を比較 | Blocked | 観測窓の完了が解除条件。 |
| TSK-011 | PRJ-001 | Backlogを決定 | Todo | 実測根拠は未取得。 |
`;

function main() {
  section('The right table, not the first one');

  {
    /**
     * The document gained a "管理対象外" section above its real tables. A
     * parser that took the first table would answer with the excluded-work
     * list and look exactly as healthy as one that worked.
     */
    const projects = readTable(LEDGER, 'Project 一覧');
    eq('the project table is found by its heading', projects.rows.length, 1);
    eq('with its own columns', projects.columns[0], 'Project ID');
    eq('and the right row', projects.rows[0]['Project Name'], 'Recall');

    const excluded = readTable(LEDGER, '管理対象外');
    eq('and a different heading gives a different table', excluded.columns[0], '旧ID');

    const tasks = readTable(LEDGER, 'Task 一覧');
    eq('the task table is separate', tasks.rows.length, 3);
  }

  section('A section with no table is not another section\'s table');

  {
    // The stop-at-next-heading rule. Without it, a heading whose table has not
    // been written yet silently borrows the next one.
    const missing = readTable('## 目的\n\n本書の目的です。\n\n## 一覧\n\n| A |\n| --- |\n| 1 |\n', '目的');
    eq('nothing is returned', missing.rows.length, 0);
    eq('and no columns are claimed', missing.columns, []);
  }

  section('A heading that is not there');

  {
    const absent = readTable(LEDGER, 'Decision 一覧');
    eq('is empty rather than the first table', absent.rows.length, 0);
    eq('and says it has no columns', absent.columns, []);
  }

  section('Rows that do not fit are counted, not dropped');

  {
    /**
     * The important one. A stray pipe shortens a table, and a shorter task
     * list reads as fewer things to do. Skipping quietly is how a ledger with
     * a typo starts reporting progress.
     */
    const broken = readTable(
      '## 一覧\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 |\n| 6 | 7 | 8 |\n',
      '一覧'
    );
    eq('the good rows are read', broken.rows.length, 2);
    eq('and the bad one is reported', broken.malformed, 1);
  }

  section('An escaped pipe is content, not a column');

  {
    const escaped = readTable('## 一覧\n\n| A | B |\n| --- | --- |\n| x \\| y | z |\n', '一覧');
    eq('the row holds together', escaped.rows.length, 1);
    eq('and the pipe survives as text', escaped.rows[0]['A'], 'x | y');
    eq('with no row miscounted', escaped.malformed, 0);
  }

  section('Reading a cell');

  {
    eq('a link becomes its text', plain('[LAB-001 Recall Lab](../01_Labs/README.md)'), 'LAB-001 Recall Lab');
    eq('code marks are removed', plain('`DEC-007`'), 'DEC-007');
    eq('and bold', plain('**選択式**'), '選択式');
    eq('plain text is unchanged', plain('Recall'), 'Recall');
    eq('nothing is empty', plain(undefined), '');

    eq('an id is found', identifier('TSK-010'), 'TSK-010');
    eq('through a link', identifier('[LAB-001 Recall Lab](../x.md)'), 'LAB-001');
    eq('a dash is not an id', identifier('—'), null);
    eq('nor is prose', identifier('CEO（暫定）'), null);
  }

  section('Status is matched, never guessed');

  {
    eq('Done', taskStatus('Done'), 'Done');
    eq('In Progress', taskStatus('In Progress'), 'In Progress');
    eq('Blocked', taskStatus('Blocked'), 'Blocked');
    eq('Todo', taskStatus('Todo'), 'Todo');

    /**
     * A status outside the four the ledger defines is unreadable, not the
     * nearest match. `Repository_Operations.md` §6.3 fixes the vocabulary, and
     * a mistyped one that became `Done` would mark work complete that nobody
     * completed.
     */
    eq('a near miss is not Done', taskStatus('done'), 'Unknown');
    eq('nor is a longer word', taskStatus('Done (pending review)'), 'Unknown');
    eq('an em dash is not a status', taskStatus('—'), 'Unknown');
    eq('and neither is nothing', taskStatus(undefined), 'Unknown');
  }

  section('What the summary counts');

  {
    const tasks = readTable(LEDGER, 'Task 一覧').rows.map((r) => taskStatus(r['Status']));
    const progress = summarise(tasks);
    eq('every row is counted once', progress.total, 3);
    eq('done', progress.done, 1);
    eq('blocked', progress.blocked, 1);
    eq('todo', progress.todo, 1);
    eq('and nothing was unreadable', progress.unknown, 0);

    // Unknown is its own count and is never folded into the others — an
    // unreadable status must not quietly become progress or a blocker.
    const withBad = summarise(['Done', 'Unknown', 'Unknown']);
    eq('unreadable rows stay separate', withBad, {
      total: 3,
      done: 1,
      blocked: 0,
      inProgress: 0,
      todo: 0,
      unknown: 2,
    });
    eq('and the parts still sum to the whole', withBad.done + withBad.unknown, withBad.total);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Ledger reading: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All ledger tests passed.');
}

main();
