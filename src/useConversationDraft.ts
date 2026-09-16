import { useRef, useState } from 'react';

const PREFIX = 'iris-draft:';

export function useConversationDraft(conversationId: string | null) {
  const key = PREFIX + (conversationId ?? 'new');
  const cache = useRef<Record<string, string>>({});
  const [, redraw] = useState(0);
  const [storageFailed, setStorageFailed] = useState(false);
  if (!(key in cache.current)) {
    try { cache.current[key] = localStorage.getItem(key) ?? ''; }
    catch { cache.current[key] = ''; }
  }
  const setDraft = (text: string) => {
    cache.current[key] = text;
    try {
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
    redraw(v => v + 1);
  };
  return { draft: cache.current[key], setDraft, storageFailed };
}
