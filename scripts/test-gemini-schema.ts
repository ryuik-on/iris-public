/**
 * Gemini schema conversion tests.
 *
 * These exist because of a live failure, and the fixture is the failure
 * itself. On 2026-08-20 the connected calendar MCP server published nine
 * tools; six carried `$ref`, `$defs`, `deprecated` or a `x-google-*`
 * extension. Gemini rejects the whole request on the first key it does not
 * recognise, so IRIS could not answer any message at all — not "the calendar
 * tools were unavailable", but no reply, with a 400 that named field paths
 * inside a payload nobody had looked at.
 *
 * `scripts/fixtures/mcp-calendar-schemas.json` is that server's real output,
 * saved rather than reconstructed. A hand-written approximation of a schema
 * that broke something is a test of the approximation.
 *
 * Two properties matter more than the individual cases.
 *
 * Nothing outside the allowlist may survive, anywhere, at any depth. The
 * generic walk at the end is the test that will still be right when a
 * different server publishes a key nobody here has seen — which is the whole
 * reason this converts against a list of what is allowed rather than deleting
 * the four keys that happened to fail that afternoon.
 *
 * A schema that cannot be converted must say so, not be quietly approximated.
 * A truncated cycle or a half-converted tuple would hand the model a contract
 * the server never agreed to, and the model would call it and be refused.
 *
 * Run: npm run test:gemini-schema
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { toGeminiSchema } from '../server/providers/gemini_schema.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t: string) { console.log(`\n▸ ${t}`); }

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every key Gemini's Schema type accepts. Duplicated deliberately: if the
 *  converter's list is edited, this one does not move with it. */
const ALLOWED = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'items',
  'properties', 'required', 'anyOf', 'propertyOrdering', 'minItems',
  'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
  'default', 'example',
]);

/** Walks a converted schema and returns every key that should not be there. */
function offendingKeys(node: any, path = '', found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((n, i) => offendingKeys(n, `${path}[${i}]`, found));
    return found;
  }
  if (!node || typeof node !== 'object') return found;

  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED.has(key)) {
      found.push(`${path}/${key}`);
      continue;
    }
    // `properties` and `enum` hold names and values, not schema keywords, so
    // only the schema-bearing positions are walked into.
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, sub] of Object.entries(value as Record<string, any>)) {
        offendingKeys(sub, `${path}/properties/${name}`, found);
      }
    } else if (key === 'items' || key === 'anyOf') {
      offendingKeys(value, `${path}/${key}`, found);
    }
  }
  return found;
}

function main() {
  // -----------------------------------------------------------------------
  section('The schemas that actually broke it');

  const fixture = JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'mcp-calendar-schemas.json'), 'utf-8')
  ) as { tools: Array<{ name: string; schema: any }> };

  eq('the fixture holds all nine tools', fixture.tools.length, 9);

  // The input really does contain what Gemini rejected — otherwise the rest of
  // this section proves nothing.
  const rawText = JSON.stringify(fixture.tools);
  check('the fixture still contains $ref', rawText.includes('"$ref"'));
  check('and $defs', rawText.includes('"$defs"'));
  check('and the vendor extension', rawText.includes('x-google-enum-descriptions'));
  check('and deprecated', rawText.includes('"deprecated"'));

  {
    const results = fixture.tools.map((t) => ({ name: t.name, result: toGeminiSchema(t.schema) }));
    const unconvertible = results.filter((r) => !r.result.ok);

    eq(
      'every real tool converts',
      unconvertible.map((r) => `${r.name}: ${r.result.reason}`),
      []
    );

    // The generic check. Not "these four keys are gone" — nothing outside the
    // allowlist survives, at any depth.
    const offenders = results.flatMap((r) => offendingKeys(r.result.schema).map((p) => `${r.name}${p}`));
    eq('and nothing outside the allowlist survives anywhere', offenders, []);

    const convertedText = JSON.stringify(results.map((r) => r.result.schema));
    check('no $ref remains', !convertedText.includes('"$ref"'));
    check('no $defs remains', !convertedText.includes('"$defs"'));
    check('no vendor extension remains', !convertedText.includes('x-google-enum-descriptions'));

    // What was removed is reported, not silently dropped.
    const create = results.find((r) => r.name === 'mcp__calendar__create_event')!;
    check('the removals are reported by name', create.result.removed.includes('$defs'));
    check('including the vendor extension', create.result.removed.includes('x-google-enum-descriptions'));
  }

  {
    // Inlining has to preserve meaning, not merely produce something legal.
    const create = fixture.tools.find((t) => t.name === 'mcp__calendar__create_event')!;
    const out = toGeminiSchema(create.schema);
    check('conversion succeeded', out.ok === true);

    const attendees = out.schema!.properties?.attendees;
    check('a $ref-ed array still has its item schema', !!attendees?.items?.properties);
    check('and the definition was inlined rather than referenced', !('$ref' in (attendees?.items ?? {})));
    check(
      'the inlined definition kept its fields',
      Object.keys(attendees?.items?.properties ?? {}).length > 0
    );

    // The parts the model needs in order to call it correctly.
    const original = create.schema;
    eq('the required list is unchanged', out.schema!.required, original.required);
    check('descriptions survive', typeof out.schema!.properties?.summary?.description === 'string');
  }

  // -----------------------------------------------------------------------
  section('References');

  {
    const out = toGeminiSchema({
      type: 'object',
      $defs: { Point: { type: 'object', properties: { x: { type: 'number' } } } },
      properties: { at: { $ref: '#/$defs/Point' } },
    });
    check('a local $ref is inlined', out.ok === true);
    eq('with the target shape', out.schema!.properties.at.properties.x.type, 'number');
  }

  {
    // The older spelling. Both are in the wild and neither is wrong.
    const out = toGeminiSchema({
      type: 'object',
      definitions: { P: { type: 'string' } },
      properties: { a: { $ref: '#/definitions/P' } },
    });
    check('definitions works as well as $defs', out.ok === true);
    eq('resolving the same way', out.schema!.properties.a.type, 'string');
  }

  {
    // A description written next to the $ref is the more specific one.
    const out = toGeminiSchema({
      type: 'object',
      $defs: { P: { type: 'string', description: '定義側' } },
      properties: { a: { $ref: '#/$defs/P', description: '参照側' } },
    });
    eq('a sibling key overrides the target', out.schema!.properties.a.description, '参照側');
  }

  {
    const out = toGeminiSchema({
      type: 'object',
      properties: { a: { $ref: '#/$defs/Missing' } },
    });
    check('an unresolvable $ref is refused', out.ok === false);
    check('and says which one', (out.reason ?? '').includes('Missing'));
  }

  {
    const out = toGeminiSchema({
      type: 'object',
      properties: { a: { $ref: 'https://example.com/schema.json' } },
    });
    check('an external $ref is refused rather than fetched', out.ok === false);
  }

  {
    // A definition that contains itself. Truncating at some depth would hand
    // the model a contract the server never published.
    const out = toGeminiSchema({
      type: 'object',
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
      properties: { root: { $ref: '#/$defs/Node' } },
    });
    check('a cycle is refused rather than truncated', out.ok === false);
    check('and named as such', (out.reason ?? '').includes('循環'));
  }

  // -----------------------------------------------------------------------
  section('The allowlist, not a list of known offenders');

  {
    const out = toGeminiSchema({
      type: 'object',
      readOnly: true,
      deprecated: true,
      'x-google-enum-descriptions': ['a'],
      'x-something-nobody-has-seen-yet': 1,
      $comment: 'hello',
      properties: { a: { type: 'string', writeOnly: true } },
    });
    check('conversion succeeds', out.ok === true);
    eq('and only allowed keys remain', offendingKeys(out.schema), []);
    // The point of the allowlist: a key nobody anticipated is handled by the
    // same rule as the four that were.
    check('an unanticipated vendor key is removed', out.removed.includes('x-something-nobody-has-seen-yet'));
    check('as is a nested one', out.removed.includes('writeOnly'));
    check('and the removals are reported', out.removed.includes('readOnly') && out.removed.includes('deprecated'));
  }

  // -----------------------------------------------------------------------
  section('Types and formats');

  {
    const out = toGeminiSchema({ type: ['string', 'null'], description: 'x' });
    eq('a nullable union becomes a type', out.schema!.type, 'string');
    eq('plus a flag', out.schema!.nullable, true);
  }

  {
    const out = toGeminiSchema({ type: ['string', 'number'] });
    check('a genuine union is refused', out.ok === false);
  }

  {
    eq('int32 survives on an integer', toGeminiSchema({ type: 'integer', format: 'int32' }).schema!.format, 'int32');
    eq('date-time survives on a string', toGeminiSchema({ type: 'string', format: 'date-time' }).schema!.format, 'date-time');
    // Gemini rejects formats it does not know, and the description almost
    // always repeats the constraint anyway.
    const email = toGeminiSchema({ type: 'string', format: 'email' });
    check('an unsupported format is dropped', email.schema!.format === undefined);
    check('and reported', email.removed.includes('format'));
    check('int32 on a string is dropped too', toGeminiSchema({ type: 'string', format: 'int32' }).schema!.format === undefined);
  }

  {
    const out = toGeminiSchema({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] });
    check('a tuple is refused rather than half-converted', out.ok === false);
    check('and says why', (out.reason ?? '').includes('タプル'));
  }

  // -----------------------------------------------------------------------
  section('required cannot outlive its property');

  {
    const out = toGeminiSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a', 'b'],
    });
    // Enforcing a property the model cannot supply makes every call fail.
    eq('a required name with no property is pruned', out.schema!.required, ['a']);
    check('and the pruning is reported', out.removed.some((r) => r.startsWith('required')));
  }

  {
    const out = toGeminiSchema({ type: 'object', properties: {}, required: ['gone'] });
    check('an entirely stale required list is removed', out.schema!.required === undefined);
  }

  // -----------------------------------------------------------------------
  section('Edges');

  {
    const out = toGeminiSchema(undefined);
    check('a tool with no parameters converts', out.ok === true);
    eq('to an empty object', out.schema, { type: 'object', properties: {} });
  }

  {
    check('a non-object schema is refused', toGeminiSchema('nonsense' as any).ok === false);
    check('as is an array', toGeminiSchema([1, 2] as any).ok === false);
  }

  {
    // Conversion must not edit the caller's object.
    const original = { type: 'object', readOnly: true, properties: { a: { type: 'string', deprecated: true } } };
    const snapshot = JSON.stringify(original);
    toGeminiSchema(original);
    eq('the input is not mutated', JSON.stringify(original), snapshot);
  }

  {
    const out = toGeminiSchema({ type: 'string', enum: ['a', 'b'], 'x-google-enum-descriptions': ['A', 'B'] });
    eq('an enum keeps its values', out.schema!.enum, ['a', 'b']);
    check('while its vendor annotation goes', out.schema!['x-google-enum-descriptions'] === undefined);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Gemini schema: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All gemini schema tests passed.');
}

main();
