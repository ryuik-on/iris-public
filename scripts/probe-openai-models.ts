/**
 * Probes which OpenAI models actually work on chat/completions.
 *
 * Discovery lists everything the account can see, but a listed model is not
 * necessarily usable on the endpoint you call — `gpt-5.5-pro` is listed and
 * returns 404 "This is not a chat model". Guessing from names burns attempts,
 * so this asks with a two-token prompt.
 *
 * Run: npx tsx scripts/probe-openai-models.ts [model ...]
 */
import 'dotenv/config';
import OpenAI from 'openai';

async function main() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('OPENAI_API_KEY が未設定です。');
    process.exit(1);
  }
  const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 90000 });
  const candidates = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-chat-latest'];

  for (const model of candidates) {
    try {
      const r = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        max_completion_tokens: 2000,
      });
      const text = (r.choices[0]?.message?.content ?? '').trim().slice(0, 24);
      const u = r.usage;
      console.log(`✓ ${model.padEnd(22)} 応答=${JSON.stringify(text)} in=${u?.prompt_tokens} out=${u?.completion_tokens}`);
    } catch (err: any) {
      console.log(`✗ ${model.padEnd(22)} ${String(err?.message).slice(0, 100)}`);
    }
  }
}

main();
