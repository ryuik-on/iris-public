/**
 * What the microphone is allowed to turn into a request.
 *
 * The assertions that matter are the ones about *not* sending. A microphone
 * hears a room: a sentence spoken to someone else, a television, a phone call.
 * The rule that only a named address becomes a request is the whole reason
 * ambient listening is safe to offer at all, and the failure it guards against
 * is silent — a remark that becomes a request looks exactly like a request.
 *
 * Run: npx tsx scripts/test-voice-loop.ts
 */
import { VoiceLoop, Heard, VoiceEvent } from '../server/services/voice_loop.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function section(name: string) {
  console.log(`\n▸ ${name}`);
}

function eq(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
    console.log(`  ✗ ${name}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
  }
}

function said(text: string, addressed: boolean, request = text): Heard {
  return { text, request, addressed, at: '2026-08-21T10:00:00Z' };
}

/** A loop with everything faked, so the rule is what is being tested. */
function build(options: {
  transcripts: Heard[];
  state?: string;
  result?: any;
  throws?: boolean;
  /** 返事が届く刻み。渡すと、返る前に声が出るかを見られる。 */
  deltas?: string[];
  /** 途中で作り直す（プロバイダの失敗からの再試行）。 */
  resetAfter?: number;
}) {
  const sent: string[] = [];
  const events: VoiceEvent[] = [];
  /** 喋った順。**返る前に出たかどうかが、この試験の主題。** */
  const spoken: string[] = [];
  let spokenBeforeReturn = 0;
  let drained = false;

  const loop = new VoiceLoop({
    status: () => ({ state: options.state ?? 'listening', pending: options.transcripts.length }),
    drain: () => {
      if (drained) return { transcripts: [] };
      drained = true;
      return { transcripts: options.transcripts };
    },
    chat: () =>
      ({
        sendMessage: async (input: any) => {
          sent.push(input.message);
          if (options.throws) throw new Error('provider is down');
          for (const [i, delta] of (options.deltas ?? []).entries()) {
            if (options.resetAfter === i) input.stream?.reset();
            input.stream?.delta(delta);
            /*
             * 本物の流れには delta の間に待ちがある。**同期でまとめて流すと、
             * 声の列が一度も回らないまま返ってしまう** —— 偽物の都合で
             * 「返る前に喋ったか」を測れなくしない。
             */
            await new Promise((r) => setTimeout(r, 0));
          }
          spokenBeforeReturn = spoken.length;
          return options.result ?? { status: 'completed', reply: 'はい', conversationId: 'c1' };
        },
      }) as any,
    speak: (text: string) => { spoken.push(text); },
    onEvent: (e) => events.push(e),
    conversationId: () => null,
    setConversationId: () => {},
  });

  return { loop, sent, events, spoken, before: () => spokenBeforeReturn };
}

async function main() {
  section('Ambient listening sends only what carries the name');

  {
    const { loop, sent, events } = build({
      transcripts: [
        said('イーリス、今日の予定は', true, '今日の予定は'),
        said('明日ちょっと出かけようか', false),
        said('そのあと駅前で', false),
      ],
    });
    await loop.tick();

    eq('the addressed one is sent', sent, ['今日の予定は']);

    /**
     * The important one. Two remarks to somebody else were heard, and neither
     * became a request. If this ever passes them through, a conversation in
     * the room starts operating the assistant.
     */
    eq('and nothing else is', sent.length, 1);
    eq(
      'the rest are counted, not silently dropped',
      events.find((e) => e.type === 'voice.overheard')?.count,
      2
    );
  }

  {
    const { loop, sent } = build({
      transcripts: [said('今日は暑いね', false), said('そうだね', false)],
    });
    await loop.tick();
    eq('a room with no address sends nothing at all', sent, []);
  }

  section('Holding the key is itself the address');

  {
    const { loop, sent } = build({
      transcripts: [said('今日の予定は', false), said('あと支出も', false)],
    });
    loop.setMode('push');
    await loop.tick();

    // Nothing here carries the name, and all of it is meant for IRIS: the
    // person is holding a key down, which is a plainer address than a word.
    eq('everything heard is sent', sent, ['今日の予定は', 'あと支出も']);
  }

  section('The name on its own');

  {
    const { loop, sent } = build({ transcripts: [said('イーリス', true, '')] });
    await loop.tick();
    // An address with no request. Answered, not sent as an empty message.
    eq('becomes a question, not an empty turn', sent, ['はい？']);
  }

  section('What was heard is not lost when the microphone closes');

  {
    /**
     * Recognition finishes after the microphone does. Measured: the final
     * transcript and the `stopped` event carried the same millisecond, and a
     * loop that required `listening` never came back for it — so every
     * push-to-talk request was dropped, silently, at the last step.
     */
    const { loop, sent } = build({
      transcripts: [said('イーリス、予定は', true, '予定は')],
      state: 'idle',
    });
    await loop.tick();
    eq('a closed microphone still delivers what it captured', sent, ['予定は']);
  }

  {
    const { loop, sent } = build({ transcripts: [], state: 'idle' });
    await loop.tick();
    eq('and an empty queue produces nothing', sent, []);
  }

  section('Approval is not something a microphone can grant');

  {
    const { loop, events } = build({
      transcripts: [said('イーリス、メール送って', true, 'メール送って')],
      result: {
        status: 'requires_approval',
        pendingApproval: { toolName: 'send_email' },
        conversationId: 'c1',
      },
    });
    await loop.tick();

    /**
     * The request reaches the boundary and stops there. Approving by voice
     * would mean a microphone in a room could authorise a write, and the
     * boundary exists because a person decides deliberately.
     */
    const approval = events.find((e) => e.type === 'voice.approval');
    eq('it is reported as needing a person', approval?.tool, 'send_email');
    eq('and not reported as answered', events.some((e) => e.type === 'voice.answered'), false);
  }

  section('A failure is said, not swallowed');

  {
    const { loop, events } = build({
      transcripts: [said('イーリス、予定は', true, '予定は')],
      throws: true,
    });
    await loop.tick();
    const failure = events.find((e) => e.type === 'voice.failed');
    eq('the failure is reported', failure?.message, 'provider is down');
    // Silence after speaking is indistinguishable from not having been heard.
    eq('and not reported as answered', events.some((e) => e.type === 'voice.answered'), false);
  }

  section('Two ticks cannot answer the same person twice');

  {
    const { loop, sent } = build({
      transcripts: [said('イーリス、予定は', true, '予定は')],
    });
    await Promise.all([loop.tick(), loop.tick()]);
    eq('a concurrent pass is skipped', sent.length, 1);
  }

  section('声は重ならない');

  {
    /*
     * 列は呼び出しの順を守るだけでは足りない。**前の音が鳴り終わってから**
     * 次を渡す。`speak` が約束を返すのはそのため。
     */
    const order: string[] = [];
    let live = 0;
    let overlapped = false;
    const { loop } = (() => {
      const built = build({
        transcripts: [said('IRIS 今日の予定は', true, '今日の予定は')],
        deltas: ['一文目です。', '二文目です。', '三文目です。'],
        result: { status: 'completed', reply: '一文目です。二文目です。三文目です。', conversationId: 'c1' },
      });
      return built;
    })();
    // speak を差し替えて、鳴っている間を作る。
    (loop as any).options.speak = async (text: string) => {
      if (live > 0) overlapped = true;
      live++;
      order.push(text);
      await new Promise((r) => setTimeout(r, 5));
      live--;
    };
    await loop.tick();
    await new Promise((r) => setTimeout(r, 60));
    eq('重ならない', overlapped, false);
    eq('順番どおり', order.join(''), '一文目です。二文目です。三文目です。');
  }

  section('返事が全部できる前に、もう喋り始めている');

  {
    /*
     * **これがこの変更の全部。**前は `await sendMessage` が返ってから
     * `speak(reply)` を呼んでいたので、単純な問いでも 1.35〜3.08秒 は無音だった
     * （実測 2026-09-29）。
     */
    const { loop, spoken, before, events } = build({
      transcripts: [said('IRIS 今日の予定は', true, '今日の予定は')],
      deltas: ['今日は19時から', '職場です。', 'そのあとは', '空いています。'],
      result: { status: 'completed', reply: '今日は19時から職場です。そのあとは空いています。', conversationId: 'c1' },
    });
    await loop.tick();
    await new Promise((r) => setTimeout(r, 0));
    eq('返る前にもう声が出ている', before() > 0, true);
    eq('最初に出たのは一文目', spoken[0], '今日は19時から職場です。');
    eq('言い残しは無い', spoken.join(''), '今日は19時から職場です。そのあとは空いています。');
    eq('最初の一声を記録する', events.some((e) => e.type === 'voice.speaking'), true);
  }

  {
    // 流れてこない相手なら、前と同じ ——「全部できてから全文を喋る」。
    const { loop, spoken, before } = build({
      transcripts: [said('IRIS 今日の予定は', true, '今日の予定は')],
      result: { status: 'completed', reply: '今日は19時から職場です。', conversationId: 'c1' },
    });
    await loop.tick();
    await new Promise((r) => setTimeout(r, 0));
    eq('流れてこなければ返ってから喋る', before(), 0);
    eq('返事は全文そのまま', spoken, ['今日は19時から職場です。']);
  }

  {
    /*
     * 作り直し。**出た音は戻せない。**捨てられるのは手元の分だけで、その事実を
     * 黙って無かったことにしない。
     */
    const { loop, events, spoken } = build({
      transcripts: [said('IRIS 今日の予定は', true, '今日の予定は')],
      deltas: ['まちがった答えです。', 'ほんとうの答えです。'],
      resetAfter: 1,
      result: { status: 'completed', reply: 'ほんとうの答えです。', conversationId: 'c1' },
    });
    await loop.tick();
    await new Promise((r) => setTimeout(r, 0));
    eq('作り直しを記録する', events.some((e) => e.type === 'voice.restated'), true);
    eq('言いかけた分は取り消せないので、そのまま残る', spoken[0], 'まちがった答えです。');
    eq('新しい答えも言う', spoken.join('').includes('ほんとうの答えです。'), true);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Voice loop: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All voice loop tests passed.');
}

void main();
