/**
 * 一つのモデルに、一つの問いを投げる。
 *
 * 監査を頼むための最小の口。鍵はプロバイダが環境から自分で読むので、
 * 呼ぶ側の手を通らない。
 *
 * Run: npx tsx scripts/ask-model.ts <model> <prompt-file>
 */
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { OpenAIProvider } from '../server/providers/openai.js';

// 鍵はここで読み込まれ、こちらの手を通らない。サーバと同じ経路。
dotenv.config();

const [model, file] = process.argv.slice(2);
if (!model || !file) {
  console.error('usage: tsx scripts/ask-model.ts <model> <prompt-file>');
  process.exit(1);
}

async function main() {
  const provider = new OpenAIProvider(undefined, model);
  const reply = await provider.generateResponse(
    [{ role: 'user', content: readFileSync(file, 'utf-8') } as any],
    [],
    'あなたは UI デザインの監査人です。日本語で答えてください。' +
      '推測を事実として書かないこと。根拠のある指摘と推測を分けて書くこと。'
  );
  console.log(reply.content ?? JSON.stringify(reply));
}

main();
