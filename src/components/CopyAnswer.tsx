import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyAnswer({ text }: { text: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setStatus('copied');
      timer.current = setTimeout(() => setStatus('idle'), 2000);
    } catch {
      if (mounted.current) setStatus('failed');
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void copy()} aria-label="回答をコピー"
        className="inline-flex items-center gap-1.5 min-h-9 px-2 rounded-md text-[12px] text-[var(--hud-muted)] hover:bg-sky-400/10">
        {status === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        <span aria-live="polite">{status === 'copied' ? 'コピーしました' : 'コピー'}</span>
      </button>
      {status === 'failed' && <span role="status" className="text-[12px] text-[var(--hud-danger)]">コピーできません。本文を選択してコピーしてください。</span>}
    </div>
  );
}
