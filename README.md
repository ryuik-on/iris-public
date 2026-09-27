# IRIS

**この機械に常駐して、複数の AI CLI（Claude Code / Codex / Gemini）に共通の記憶と決定を持たせるサーバ。**

AI の CLI はセッションごとに記憶が消える。同じ機械で 3 つの CLI を使うと、同じことを 3 回説明することになる。
IRIS はその記憶を機械の中に置く。各 CLI は起動時に `GET /api/briefing` を読み、学んだことを `POST /api/memory` で書き戻す。

- **クラウドに繋がない。** 127.0.0.1:3002 でしか喋らない。launchd で常駐し、再起動しても上がる
- **記録には出所が要る。** `provenance` は `measured`（測った）／`user`（本人が言った）／`external`（外部資料）／`inferred`（推論）。**`measured` に `evidence` が無ければ `inferred`・確度 0.7 に自動で落とす**
- **繋がらない相手のための退避経路。** サンドボックス内で 127.0.0.1 を塞ぐ CLI があるので、同じ内容を 5 分ごとに `~/.iris/briefing.json` へ書き出す
- 使用量の監視（各 CLI の週間・5時間窓）、予算ゲート、委任（どの作業をどの CLI に渡すか）、カレンダーの乖離検出、家計メールの取込と照合、音声（Swift）まで含む

## MCP サーバとしても差し出す

各 CLI は `curl` ではなくツールとして IRIS を呼べる。`scripts/iris-mcp.ts` が stdio の MCP サーバで、
`briefing` / `recall` / `remember` / `decisions` / `decide` / `allowance` / `attempts` の 7 つを出す。

```bash
claude mcp add --scope user iris -- npx tsx <このリポジトリ>/scripts/iris-mcp.ts
codex  mcp add              iris -- npx tsx <このリポジトリ>/scripts/iris-mcp.ts
```

境界で決めていることが 2 つある。どちらも HTTP API とは違う振る舞いで、理由が
[`server/core/mcp_server.ts`](server/core/mcp_server.ts) の冒頭にある。

- **`provenance=measured` で `evidence` が空なら、書かずに断る。** HTTP では格下げして受け取る——
  `curl` では他に道がないので、失うより落として残す方がよい。ツールの呼び出し元は一秒後に
  呼び直せるので、**受け取って黙って出所を変える方が悪い。** 成功として返り、呼び出し元は何も学ばない。
  2026-09-07 に記憶 116 件のうち 88 件が推論で、うち何件かは出所に「実測」と書いてあった
- **`recall` は local_only を頼む口を持たない。** HTTP では `shareable` を問い合わせ側に決めさせている
  （どこへ行く文字列かを考えさせるため）。ツールの結果は提供者へ送られるプロンプトに入ると分かっているので、
  境界で決める

**実測（2026-09-27）: Codex の MCP サーバはサンドボックスの外で起動される。**
`curl http://127.0.0.1:3002/...` が `000` で塞がれる実行でも、MCP 経由なら読めて書き戻せる。
それでも届かない場合は、`briefing` が `~/.iris/briefing.json` の写しをその古さと共に返し、
**書き戻せないことを明示する**（黙って成功に見せない）。

## 規模（元リポジトリの実測、2026-09-16）

| | |
| --- | --- |
| 開始 | 2026-08-18 |
| コミット | **447** |
| ソース | 247 ファイル / 約 71379 行（.ts / .tsx） |
| テスト | `scripts/test-*.ts` × **81**。`npm test` が直列で全部回す |
| 構成 | TypeScript（Express + React/Vite）／Swift（音声認識アプリ・menubar）／launchd |

**このリポジトリは公開用の写しで、コミット履歴を持ちません。** 元リポジトリの履歴には個人の家計・予定・氏名が
テストフィクスチャとして混入した時期があり、除去済みですが履歴には残るため、履歴ごと公開しない判断をしました。
このツリーからは実額・氏名・勤務先・研究室名・ダッシュボードの実物画像を取り除いています。

## 動かす

```bash
cp .env.example .env   # API キーを入れる
npm ci
npm run dev            # server + client
npm test               # 全テスト
```

## 構成

- `server/core/` — memory / decisions / experience / delegation / budget / privacy / calendar / finance / speech
- `server/index.ts` — API（`/api/briefing`, `/api/memory`, `/api/decisions`, `/api/usage/cli` ほか）
- `src/` — ダッシュボード（React）
- `menubar/`, `swift/iris-speech/` — macOS 側
- `scripts/iris-mcp.ts` — MCP サーバ（stdio）／`server/core/mcp_server.ts` — ツールの定義と境界の規則
- `scripts/test-*.ts` — テスト
- `docs/` — 設計と引き継ぎの記録
