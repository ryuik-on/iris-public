/**
 * 返事の書式が、書いたとおりに出るか。
 *
 * 一日で三度壊した — 素の文字で出して `**` が画面に出た、囲みを緩めて
 * **囲まれた文章が消えた**、組の番号を一つずらして**印そのものを中身として
 * 描いた**。どれも「動いてはいる」ので、目で見るまで分からない。
 *
 * 確かめるのは見た目ではなく、**文字が残っているか**。強調が効いていなくても
 * 読めるが、文章が消えるのは取り返しがつかない。
 *
 * Run: npx tsx scripts/test-markdown.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/markdown.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) { console.log(`\n▸ ${name}`); }
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`); console.log(`  ✗ ${name}`); }
}

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);
/** 印を落としたあとの、読める文字だけ。 */
const plain = (text: string) => html(text).replace(/<[^>]+>/g, '');

function main() {
  section('囲まれた文章が消えない');
  eq(
    '二つの強調が並んでも中身が残る',
    plain('構想について、**利用料金**および**推奨構成**を整理します。'),
    '構想について、利用料金および推奨構成を整理します。'
  );
  eq(
    '強調の中に code があっても通る',
    plain('**あなたの `agy` を使う場合**'),
    'あなたの agy を使う場合'
  );
  eq('斜体と太字が同じ行にあっても崩れない', plain('*斜体* と **太字**'), '斜体 と 太字');

  section('印そのものを描かない');
  eq('`**` が画面に残らない', /\*\*/.test(plain('**強調**')), false);
  eq('強調は strong になる', /<strong[^>]*>強調<\/strong>/.test(html('**強調**')), true);
  eq('code は code になる', /<code[^>]*>agy<\/code>/.test(html('`agy`')), true);

  section('印にならないものは、そのまま');
  eq('掛け算の星は残る', plain('2 * 3 * 4 の答え'), '2 * 3 * 4 の答え');
  eq('閉じていない強調はそのまま', plain('**閉じていない'), '**閉じていない');

  console.log('\n' + '─'.repeat(60));
  console.log(`Markdown: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All markdown tests passed.');
}

main();
