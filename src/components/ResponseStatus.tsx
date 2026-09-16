import { useEffect, useState } from 'react';

export function ResponseStatus({ phase, lastProgress }: {
  phase: 'sending' | 'thinking' | 'tool_execution' | 'responding';
  lastProgress: number;
}) {
  const [now, setNow] = useState(Date.now);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const quiet = now - lastProgress >= 45000;
  const label = !online ? '端末がオフラインです。接続を確認してください。'
    : quiet ? '45秒以上、応答の更新がありません。処理が続いている可能性があります。'
    : phase === 'tool_execution' ? 'ツールを実行中…'
    : phase === 'sending' ? '送信中…'
    : phase === 'responding' ? '回答中…' : '返答を待っています…';
  return <div role="status" aria-live="polite" className="mb-2 flex items-center gap-2 rounded-xl bg-[var(--hud-bg)] px-3 py-2 text-[13px] leading-relaxed text-[var(--hud-text)]">
    <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--hud-accent)] ${online && !quiet ? 'motion-safe:animate-pulse' : ''}`} />
    <span>{label}</span>
  </div>;
}
