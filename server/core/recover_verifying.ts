/**
 * 起動時に、「確認中」のまま止まっている項目を見つける。
 *
 * 確認（型チェック・全テスト・ビルド）は、このサーバーの中で走る。取り込みの承認などで
 * サーバーが再起動すると、**走っていた確認が途中で切れて、項目が「確認中」のまま残る**
 * （2026-10-17、#5 の取り込みの再起動で、同時に走っていた #1 の確認が切れた）。
 * 起動した直後は、このプロセスの中で確認が走っているはずがないので、「確認中」はすべて、切れたもの。
 *
 * やり直すだけで、何も取り込まない（取り込みは、承認のあと）。
 */
export interface FindingLike {
  id: string;
  dedupeKey: string;
  status: string;
  runId: string | null;
}

export type Recovery =
  | { kind: 'dev-run'; findingId: string; runId: string }
  | { kind: 'self-fix'; findingId: string; runId: string };

export function planRecovery(findings: FindingLike[]): Recovery[] {
  const out: Recovery[] = [];
  for (const f of findings) {
    if (f.status !== 'verifying') continue;
    // 委任した開発の成果は、鍵が `dev-run:<実行番号>`。
    if (f.dedupeKey.startsWith('dev-run:')) {
      const runId = f.dedupeKey.slice('dev-run:'.length);
      if (runId) out.push({ kind: 'dev-run', findingId: f.id, runId });
      continue;
    }
    // 自己開発の直しは、実行番号を finding が持っている。
    if (f.runId) out.push({ kind: 'self-fix', findingId: f.id, runId: f.runId });
  }
  return out;
}
