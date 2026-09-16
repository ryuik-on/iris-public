# IRIS

**この機械に常駐して、複数の AI CLI（Claude Code / Codex / Gemini）に共通の記憶と決定を持たせるサーバ。**

AI の CLI はセッションごとに記憶が消える。同じ機械で 3 つの CLI を使うと、同じことを 3 回説明することになる。
IRIS はその記憶を機械の中に置く。各 CLI は起動時に `GET /api/briefing` を読み、学んだことを `POST /api/memory` で書き戻す。

- **クラウドに繋がない。** 127.0.0.1:3002 でしか喋らない。launchd で常駐し、再起動しても上がる
- **記録には出所が要る。** `provenance` は `measured`（測った）／`user`（本人が言った）／`external`（外部資料）／`inferred`（推論）。**`measured` に `evidence` が無ければ `inferred`・確度 0.7 に自動で落とす**
- **繋がらない相手のための退避経路。** サンドボックス内で 127.0.0.1 を塞ぐ CLI があるので、同じ内容を 5 分ごとに `~/.iris/briefing.json` へ書き出す
- 使用量の監視（各 CLI の週間・5時間窓）、予算ゲート、委任（どの作業をどの CLI に渡すか）、カレンダーの乖離検出、家計メールの取込と照合、音声（Swift）まで含む

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
- `scripts/test-*.ts` — テスト
- `docs/` — 設計と引き継ぎの記録
