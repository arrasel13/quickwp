import { useEffect, useState } from "react";

/**
 * A preference of this window -- how a pane is laid out, say -- kept in the
 * webview rather than the backend's settings table. Storage can be
 * unavailable; the preference then lasts until the window closes.
 */
export function usePref<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw);
      return typeof parsed === typeof fallback ? (parsed as T) : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Not remembered across launches; nothing else depends on it.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
