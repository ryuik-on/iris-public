/**
 * Provider error classification and startup configuration checks.
 *
 * These exist because two real setup mistakes surfaced as noise: a placeholder
 * API key produced a ByteString encoder error, and a retired model id stayed
 * invisible until a key was supplied. Both are detectable before a request is
 * ever sent, so the assertions here are about naming the actual problem and
 * catching it at startup rather than at runtime.
 *
 * Run: npm run test:provider-errors
 */
import {
  classifyProviderError,
  describeProviderError,
  validateConfiguration,
  KNOWN_ANTHROPIC_MODELS,
  RETIRED_ANTHROPIC_MODELS,
} from '../server/core/provider_errors.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string) {
  console.log(`\n▸ ${title}`);
}

/** A real key shape: ASCII, correct prefix, plausible length. */
const VALID_KEY = 'sk-ant-api03-' + 'a'.repeat(95);

async function main() {
  // -----------------------------------------------------------------------
  section('The two failures that actually happened');

  // 1. A placeholder key reached the HTTP encoder and produced this.
  const byteString = classifyProviderError(
    new Error(
      'Cannot convert argument to a ByteString because the character at index 7 has a value of 12371 which is greater than 255.'
    )
  );
  eq('a placeholder key is identified, not passed through', byteString.kind, 'invalid_key_characters');
  check('it is reported as a configuration problem', byteString.configuration);
  check('it is not retried', !byteString.retryable);
  check('the message names the API key', /API キー/.test(byteString.message));
  check('the guidance says what to do', /プレースホルダ|貼り付け/.test(byteString.guidance));
  check('the original text is kept for the log', /ByteString/.test(byteString.raw));
  check('the user-facing text no longer mentions ByteString', !/ByteString/.test(describeProviderError(byteString)));

  // 2. A retired model id only failed once a key was supplied.
  const notFound: any = new Error('model not found');
  notFound.status = 404;
  const model = classifyProviderError(notFound);
  eq('a 404 is identified as a model problem', model.kind, 'model_not_found');
  check('it is a configuration problem', model.configuration);
  check('the guidance names the setting to change', /ANTHROPIC_MODEL/.test(model.guidance));
  check('the guidance warns that retirement is silent', /廃止/.test(model.guidance + model.message));

  // 3. A real Gemini quota error, captured verbatim from the activity log.
  //    "please check your plan and billing details" is quota boilerplate, and a
  //    loose match on "billing" classified it as a credit problem — pointing at
  //    the wrong fix entirely. Pinned here so that cannot regress.
  const REAL_GEMINI_QUOTA =
    '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. ' +
    'For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n' +
    '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, ' +
    'model: gemini-3.6-flash","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure",' +
    '"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}';
  const realQuota = classifyProviderError(new Error(REAL_GEMINI_QUOTA));
  eq('the real quota error is a quota exhaustion', realQuota.kind, 'quota_exhausted');
  check('it is NOT mistaken for a credit problem', realQuota.kind !== 'insufficient_credit');
  check('it is not retried', !realQuota.retryable);
  check('the guidance says retrying will not help', /回復しません/.test(realQuota.guidance));
  check(
    'the status is recovered from the body when the SDK does not expose it',
    classifyProviderError(new Error('{"error":{"code":404,"message":"nope"}}')).kind === 'model_not_found'
  );

  // A genuine credit problem must still be identified.
  const realCredit = classifyProviderError(new Error('Your credit balance is too low to access the API'));
  eq('a genuine credit failure is still caught', realCredit.kind, 'insufficient_credit');

  // -----------------------------------------------------------------------
  section('Configuration vs transient — the distinction that matters');

  const auth: any = new Error('invalid x-api-key');
  auth.status = 401;
  const authClass = classifyProviderError(auth);
  eq('401 is authentication', authClass.kind, 'authentication');
  check('authentication is configuration, not transient', authClass.configuration && !authClass.retryable);

  const daily: any = new Error('quota exceeded');
  daily.status = 429;
  daily.error = { details: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] };
  const dailyClass = classifyProviderError(daily);
  eq('a daily quota is quota_exhausted, not a rate limit', dailyClass.kind, 'quota_exhausted');
  check('a daily quota is NOT retried', !dailyClass.retryable);
  check('it says retrying will not help', /回復しません/.test(dailyClass.guidance));

  const perMinute: any = new Error('rate limited');
  perMinute.status = 429;
  const rateClass = classifyProviderError(perMinute);
  eq('a bare 429 is a rate limit', rateClass.kind, 'rate_limit');
  check('a rate limit IS retried', rateClass.retryable);
  check('a rate limit is not a configuration problem', !rateClass.configuration);

  const credit: any = new Error('Your credit balance is too low');
  credit.status = 400;
  eq('a billing failure is identified', classifyProviderError(credit).kind, 'insufficient_credit');

  const overloaded: any = new Error('overloaded_error');
  overloaded.status = 529;
  const over = classifyProviderError(overloaded);
  eq('529 is overloaded', over.kind, 'overloaded');
  check('overload is transient and retried', over.retryable && !over.configuration);

  /*
   * 混雑はベンダーごとに別の綴りで来る。529 は Anthropic の言い方で、それだけを
   * 見ていたので Gemini の 503 は `unknown` に落ち、**失敗の引き継ぎに入らなかった**
   * （実測 2026-09-29、既定の一番手が混んだだけで会話が終わった）。
   */
  const geminiBusy: any = new Error(
    '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'
  );
  geminiBusy.status = 503;
  eq('Gemini の 503 も混雑', classifyProviderError(geminiBusy).kind, 'overloaded');
  // status が付かずに本文だけ来ることもある（包み方は呼び出し側による）。
  eq('本文だけでも混雑と読む', classifyProviderError(new Error(geminiBusy.message)).kind, 'overloaded');

  const openaiBusy: any = new Error('Service Unavailable');
  openaiBusy.status = 503;
  eq('OpenAI の 503 も混雑', classifyProviderError(openaiBusy).kind, 'overloaded');

  const gateway: any = new Error('Bad Gateway');
  gateway.status = 502;
  eq('502 も混雑（手前の関門が上流に届かない）', classifyProviderError(gateway).kind, 'overloaded');

  /*
   * **504 は混雑にしない。**あれは時間切れで、router は「時間切れでは引き継がない」
   * と決めている —— 同じ呼び出しが二度課金される恐れがあるため。
   */
  const gatewayTimeout: any = new Error('Gateway Timeout');
  gatewayTimeout.status = 504;
  eq('504 は時間切れのまま', classifyProviderError(gatewayTimeout).kind, 'timeout');

  /*
   * 500 も混雑にしない。**壊れた要求でも 500 は返る**ので、別の相手に渡しても
   * 同じことが起きる。
   */
  const serverFault: any = new Error('Internal Server Error');
  serverFault.status = 500;
  check('500 は混雑ではない', classifyProviderError(serverFault).kind !== 'overloaded');

  // 429 の方が具体的なので、混雑の判定に先を越されない。
  const throttled: any = new Error('Too Many Requests');
  throttled.status = 429;
  eq('429 は今までどおり rate_limit', classifyProviderError(throttled).kind, 'rate_limit');

  const network = classifyProviderError(new Error('socket hang up'));
  eq('a network fault is identified', network.kind, 'network');
  check('a network fault is retried', network.retryable);

  const refusal: any = new Error('モデルが安全上の理由で拒否しました');
  refusal.refusal = true;
  const ref = classifyProviderError(refusal);
  eq('a safety refusal is identified', ref.kind, 'refusal');
  check('a refusal is never retried', !ref.retryable);
  check('a refusal is not blamed on configuration', !ref.configuration);

  // Anything unrecognised must not be dressed up as something it is not.
  const mystery = classifyProviderError(new Error('something entirely new'));
  eq('an unrecognised error stays unknown', mystery.kind, 'unknown');
  check('an unknown error keeps its original text', /something entirely new/.test(mystery.message));
  check('an unknown error offers no invented guidance', mystery.guidance === '');

  // -----------------------------------------------------------------------
  section('Startup configuration checks');

  eq('a clean configuration reports nothing', validateConfiguration({ ANTHROPIC_API_KEY: VALID_KEY } as any), []);
  eq('no keys at all is not itself an error', validateConfiguration({} as any), []);

  // The exact placeholder that was pasted today.
  const placeholder = validateConfiguration({ ANTHROPIC_API_KEY: 'sk-ant-ここに実際のキー' } as any);
  check('a placeholder key is caught at startup', placeholder.length > 0);
  eq('it is an error, not a warning', placeholder[0].severity, 'error');
  check('it names the offending character', /ここ|ASCII/.test(placeholder[0].message));
  check(
    'it does not also complain about length, which would bury the real cause',
    placeholder.length === 1,
    JSON.stringify(placeholder.map((i) => i.message))
  );

  const short = validateConfiguration({ ANTHROPIC_API_KEY: 'sk-ant-abc' } as any);
  check('a truncated key is caught', short.some((i) => /短すぎ/.test(i.message)));

  const wrongPrefix = validateConfiguration({ ANTHROPIC_API_KEY: 'sk-proj-' + 'a'.repeat(60) } as any);
  check('a key from the wrong provider is caught', wrongPrefix.some((i) => /sk-ant-/.test(i.message)));

  // The retired model that would have 404'd.
  const retired = validateConfiguration({
    ANTHROPIC_API_KEY: VALID_KEY,
    ANTHROPIC_MODEL: 'claude-3-5-sonnet-20241022',
  } as any);
  check('a retired model is caught at startup', retired.length === 1);
  eq('a retired model is an error', retired[0].severity, 'error');
  check('it says the request would 404', /404/.test(retired[0].guidance));

  // A model newer than this build is legitimate — warn, never block.
  const unknownModel = validateConfiguration({
    ANTHROPIC_API_KEY: VALID_KEY,
    ANTHROPIC_MODEL: 'claude-opus-9',
  } as any);
  eq('an unknown model is only a warning', unknownModel[0].severity, 'warning');
  check('the warning allows for a newer model', /新しい/.test(unknownModel[0].guidance));

  for (const m of KNOWN_ANTHROPIC_MODELS) {
    const issues = validateConfiguration({ ANTHROPIC_API_KEY: VALID_KEY, ANTHROPIC_MODEL: m } as any);
    check(`${m} passes validation`, issues.length === 0, JSON.stringify(issues));
  }
  check(
    'no model is both known and retired',
    !KNOWN_ANTHROPIC_MODELS.some((m) => RETIRED_ANTHROPIC_MODELS.includes(m))
  );

  const badEffort = validateConfiguration({ ANTHROPIC_API_KEY: VALID_KEY, ANTHROPIC_EFFORT: 'very-high' } as any);
  check('an invalid effort is caught', badEffort.some((i) => i.setting === 'ANTHROPIC_EFFORT'));
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
    check(
      `effort ${e} is accepted`,
      validateConfiguration({ ANTHROPIC_API_KEY: VALID_KEY, ANTHROPIC_EFFORT: e } as any).length === 0
    );
  }

  // A broken Anthropic key must not stop IRIS booting on Gemini.
  const mixed = validateConfiguration({
    ANTHROPIC_API_KEY: 'sk-ant-プレースホルダ',
    GEMINI_API_KEY: 'a'.repeat(39),
  } as any);
  check('a broken key is reported without blocking the other provider', mixed.length === 1);
  eq('and it is attributed to the right setting', mixed[0].setting, 'ANTHROPIC_API_KEY');

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Provider errors & config: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All provider error tests passed.');
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(1);
});
