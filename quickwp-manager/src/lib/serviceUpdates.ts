// Newer releases of PHP, MySQL, MariaDB, Node and Adminer.
//
// The backend looks once a day and announces anything new as a desktop
// notification; this is how the Services screen shows the same list, with a
// button each.

import { useCallback, useEffect, useState } from "react";
import { api, errorText, hasBackend, type ServiceUpdate, type UpdatesView } from "./api";

export function useServiceUpdates() {
  const [view, setView] = useState<UpdatesView>({ updates: [], checked_at: 0 });
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!hasBackend) return;
    void api.updatesList().then(setView).catch(() => {});
    const off = api.onServiceUpdates(setView);
    return () => void off.then((f) => f());
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setMessage(null);
    try {
      const v = await api.updatesCheck();
      setView(v);
      setMessage({
        ok: true,
        text: v.updates.length ? `${v.updates.length} update${v.updates.length === 1 ? "" : "s"} available.` : "Everything is up to date.",
      });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setChecking(false);
    }
  }, []);

  const apply = useCallback(async (u: ServiceUpdate) => {
    const key = `${u.service}:${u.id}`;
    setApplying(key);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await api.updateApply(u.service, u.id) });
      setView(await api.updatesList());
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setApplying(null);
    }
  }, []);

  const find = useCallback(
    (service: ServiceUpdate["service"], id: string) =>
      view.updates.find((u) => u.service === service && u.id === id) ?? null,
    [view],
  );

  return { ...view, checking, applying, message, check, apply, find };
}

export type ServiceUpdates = ReturnType<typeof useServiceUpdates>;

/** "April 2026", from "2026-04-30". */
export function monthYear(date: string | null | undefined): string {
  if (!date) return "";
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function isPast(date: string | null | undefined): boolean {
  if (!date) return false;
  return new Date(`${date}T23:59:59`).getTime() < Date.now();
}

/**
 * PHP's security-support end per minor, as php.net publishes it. PHP has no
 * LTS: every release gets two years of fixes and two of security fixes.
 */
export const PHP_SUPPORT_ENDS: Record<string, string> = {
  "8.0": "2023-11-26",
  "8.1": "2025-12-31",
  "8.2": "2026-12-31",
  "8.3": "2027-12-31",
  "8.4": "2028-12-31",
  "8.5": "2029-12-31",
};

/** MySQL's support windows: 8.4 is the LTS line, 8.0 has ended. */
export const MYSQL_SUPPORT: Record<string, { lts: boolean; ends: string }> = {
  "8.4": { lts: true, ends: "2032-04-30" },
  "8.0": { lts: false, ends: "2026-04-30" },
};
