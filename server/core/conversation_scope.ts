import { AsyncLocalStorage } from 'async_hooks';

/**
 * いま道具を呼んでいる会話。
 *
 * 道具は引数しか受け取らないので、「どの会話で頼まれた仕事か」を知る手段が無かった。
 * 開発を任せて「終わったらまた知らせます」と言っても、終わったときに**約束した
 * 会話へ戻る道が無い**ので、別の場所に知らせが落ちて、聞くまで何も起きなかった
 * （利用者、2026-10-01）。会話の取り回しを道具の引数に足さず、呼ぶ側が囲む。
 */
const scope = new AsyncLocalStorage<{ conversationId: string | null }>();

export function withConversation<T>(conversationId: string | null | undefined, run: () => T): T {
  return scope.run({ conversationId: conversationId ?? null }, run);
}

export function currentConversationId(): string | null {
  return scope.getStore()?.conversationId ?? null;
}
