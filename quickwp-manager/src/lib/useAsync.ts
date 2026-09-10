import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { errorText } from "./api";

// The last answer per key, for the life of the window. A screen that has been
// shown before paints what it had at once and refreshes underneath, instead of
// sitting on "Loading…" behind a WP-CLI call every time it is opened.
const cache = new Map<string, unknown>();

export function peekCache<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function putCache(key: string, value: unknown) {
  cache.set(key, value);
}

/**
 * Load, expose a reload, and surface the error text rather than swallowing it.
 *
 * With a `key`, the result is remembered: the next mount (or the next time the
 * deps come back to the same values) starts from it with `loading` false, and
 * the fresh answer replaces it when it lands.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = [], key?: string) {
  const [data, setDataState] = useState<T | null>(() =>
    key ? (peekCache<T>(key) ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !(key && cache.has(key)));
  // Only the newest request may write. Switching sites quickly would
  // otherwise let a slow answer for the site you left land on the one you
  // switched to.
  const latest = useRef(0);

  const run = useCallback(async () => {
    const mine = ++latest.current;
    if (key && cache.has(key)) {
      setDataState(cache.get(key) as T);
      setLoading(false);
    } else {
      // Keyed data belongs to its key: never show another site's list while
      // this one loads.
      if (key) setDataState(null);
      setLoading(true);
    }
    try {
      const value = await fn();
      if (mine !== latest.current) return;
      if (key) cache.set(key, value);
      setDataState(value);
      setError(null);
    } catch (e) {
      if (mine !== latest.current) return;
      setError(errorText(e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [...deps, key]);

  useEffect(() => {
    void run();
  }, [run]);

  // Optimistic updates go to the cache too, so the next visit starts from
  // what the screen last showed rather than from before the change.
  const setData = useCallback(
    (v: SetStateAction<T | null>) =>
      setDataState((prev) => {
        const next = typeof v === "function" ? (v as (p: T | null) => T | null)(prev) : v;
        if (key) cache.set(key, next);
        return next;
      }),
    [key],
  );

  return { data, error, loading, reload: run, setData };
}
