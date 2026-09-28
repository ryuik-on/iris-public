import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/services/db.js';
import { MemoryStore } from '../server/services/memory_sqlite.js';
import { Concerns, createConcernTools, CONCERN_KIND } from '../server/core/concerns.js';
import { RiskLevel } from '../server/core/types.js';

const dir = mkdtempSync(join(tmpdir(), 'iris-concerns-test-'));
let db = openDatabase(join(dir, 'test.db'));
try {
  let concerns = new Concerns(db);
  const input = { goal: '試験で自力で答案を書く', assessment: '演習結果は未確認', reviewWhen: '演習結果が届いたら', allowedScope: '学習計画の提案のみ', source: 'テスト用の明示的な依頼', status: 'active' as const };
  const first = concerns.save(input);
  assert.match(concerns.render(), /演習結果は未確認/);
  assert.throws(() => concerns.save(input), /同じ目標/);
  assert.equal(concerns.save({ ...input, revision: first.revision }).changed, false);
  const next = concerns.save({ ...input, revision: first.revision, assessment: '演習で因果関係の説明に不足があった' });
  assert.equal(concerns.list().length, 1);
  assert.equal(new MemoryStore(db).get(first.revision)?.supersededBy, next.revision);
  assert.throws(() => concerns.save({ ...input, revision: first.revision }), /更新されています/);
  db.close();
  db = openDatabase(join(dir, 'test.db'));
  concerns = new Concerns(db);
  assert.match(concerns.render(), /因果関係/);
  const paused = concerns.save({ ...input, revision: next.revision, status: 'paused' });
  assert.equal(concerns.render(), '');
  assert.equal(concerns.list()[0].status, 'paused');
  concerns.save({ ...input, revision: paused.revision, status: 'completed' });
  assert.equal(concerns.render(), '');
  new MemoryStore(db).remember({ kind: CONCERN_KIND, content: JSON.stringify({ ...input, goal: 'PRIVATE' }), provenance: 'user', source: 'fixture', privacy: 'local_only' });
  assert.ok(!JSON.stringify(concerns.list()).includes('PRIVATE'));
  const tools = createConcernTools(concerns);
  assert.equal(tools.find(t => t.name === 'save_concern')?.riskLevel, RiskLevel.WRITE);
  assert.throws(() => concerns.save({ ...input, goal: '' }));
  console.log('PASS: persistence, revision history, no-op, duplicate/stale rejection, pause/completion, privacy, approval and validation');
} finally {
  db.close();
  rmSync(dir, { recursive: true });
}
