/**
 * Provider error classification and configuration validation.
 *
 * Two failures during setup both surfaced as noise instead of instructions:
 * a placeholder API key produced "Cannot convert argument to a ByteString
 * because the character at index 7 has a value of 12371", and a retired model
 * id stayed silent until a key was finally supplied and the request 404'd.
 *
 * Neither is a mysterious runtime fault — both are configuration mistakes that
 * are detectable before any request is sent. So this module does two things:
 * checks configuration at startup, and translates whatever still reaches
 * runtime into something that names the actual problem and the fix.
 */

export type ProviderErrorKind =
  | 'invalid_key_characters'
  | 'missing_key'
  | 'authentication'
  | 'model_not_found'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'insufficient_credit'
  | 'invalid_request'
  | 'refusal'
  | 'overloaded'
  | 'network'
  | 'timeout'
  | 'unknown';

export interface ClassifiedProviderError {
  kind: ProviderErrorKind;
  /** What went wrong, in the user's terms. */
  message: string;
  /** What to do about it. Empty when there is nothing actionable. */
  guidance: string;
  /** True for a setup problem the user must fix; false for a transient fault. */
  configuration: boolean;
  retryable: boolean;
  /** The original message, kept for the activity log rather than the user. */
  raw: string;
}

export function classifyProviderError(err: any): ClassifiedProviderError {
  const raw = String(err?.message ?? err ?? '');
  const body = safeStringify(err?.error);
  // Some SDKs surface the HTTP status only inside the serialised body, so a
  // classifier that reads err.status alone silently misroutes those errors.
  const status: number | undefined =
    err?.status ?? err?.statusCode ?? extractStatusFromBody(raw + body);

  // A credential containing non-Latin-1 characters cannot go into an HTTP
  // header, so the failure surfaces from the encoder rather than the API. In
  // practice this means an unreplaced placeholder or a mis-pasted key.
  if (/ByteString/i.test(raw) || /character at index \d+ has a value of/i.test(raw)) {
    return {
      kind: 'invalid_key_characters',
      message: 'API キーに使用できない文字が含まれています。',
      guidance:
        '.env の API キーがプレースホルダのままか、貼り付けに失敗している可能性があります。' +
        'キーは ASCII のみで、Anthropic の場合は sk-ant- で始まる100文字前後の文字列です。',
      configuration: true,
      retryable: false,
      raw,
    };
  }

  if (err?.refusal === true) {
    return {
      kind: 'refusal',
      message: raw || 'モデルが要求を拒否しました。',
      guidance: '内容を変えて試すか、別のモデルを使用してください。再試行しても同じ結果になります。',
      configuration: false,
      retryable: false,
      raw,
    };
  }

  if (status === 401 || /authentication_error|invalid x-api-key|unauthorized/i.test(raw + body)) {
    return {
      kind: 'authentication',
      message: 'API キーが無効です。',
      guidance:
        'キーが失効しているか、別の環境のものである可能性があります。' +
        'プロバイダのコンソールで有効なキーを確認し、.env を更新してサーバを再起動してください。',
      configuration: true,
      retryable: false,
      raw,
    };
  }

  // A retired or mistyped model id. This is the failure that stayed hidden
  // until a key was supplied, so the guidance names the config key directly.
  if (status === 404 || /model.*not.*found|not_found_error.*model/i.test(raw + body)) {
    return {
      kind: 'model_not_found',
      message: 'モデル ID が存在しないか、廃止されています。',
      guidance:
        '.env の ANTHROPIC_MODEL / GEMINI_MODEL を確認してください。' +
        'モデルは廃止されることがあり、その場合は静かに 404 になります。',
      configuration: true,
      retryable: false,
      raw,
    };
  }

  // Checked before any message-text heuristic: a genuine quota error reads
  // "You exceeded your current quota, please check your plan and billing
  // details", which a loose match on "billing" would misclassify as a credit
  // problem — pointing the user at the wrong fix.
  if (status === 429 || /RESOURCE_EXHAUSTED|rate_limit_error/i.test(raw + body)) {
    // A per-minute limit recovers on its own; a daily quota does not, and
    // retrying it only burns what is left.
    const daily = /PerDay|per_day|daily|per day/i.test(body + raw);
    return daily
      ? {
          kind: 'quota_exhausted',
          message: '本日の利用上限に達しました。',
          guidance:
            '日次の上限は再試行では回復しません。プランを変更するか、別のプロバイダのキーを設定してください。',
          configuration: true,
          retryable: false,
          raw,
        }
      : {
          kind: 'rate_limit',
          message: 'リクエストが集中しています。',
          guidance: '短時間で回復します。自動的に再試行されます。',
          configuration: false,
          retryable: true,
          raw,
        };
  }

  // Only reached when it is not a quota error. Requires actual balance
  // language rather than the word "billing", which appears in quota boilerplate.
  if (/credit balance|insufficient (credit|funds|balance)|payment method|請求先/i.test(raw + body)) {
    return {
      kind: 'insufficient_credit',
      message: 'アカウントの残高が不足しています。',
      guidance: 'プロバイダのコンソールで残高またはお支払い方法を確認してください。',
      configuration: true,
      retryable: false,
      raw,
    };
  }

  /*
   * 混雑は、ベンダーごとに別の綴りで来る。
   *
   * ここは長らく **529 と "overloaded" の字面だけ**を見ていた。それは Anthropic の
   * 綴りで、Gemini は 503 に `"status":"UNAVAILABLE"` と "high demand" で言い、
   * OpenAI も 503 を使う。**分類できなかったものは失敗の引き継ぎに入らない**
   * （`FAILOVER_KINDS` は `unknown` を含まない）ので、既定の一番手である無料枠が
   * 混んだだけで会話がそこで終わっていた。
   *
   * 実測 2026-09-29: Gemini が
   * `{"error":{"code":503,...,"status":"UNAVAILABLE"}}` を返し、router は
   * `unknown` として投げ直し、`FAILOVER:` は一度も出なかった。
   *
   * 502 も入れる（手前の関門が上流に届かない、同じ形の一時的な不通）。
   * **504 は入れない** —— あれは時間切れで、上の規則が「時間切れでは引き継がない」
   * と決めている（同じ呼び出しが二度課金される恐れがあるため）。500 も入れない ——
   * 壊れた要求でも 500 は返るので、別の相手に渡しても同じことが起きる。
   */
  if (status === 529 || status === 503 || status === 502
      || /overloaded|service unavailable|high demand|"status"\s*:\s*"UNAVAILABLE"/i.test(raw + body)) {
    return {
      kind: 'overloaded',
      message: 'プロバイダ側が一時的に混雑しています。',
      guidance: '自動的に再試行されます。混雑が続く場合は次のプロバイダへ切り替わります。',
      configuration: false,
      retryable: true,
      raw,
    };
  }

  if (err?.name === 'TimeoutError' || /timeout|タイムアウト/i.test(raw)) {
    return {
      kind: 'timeout',
      message: raw,
      guidance: '',
      configuration: false,
      retryable: false,
      raw,
    };
  }

  if (/ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network/i.test(raw)) {
    return {
      kind: 'network',
      message: 'プロバイダに接続できませんでした。',
      guidance: 'ネットワーク接続を確認してください。自動的に再試行されます。',
      configuration: false,
      retryable: true,
      raw,
    };
  }

  if (typeof status === 'number' && status >= 400 && status < 500) {
    return {
      kind: 'invalid_request',
      message: 'リクエストがプロバイダに拒否されました。',
      guidance: raw,
      configuration: false,
      retryable: false,
      raw,
    };
  }

  return {
    kind: 'unknown',
    message: raw || '不明なエラーが発生しました。',
    guidance: '',
    configuration: false,
    retryable: typeof status === 'number' && status >= 500,
    raw,
  };
}

/** One line combining the problem and the fix, for display. */
export function describeProviderError(err: any): string {
  const c = classifyProviderError(err);
  return c.guidance ? `${c.message} ${c.guidance}` : c.message;
}

// ---------------------------------------------------------------- startup

export interface ConfigIssue {
  severity: 'error' | 'warning';
  setting: string;
  message: string;
  guidance: string;
}

/** Model ids known to this build. An unknown id is a warning, not an error. */
export const KNOWN_ANTHROPIC_MODELS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
];

/**
 * OpenAI chat-capable ids confirmed by probing the account's own endpoint.
 * Being listed by the models API is not enough — `gpt-5.5-pro` is listed and
 * returns 404 on chat/completions.
 */
export const KNOWN_OPENAI_CHAT_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
];

export const RETIRED_OPENAI_MODELS = ['gpt-5.3-chat-latest'];

/** Model ids that are retired — these will 404, so they are errors. */
export const RETIRED_ANTHROPIC_MODELS = [
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-haiku-20241022',
];

/**
 * Checks configuration before any request is made, so a setup mistake is
 * reported at startup rather than as a runtime error on the user's first
 * message. Returns issues instead of throwing: a bad Anthropic key should not
 * stop IRIS from booting on Gemini.
 */
export function validateConfiguration(env: NodeJS.ProcessEnv = process.env): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    issues.push(...validateKey('ANTHROPIC_API_KEY', anthropicKey, 'sk-ant-'));
  }

  const geminiKey = env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    issues.push(...validateKey('GEMINI_API_KEY', geminiKey));
  }

  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    issues.push(...validateKey('OPENAI_API_KEY', openaiKey, 'sk-'));
  }

  const model = env.ANTHROPIC_MODEL?.trim();
  if (model) {
    if (RETIRED_ANTHROPIC_MODELS.includes(model)) {
      issues.push({
        severity: 'error',
        setting: 'ANTHROPIC_MODEL',
        message: `${model} は廃止済みのモデルです。`,
        guidance: `リクエストは 404 になります。claude-sonnet-5 などの現行モデルに変更してください。`,
      });
    } else if (!KNOWN_ANTHROPIC_MODELS.includes(model)) {
      // Not an error: a model newer than this build is legitimate.
      issues.push({
        severity: 'warning',
        setting: 'ANTHROPIC_MODEL',
        message: `${model} はこのビルドの既知モデル一覧にありません。`,
        guidance: 'スペルミスか、このビルドより新しいモデルです。動作しない場合は ID を確認してください。',
      });
    }
  }

  const openaiModel = (env.OPENAI_MODEL || env.REVIEW_PRIMARY_MODEL)?.trim();
  if (openaiModel && env.OPENAI_API_KEY?.trim()) {
    const setting = env.OPENAI_MODEL ? 'OPENAI_MODEL' : 'REVIEW_PRIMARY_MODEL';
    if (RETIRED_OPENAI_MODELS.includes(openaiModel)) {
      issues.push({
        severity: 'error',
        setting,
        message: `${openaiModel} は廃止済みのモデルです。`,
        guidance: 'リクエストは 404 になります。gpt-5.6-terra などに変更してください。',
      });
    } else if (!KNOWN_OPENAI_CHAT_MODELS.includes(openaiModel)) {
      issues.push({
        severity: 'warning',
        setting,
        message: `${openaiModel} は chat/completions で動作確認された一覧にありません。`,
        guidance:
          'モデル一覧に載っていても chat エンドポイントで使えないことがあります（例: gpt-5.5-pro は 404）。' +
          'npx tsx scripts/probe-openai-models.ts で実際に確認できます。',
      });
    }
  }

  const effort = env.ANTHROPIC_EFFORT?.trim();
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    issues.push({
      severity: 'error',
      setting: 'ANTHROPIC_EFFORT',
      message: `${effort} は有効な effort ではありません。`,
      guidance: 'low / medium / high / xhigh / max のいずれかを指定してください。',
    });
  }

  return issues;
}

function validateKey(setting: string, value: string, expectedPrefix?: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  // Checked first: this is what a pasted placeholder looks like, and it fails
  // at the HTTP encoder rather than the API, producing an opaque error.
  const nonAscii = [...value].find((ch) => ch.charCodeAt(0) > 127);
  if (nonAscii) {
    issues.push({
      severity: 'error',
      setting,
      message: `キーに ASCII 以外の文字が含まれています（「${nonAscii}」）。`,
      guidance:
        'プレースホルダのままになっているか、貼り付けに失敗しています。実際のキーに置き換えてください。',
    });
    return issues;
  }

  if (expectedPrefix && !value.startsWith(expectedPrefix)) {
    issues.push({
      severity: 'error',
      setting,
      message: `キーが ${expectedPrefix} で始まっていません。`,
      guidance: '別のプロバイダのキーが設定されている可能性があります。',
    });
  }

  if (value.length < 30) {
    issues.push({
      severity: 'error',
      setting,
      message: `キーが短すぎます（${value.length} 文字）。`,
      guidance: '途中で切れているか、プレースホルダのままの可能性があります。',
    });
  }

  return issues;
}

/** Reads an HTTP status out of a serialised error body, e.g. `"code": 429`. */
function extractStatusFromBody(text: string): number | undefined {
  const match = text.match(/"code"\s*:\s*(\d{3})/);
  if (match) return parseInt(match[1], 10);
  return undefined;
}

function safeStringify(value: any): string {
  if (value === undefined || value === null) return '';
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '';
  }
}
