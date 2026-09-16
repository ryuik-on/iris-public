/**
 * JSON Schema as Gemini will actually accept it.
 *
 * The provider used to hand tool schemas to the SDK untouched. That works for
 * every tool IRIS defines itself, because those were written against what
 * Gemini takes — and it fails completely for tools that came from somewhere
 * else. An MCP server publishes ordinary JSON Schema: `$ref` into `$defs`,
 * `readOnly`, `deprecated`, and whatever vendor extensions its author found
 * useful. Gemini's function-declaration parser accepts an OpenAPI subset and
 * rejects the request outright on the first key it does not recognise.
 *
 * The failure mode is what makes this worth a file of its own. It is not the
 * offending tool that stops working — it is the whole conversation. One
 * unrecognised key in one property of one tool returns 400 for the entire
 * request, so IRIS could not answer at all. On 2026-08-20 the connected
 * calendar server had six such tools and Gemini was the active provider; every
 * message failed before a single tool could be considered.
 *
 * Two decisions here, both learned rather than assumed.
 *
 * An allowlist, not a blocklist. The first version of this could have deleted
 * the four keys the error named, and it would have worked that afternoon and
 * broken again the next time a server published a fifth. What Gemini accepts
 * is a short, knowable list; what a JSON Schema author may write is not.
 *
 * A tool that cannot be converted is dropped by name, loudly. Silently
 * shipping a tool with its constraints stripped would let the model call it
 * with arguments the server will reject, and silently dropping it would make
 * a capability vanish with nothing to grep for. Both are worse than a log line
 * saying which tool went and why.
 */

/**
 * Keys Gemini's Schema type understands.
 *
 * `propertyOrdering` is Gemini's own. `format` is included but filtered
 * further below — Gemini takes only a few values and rejects the rest.
 */
const ALLOWED_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'anyOf',
  'propertyOrdering',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'default',
  'example',
]);

/**
 * The `format` values Gemini documents, by type.
 *
 * An unknown format is dropped rather than passed through: it is an annotation
 * everywhere else in the schema and a rejection here, and losing it costs only
 * a hint the description usually repeats.
 */
const ALLOWED_FORMATS: Record<string, Set<string>> = {
  string: new Set(['enum', 'date-time']),
  integer: new Set(['int32', 'int64']),
  number: new Set(['float', 'double']),
};

/** How deep a `$ref` chain may nest before it is treated as a cycle. */
const MAX_DEPTH = 12;

export interface ConversionResult {
  ok: boolean;
  schema?: Record<string, any>;
  /** Why it could not be converted. Present only when `ok` is false. */
  reason?: string;
  /**
   * Keys that were removed, deduplicated.
   *
   * Reported rather than counted so a log line can say what was stripped —
   * "removed 14 keys" tells whoever reads it nothing they can act on.
   */
  removed: string[];
}

class Unconvertible extends Error {}

/**
 * Rewrites a JSON Schema into the subset Gemini accepts.
 *
 * `$defs` are resolved by inlining, because Gemini has no notion of a
 * definition section — a `$ref` it cannot follow is simply an unknown key.
 * Inlining can duplicate a definition used twice, which costs tokens and
 * changes nothing about meaning.
 */
export function toGeminiSchema(schema: unknown): ConversionResult {
  if (schema === null || schema === undefined) {
    // A tool with no parameters is legitimate, and an empty object is how
    // Gemini expects it to be spelled.
    return { ok: true, schema: { type: 'object', properties: {} }, removed: [] };
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, reason: 'スキーマがオブジェクトではありません。', removed: [] };
  }

  const root = schema as Record<string, any>;
  const defs = collectDefs(root);
  const removed = new Set<string>();

  try {
    const converted = convert(root, defs, removed, 0);
    return { ok: true, schema: converted, removed: [...removed].sort() };
  } catch (err) {
    if (err instanceof Unconvertible) {
      return { ok: false, reason: err.message, removed: [...removed].sort() };
    }
    throw err;
  }
}

/** Both spellings, because servers use both and neither is wrong. */
function collectDefs(root: Record<string, any>): Record<string, any> {
  return { ...(root.definitions ?? {}), ...(root.$defs ?? {}) };
}

function convert(
  node: Record<string, any>,
  defs: Record<string, any>,
  removed: Set<string>,
  depth: number
): Record<string, any> {
  if (depth > MAX_DEPTH) {
    // Almost certainly a definition that refers to itself. Gemini has no way
    // to express that, and guessing a truncation depth would hand the model a
    // schema the server never agreed to.
    throw new Unconvertible(`$ref の入れ子が深すぎます（循環参照の可能性）。深さ ${MAX_DEPTH} で打ち切りました。`);
  }

  if (typeof node.$ref === 'string') {
    const resolved = resolveRef(node.$ref, defs);
    removed.add('$ref');
    // Sibling keys alongside a $ref are merged over the target, which is what
    // a reader expects and what JSON Schema 2019-09 onward specifies.
    const siblings = { ...node };
    delete siblings.$ref;
    return convert({ ...resolved, ...siblings }, defs, removed, depth + 1);
  }

  const out: Record<string, any> = {};

  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_KEYS.has(key)) {
      // `$defs` is expected here and is not a problem — it has been inlined
      // already — but it is still reported, so the log tells the whole story.
      removed.add(key);
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, any> = {};
      for (const [name, sub] of Object.entries(value as Record<string, any>)) {
        if (sub && typeof sub === 'object') props[name] = convert(sub, defs, removed, depth + 1);
      }
      out.properties = props;
      continue;
    }

    if (key === 'items' && value && typeof value === 'object') {
      // Tuple form (`items: [...]`) has no Gemini equivalent. Converting only
      // the first entry would silently change what the tool accepts.
      if (Array.isArray(value)) {
        throw new Unconvertible('items が配列形式（タプル）です。Gemini には対応する表現がありません。');
      }
      out.items = convert(value as Record<string, any>, defs, removed, depth + 1);
      continue;
    }

    if (key === 'anyOf' && Array.isArray(value)) {
      out.anyOf = value
        .filter((v) => v && typeof v === 'object')
        .map((v) => convert(v as Record<string, any>, defs, removed, depth + 1));
      continue;
    }

    if (key === 'type') {
      // A union type (`type: ['string', 'null']`) is JSON Schema's way of
      // saying nullable, and Gemini spells that with a separate flag.
      if (Array.isArray(value)) {
        const named = value.filter((v) => typeof v === 'string');
        const nonNull = named.filter((v) => v !== 'null');
        if (nonNull.length !== 1) {
          throw new Unconvertible(`type が複数あります: ${JSON.stringify(value)}`);
        }
        out.type = nonNull[0];
        if (named.length !== nonNull.length) out.nullable = true;
        continue;
      }
      out.type = value;
      continue;
    }

    if (key === 'format') {
      // Deferred: the type may not have been read yet, so this is filtered
      // after the loop, where both are known.
      out.format = value;
      continue;
    }

    out[key] = value;
  }

  if (typeof out.format === 'string') {
    const allowed = ALLOWED_FORMATS[String(out.type)];
    if (!allowed || !allowed.has(out.format)) {
      removed.add('format');
      delete out.format;
    }
  }

  // `required` naming a property that no longer exists would have Gemini
  // enforce something the model cannot satisfy.
  if (Array.isArray(out.required) && out.properties) {
    const known = new Set(Object.keys(out.properties));
    const kept = out.required.filter((r: any) => typeof r === 'string' && known.has(r));
    if (kept.length !== out.required.length) removed.add('required(未定義のプロパティ)');
    if (kept.length > 0) out.required = kept;
    else delete out.required;
  }

  return out;
}

function resolveRef(ref: string, defs: Record<string, any>): Record<string, any> {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) {
    // A pointer out of the document, or into somewhere this does not walk.
    // Fetching it is not this layer's job and inventing a shape would be worse.
    throw new Unconvertible(`外部または未対応の $ref です: ${ref}`);
  }
  const target = defs[decodeURIComponent(match[1])];
  if (!target || typeof target !== 'object') {
    throw new Unconvertible(`$ref の参照先が見つかりません: ${ref}`);
  }
  return target as Record<string, any>;
}
