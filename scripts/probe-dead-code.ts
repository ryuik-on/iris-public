/**
 * 誰も読んでいないコードを探す。
 *
 * 二通りで見る。**入口から辿り着かないファイル**と、**宣言以外にどこにも名前が
 * 出てこない実行時の export。**どちらも候補であって、削除の決定ではない。
 *
 * 2026-09-29 にこれで出てきたもの:
 *
 *   `src/Core.tsx`（72 KB）—— 手続きで描いていた頃のコア。画面は絵を流す
 *   `NebulaCore` に置き換わっていて、**消してもビルドのハッシュが一字も変わら
 *   なかった**（出荷物に入っていなかったことの証拠）。
 *
 *   `BudgetPanel` / `CliUsagePanel` / `PortfolioPanel`（計 336 行）—— 2026-08-21 に
 *   「同じ数字を二箇所に出すと片方が必ず古くなる」として画面から外され、関数だけが
 *   残っていた。
 *
 * **型と interface は数えない。**署名に使われていて、消すと嘘になる。実行時に
 * 残るものだけを見る。
 *
 * ## この見方で拾えないもの
 *
 * **文字列越しの参照。**`BudgetPanel` は
 * `server/data/future_features_seed.ts` に文字列として名前が入っていたので、
 * 「使われている」側に数えられていた。実際には画面から外れていて、**完了と
 * 記録された機能の証拠が古くなっていた** —— 消す前に、名前で grep して
 * 何が指しているかを見ること。
 *
 * 動的な読み込み（`import(変数)`）と、設定ファイル越しの入口も見えない。
 *
 * Run: npx tsx scripts/probe-dead-code.ts [root]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = process.argv[2] || process.cwd();
const SKIP = ['node_modules', '.git', 'dist', 'dist-server', '.iris', 'artifacts', 'backups'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

// ── 入口から辿る ────────────────────────────────────────────
/** 入口：サーバ本体、画面の入口、そして `scripts/` は一本ずつが入口。 */
const entries = files.filter((f) => {
  const r = relative(ROOT, f);
  return r === 'server/index.ts' || r === 'src/main.tsx' || r.startsWith('scripts/');
});

const IMPORT =
  /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  // `./x.js` は TypeScript の書き方で、実体は `./x.ts`。
  for (const c of [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'),
                   base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const reached = new Set<string>();
const queue = [...entries];
while (queue.length) {
  const file = queue.pop()!;
  if (reached.has(file)) continue;
  reached.add(file);
  for (const m of (texts.get(file) ?? '').matchAll(IMPORT)) {
    const target = resolveImport(file, m[1] || m[2] || m[3] || '');
    if (target && !reached.has(target)) queue.push(target);
  }
}

// `vite.config.ts` は vite 自身の入口で、誰からも import されなくて当たり前。
const CONFIGS = /(^|\/)(vite|vitest|tailwind|postcss)\.config\.ts$/;
const orphanFiles = files
  .filter((f) => !reached.has(f) && !CONFIGS.test(relative(ROOT, f)))
  .map((f) => ({ path: relative(ROOT, f), bytes: statSync(f).size }))
  .sort((a, b) => b.bytes - a.bytes);

// ── 呼ぶ側のいない export ──────────────────────────────────
const DECL = /export\s+(?:async\s+)?(function|class|const|let)\s+([A-Za-z_$][\w$]*)/g;
const orphanExports: Array<{ file: string; kind: string; name: string }> = [];

for (const [file, text] of texts) {
  const rel = relative(ROOT, file);
  // 入口の export は外から呼ばれない（走らせるためのファイル）。
  if (rel.startsWith('scripts/')) continue;
  for (const [, kind, name] of text.matchAll(DECL)) {
    let uses = 0;
    for (const body of texts.values()) uses += body.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
    // 宣言そのもので 1 回。それ以外に出てこなければ、呼ぶ側がいない。
    if (uses <= 1) orphanExports.push({ file: rel, kind, name });
  }
}

console.log(`入口 ${entries.length} 本から ${reached.size} / ${files.length} 本に到達`);
console.log(`\n■ 辿り着かないファイル: ${orphanFiles.length}`);
for (const f of orphanFiles) console.log(`  ${(f.bytes / 1024).toFixed(0).padStart(5)} KB  ${f.path}`);
console.log(`\n■ 呼ぶ側のいない export: ${orphanExports.length}`);
for (const e of orphanExports) console.log(`  ${e.kind.padEnd(8)} ${e.name.padEnd(28)} ${e.file}`);
console.log('\n消す前に、名前で grep してください。文字列越しの参照はここに出ません。');
