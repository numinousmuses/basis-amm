import { useCallback, useEffect, useRef, useState } from "react";

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Fetch on mount and every `intervalMs` (0 = once). Keeps the last good value on transient errors. */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 0): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const gen = useRef(0);
  const reload = useCallback(async () => {
    const g = gen.current;
    try {
      const v = await fnRef.current();
      if (g !== gen.current) return;
      setData(v);
      setError(null);
    } catch (e: any) {
      if (g !== gen.current) return;
      setError(String(e?.message ?? e));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    gen.current++;
    setLoading(true);
    setData(undefined);
    void reload();
    if (!intervalMs) return;
    const t = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload };
}

/** Re-render every `ms` so relative times and countdowns stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
