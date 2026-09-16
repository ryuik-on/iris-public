import { ChatService } from '../core/chat_service.js';

/**
 * Turning what was heard into a turn, on this side of the wire.
 *
 * The split lived in the browser: transcripts addressed to IRIS by name were
 * sent, everything else was parked in the input box. That rule is right and it
 * is kept exactly — the microphone hears the room, and a remark to someone
 * else must not become a request. What was wrong was where it lived. With the
 * only listener being a web page, speaking to IRIS required having IRIS open,
 * which is the errand the whole resident interface exists to remove.
 *
 * So the loop moves here and the rule comes with it. There is one difference
 * that follows from having no input box: an overheard remark cannot be parked
 * for a person to look at and send. It is counted and dropped. Sending it would
 * be the exact failure the split was built to prevent, and holding it
 * indefinitely would mean a sentence spoken to someone else could be delivered
 * minutes later with no idea where it came from.
 */

export type ListenMode =
  /**
   * Listening because a key is held. Everything heard is meant for IRIS: the
   * person is holding the key down, which is a clearer address than a name.
   */
  | 'push'
  /**
   * Listening all the time. Only what carries the name is a request, and the
   * rest is a room being overheard.
   */
  | 'ambient';

export interface Heard {
  text: string;
  request: string;
  addressed: boolean;
  at: string;
}

export interface VoiceEvent {
  type:
    | 'voice.tick'
    | 'voice.heard'
    | 'voice.overheard'
    | 'voice.answered'
    | 'voice.failed'
    | 'voice.approval';
  text?: string;
  reply?: string;
  tool?: string;
  count?: number;
  message?: string;
}

export interface VoiceLoopOptions {
  status: () => { state: string; pending: number };
  drain: () => { transcripts: Heard[] };
  chat: () => ChatService | null;
  onEvent?: (event: VoiceEvent) => void;
  /** The conversation voice turns land in, so they are not scattered. */
  conversationId: () => string | null;
  /**
   * Says the reply out loud.
   *
   * Only for turns that arrived by voice. Someone who spoke expects to be
   * answered the same way — reading a reply off a two-line band defeats having
   * asked without looking at anything. Typed turns are untouched: speaking
   * those would start talking at a person who chose to type.
   */
  speak?: (text: string) => void;
  setConversationId: (id: string) => void;
  now?: () => number;
}

export class VoiceLoop {
  private mode: ListenMode = 'ambient';
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private options: VoiceLoopOptions) {}

  setMode(mode: ListenMode) {
    this.mode = mode;
  }

  /**
   * Throws away anything left over before a new request starts.
   *
   * Without this, pressing the key delivers whatever was still queued from
   * before it — measured on 2026-08-21: a press produced `state=starting` with
   * one transcript already waiting, and IRIS answered a sentence from minutes
   * earlier as though it had just been said. The reply was correct for what it
   * received, which is the worst kind of wrong: nothing looked broken.
   *
   * A push-to-talk request means "what I say from now", so the queue at the
   * moment of pressing is by definition not part of it.
   */
  discardPending(): number {
    const { transcripts } = this.options.drain();
    return transcripts.length;
  }

  currentMode(): ListenMode {
    return this.mode;
  }

  start(everyMs = 700) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    // Timers keep the process alive; this one should not be the reason it is.
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Serialised on `busy` because a turn can take many seconds, and
   * two overlapping runs would answer the same person twice at once.
   */
  async tick(): Promise<void> {
    if (this.busy) return;
    const status = this.options.status();

    /**
     * Drain whatever is queued, listening or not.
     *
     * The first version required `state === 'listening'`, which loses the last
     * thing said every time. Recognition finishes after the microphone closes:
     * measured on 2026-08-21, the final transcript "今日の予定は" and the
     * `stopped` event carry the same millisecond, and this loop looks every 700
     * ms — so by the time it looked, the state was `idle` and the sentence sat
     * in a queue nobody would ever read. Push-to-talk makes that the normal
     * case rather than a rare one, because the key is released as soon as the
     * speaking stops.
     *
     * A queue with something in it is something that was heard. The state says
     * whether more is coming, not whether what arrived counts.
     */
    if (status.pending === 0) return;

    this.busy = true;
    try {
      const { transcripts } = this.options.drain();
      this.options.onEvent?.({
        type: 'voice.tick',
        count: transcripts.length,
        message: `mode=${this.mode} state=${status.state}`,
      });
      if (transcripts.length === 0) return;

      // In push mode the key being held is the address, so the name is not
      // required. In ambient mode only the name counts.
      const forIris =
        this.mode === 'push' ? transcripts : transcripts.filter((t) => t.addressed);
      const rest = transcripts.length - forIris.length;
      if (rest > 0) {
        this.options.onEvent?.({ type: 'voice.overheard', count: rest });
      }

      for (const heard of forIris) {
        // The name on its own is an address with no request. Answered rather
        // than sent as an empty message.
        const message = (this.mode === 'push' ? heard.text : heard.request).trim() || 'はい？';
        await this.answer(message);
      }
    } finally {
      this.busy = false;
    }
  }

  private async answer(message: string): Promise<void> {
    const chat = this.options.chat();
    if (!chat) {
      this.options.onEvent?.({ type: 'voice.failed', text: message, message: 'まだ準備できていません。' });
      return;
    }

    this.options.onEvent?.({ type: 'voice.heard', text: message });
    try {
      const result = await chat.sendMessage({
        conversationId: this.options.conversationId(),
        message,
        /**
         * A person spoke. It is not an inference, and the origin decides what
         * the run may touch — calling this `inferred` would quietly forbid
         * half the tools for no reason.
         */
        origin: 'user',
        // Presentation only. A spoken request gets a spoken-shaped reply.
        channel: 'voice',
      });

      if (result.conversationId) this.options.setConversationId(result.conversationId);

      if (result.status === 'requires_approval') {
        /**
         * Named, and left where it is. Approving by voice would mean a
         * microphone in a room could authorise a write, and the whole approval
         * boundary is built on a person deciding deliberately.
         */
        this.options.onEvent?.({
          type: 'voice.approval',
          text: message,
          tool: result.pendingApproval?.toolName,
        });
        return;
      }

      const reply = result.reply ?? '';
      this.options.onEvent?.({ type: 'voice.answered', text: message, reply });
      // Spoken back, because it was spoken to. The reply is already shaped for
      // being heard — `channel: 'voice'` above asks for that.
      if (reply) this.options.speak?.(reply);
    } catch (err: any) {
      this.options.onEvent?.({
        type: 'voice.failed',
        text: message,
        message: err?.message ?? String(err),
      });
    }
  }
}
