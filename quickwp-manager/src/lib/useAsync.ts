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
  publish(key, value);
}

// Screens reading the same key: an answer that lands for one is shown by all
// of them. Without this, updating core from Settings left the notice above it
// and the mark on the tab saying an update was still waiting.
const watchers = new Map<string, Set<(value: unknown) => void>>();

function publish(key: string, value: unknown) {
  for (const fn of watchers.get(key) ?? []) fn(value);
}

function watch(key: string, fn: (value: unknown) => void) {
  const set = watchers.get(key) ?? new Set();
  set.add(fn);
  watchers.set(key, set);
  return () => {
    set.delete(fn);
    if (!set.size) watchers.delete(key);
  };
}

// Requests still on their way, per key: a screen that mounts while the same
// data is being fetched ahead of it waits for that answer instead of asking
// WP-CLI a second time.
const pending = new Map<string, Promise<unknown>>();

function shared<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const inflight = pending.get(key) as Promise<T> | undefined;
  if (inflight) return inflight;
  const p = fn().finally(() => {
    if (pending.get(key) === p) pending.delete(key);
  });
  pending.set(key, p);
  return p;
}

// How each key is fetched, as its screens last asked for it: what a refresh
// after a change elsewhere re-runs.
const fetchers = new Map<string, () => Promise<unknown>>();

/**
 * Fetch these keys again -- those some screen has read -- and hand every
 * screen showing them the new answer. For a change made on one screen that
 * others show: stopping MySQL from Services moves the Sites screen too.
 */
export function refresh(keys: Iterable<string>) {
  for (const key of keys) {
    const fn = fetchers.get(key);
    if (!fn || !(cache.has(key) || watchers.has(key))) continue;
    // Not deduplicated against a request already on its way: that one may
    // have left before the change, and would bring back the old answer.
    void fn()
      .then((v) => {
        cache.set(key, v);
        publish(key, v);
      })
      .catch(() => {});
  }
}

/**
 * Fetch into the cache ahead of the screen that shows it, so that screen
 * opens with its values already there. Does nothing when the key is known or
 * already on its way.
 */
export function prefetch<T>(key: string, fn: () => Promise<T>) {
  if (!fetchers.has(key)) fetchers.set(key, fn);
  if (cache.has(key) || pending.has(key)) return;
  void shared(key, fn)
    .then((v) => {
      cache.set(key, v);
      publish(key, v);
    })
    .catch(() => {});
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
  if (key) fetchers.set(key, fn);

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
      const value = await shared(key, fn);
      if (mine !== latest.current) return;
      if (key) {
        cache.set(key, value);
        publish(key, value);
      }
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

  // Another screen reading the same key refreshed it: show that.
  useEffect(() => {
    if (!key) return;
    return watch(key, (value) => {
      latest.current++;
      setDataState(value as T);
      setLoading(false);
    });
  }, [key]);

  // Optimistic updates go to the cache too, so the next visit starts from
  // what the screen last showed rather than from before the change.
  const setData = useCallback(
    (v: SetStateAction<T | null>) =>
      setDataState((prev) => {
        const next = typeof v === "function" ? (v as (p: T | null) => T | null)(prev) : v;
        if (key) {
          cache.set(key, next);
          publish(key, next);
        }
        return next;
      }),
    [key],
  );

  return { data, error, loading, reload: run, setData };
}
