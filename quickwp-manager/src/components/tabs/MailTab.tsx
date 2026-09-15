import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  EnvelopeIcon,
  MagnifyingGlassIcon,
  PaperClipIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import {
  api,
  errorText,
  hasBackend,
  MailList,
  MailMessage,
  MailStatus,
  MailSummary,
  Site,
} from "../../lib/api";
import { peekCache, putCache } from "../../lib/useAsync";
import ConfirmDialog from "../ui/ConfirmDialog";

type View = "html" | "text" | "raw" | "headers";

// Kept across tab switches: a message does not change once caught, so one
// opened before opens again at once.
const messageCache = new Map<string, MailMessage>();
const rawCache = new Map<string, string>();
const headerCache = new Map<string, Record<string, string[]>>();

/**
 * The mail one site sent, caught by Mailpit: a list on the left, the message
 * on the right with its HTML, text, raw source and headers. Opening another
 * site shows that site's mail.
 *
 * Shown from cache at once and refreshed underneath; new mail arrives by
 * itself every few seconds while the tab is on screen.
 */
export default function MailTab({ site }: { site: Site | null }) {
  const domain = site?.domain ?? null;
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const listKey = `mail:${domain}:${query}`;
  const [list, setList] = useState<MailList | null>(() => peekCache<MailList>(listKey) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<MailStatus | null>(() => peekCache<MailStatus>("mail-status") ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MailMessage | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [view, setView] = useState<View>("html");
  const [raw, setRaw] = useState<string | null>(null);
  const [headers, setHeaders] = useState<Record<string, string[]> | null>(null);
  const [busy, setBusy] = useState<"read" | "clear" | "install" | "catch" | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef(0);
  const selectedRef = useRef<string | null>(null);

  // Another site: its own mail, nothing still open from the last one.
  useEffect(() => {
    setSelected(null);
    selectedRef.current = null;
    setDetail(null);
  }, [domain]);

  // Search as you type, once typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const refreshStatus = useCallback(() => {
    if (!hasBackend) return;
    void api
      .mailStatus()
      .then((st) => {
        putCache("mail-status", st);
        setStatus(st);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(
    async (quiet = false) => {
      if (!hasBackend || !domain) return;
      const mine = ++latest.current;
      if (!quiet) setLoading(true);
      try {
        const next = await api.mailMessages(domain, query);
        if (mine !== latest.current) return;
        putCache(listKey, next);
        setList(next);
        setError(null);
        if (!quiet) refreshStatus();
      } catch (e) {
        if (mine !== latest.current) return;
        setError(errorText(e));
        refreshStatus();
      } finally {
        if (mine === latest.current) setLoading(false);
      }
    },
    [domain, query, listKey, refreshStatus],
  );

  useEffect(() => {
    setList(peekCache<MailList>(listKey) ?? null);
    void load();
  }, [load, listKey]);

  // New mail shows up by itself -- only while this tab is actually on screen.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && rootRef.current?.offsetParent) void load(true);
    }, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const open = async (m: MailSummary) => {
    selectedRef.current = m.ID;
    setSelected(m.ID);
    setDetailError(null);
    setRaw(rawCache.get(m.ID) ?? null);
    setHeaders(headerCache.get(m.ID) ?? null);
    const cached = messageCache.get(m.ID) ?? null;
    setDetail(cached);
    if (cached && !cached.HTML && view === "html") setView("text");
    if (!m.Read) {
      setList((l) =>
        l
          ? {
              ...l,
              unread: Math.max(0, l.unread - 1),
              messages: l.messages.map((x) => (x.ID === m.ID ? { ...x, Read: true } : x)),
            }
          : l,
      );
    }
    if (cached) return;
    try {
      const d = await api.mailMessage(m.ID);
      messageCache.set(m.ID, d);
      if (selectedRef.current !== m.ID) return;
      setDetail(d);
      if (!d.HTML && view === "html") setView("text");
    } catch (e) {
      if (selectedRef.current === m.ID) setDetailError(errorText(e));
    }
  };

  // Raw source and headers are fetched when their tab is opened, once.
  useEffect(() => {
    const id = selected;
    if (!id) return;
    if (view === "raw" && !rawCache.has(id)) {
      api
        .mailRaw(id)
        .then((r) => {
          rawCache.set(id, r);
          if (selectedRef.current === id) setRaw(r);
        })
        .catch((e) => setDetailError(errorText(e)));
    }
    if (view === "headers" && !headerCache.has(id)) {
      api
        .mailHeaders(id)
        .then((h) => {
          headerCache.set(id, h);
          if (selectedRef.current === id) setHeaders(h);
        })
        .catch((e) => setDetailError(errorText(e)));
    }
  }, [view, selected]);

  const messages = list?.messages ?? [];
  const shown = useMemo(
    () => messages.filter((m) => filter === "all" || !m.Read),
    [messages, filter],
  );
  const summary = messages.find((m) => m.ID === selected) ?? null;
  const siteName = site?.name || domain || "";

  const markAllRead = async () => {
    setBusy("read");
    try {
      await api.mailMarkRead(messages.map((m) => m.ID), false);
      await load(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const clearAll = async () => {
    setConfirmClear(false);
    setBusy("clear");
    try {
      await api.mailDelete(messages.map((m) => m.ID), false);
      selectedRef.current = null;
      setSelected(null);
      setDetail(null);
      await load(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    setBusy("install");
    setError(null);
    try {
      await api.mailInstall();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      refreshStatus();
    }
  };

  const toggleCatchAll = async () => {
    setBusy("catch");
    try {
      await api.mailSetCatchAll(!status?.catch_all);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      refreshStatus();
    }
  };

  if (!hasBackend) {
    return <p className="p-6 text-sm text-gray-500">Mail needs the Nexora app behind this window.</p>;
  }
  if (!domain) {
    return <p className="p-6 text-sm text-gray-500">Choose a site to see the mail it sends.</p>;
  }

  const notInstalled = status !== null && !status.installed;

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-white">
      {/* Top bar */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-gray-200 bg-gray-50/70 px-4 py-2.5">
        <StatusPill status={status} loading={loading} />

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <BarButton onClick={() => void api.mailOpen()} disabled={!status?.running}>
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            Open Mailpit
          </BarButton>
          <BarButton onClick={() => void markAllRead()} disabled={!list?.unread || busy !== null}>
            <CheckIcon className="h-4 w-4" />
            {busy === "read" ? "Marking…" : "Mark all read"}
          </BarButton>
          <BarButton onClick={() => setConfirmClear(true)} disabled={!list?.total || busy !== null} danger>
            <TrashIcon className="h-4 w-4" />
            {busy === "clear" ? "Clearing…" : "Clear all"}
          </BarButton>
        </div>
      </div>

      {error && !notInstalled && (
        <p role="alert" className="flex-shrink-0 border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {notInstalled ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <EnvelopeIcon className="mx-auto h-9 w-9 text-gray-300" />
            <p className="mt-3 text-sm font-semibold text-gray-900">Mailpit is not installed</p>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">
              Mailpit catches the mail your sites send, so none of it reaches a real inbox.
            </p>
            <button
              type="button"
              onClick={() => void install()}
              disabled={busy === "install"}
              className="mt-4 rounded-lg bg-wp-blue px-4 py-2 text-sm font-semibold text-white hover:bg-wp-blue-dark disabled:opacity-60"
            >
              {busy === "install" ? "Installing…" : "Install Mailpit"}
            </button>
            {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Message list */}
          <aside className="flex w-[340px] flex-shrink-0 flex-col border-r border-gray-200 bg-white">
            <div className="flex-shrink-0 space-y-2.5 border-b border-gray-100 p-3">
              <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 focus-within:border-wp-blue/50 focus-within:bg-white focus-within:ring-2 focus-within:ring-wp-blue/10">
                <MagnifyingGlassIcon className="h-4 w-4 flex-shrink-0 text-gray-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search mail…"
                  aria-label="Search mail"
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0"
                />
              </label>
              <div role="tablist" aria-label="Show" className="grid grid-cols-2 rounded-lg bg-gray-100 p-0.5">
                {(["all", "unread"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={filter === f}
                    onClick={() => setFilter(f)}
                    className={clsx(
                      "inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors",
                      filter === f ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800",
                    )}
                  >
                    {f === "all" ? "All" : "Unread"}
                    {f === "unread" && !!list?.unread && (
                      <span className="min-w-[18px] rounded-full bg-wp-blue px-1.5 text-[10px] font-semibold leading-[18px] text-white">
                        {list.unread}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {list === null ? (
                <ListSkeleton />
              ) : shown.length === 0 ? (
                <div className="px-6 py-12 text-center">
                  <EnvelopeIcon className="mx-auto h-8 w-8 text-gray-300" />
                  <p className="mt-2 text-sm font-medium text-gray-700">
                    {query ? "No matching mail" : filter === "unread" ? "No unread mail" : "No mail yet"}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">
                    {query ? "Try other words." : `Mail ${siteName} sends shows up here as it is sent.`}
                  </p>
                </div>
              ) : (
                shown.map((m) => (
                  <button
                    key={m.ID}
                    type="button"
                    onClick={() => void open(m)}
                    aria-current={selected === m.ID ? "true" : undefined}
                    className={clsx(
                      "block w-full border-b border-l-[3px] border-b-gray-100 px-4 py-3 text-left transition-colors",
                      selected === m.ID ? "border-l-wp-blue bg-blue-50/60" : "border-l-transparent hover:bg-gray-50",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        aria-label={m.Read ? undefined : "unread"}
                        className={clsx("h-2 w-2 flex-shrink-0 rounded-full", m.Read ? "bg-transparent" : "bg-wp-blue")}
                      />
                      <span
                        className={clsx(
                          "min-w-0 flex-1 truncate text-[13px]",
                          m.Read ? "text-gray-600" : "font-semibold text-gray-900",
                        )}
                      >
                        {sender(m.From)}
                      </span>
                      {m.Attachments > 0 && <PaperClipIcon className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />}
                      <span className="flex-shrink-0 text-[11px] tabular-nums text-gray-400">{when(m.Created)}</span>
                    </div>
                    <p
                      className={clsx(
                        "mt-0.5 truncate pl-4 text-[13px]",
                        m.Read ? "text-gray-700" : "font-medium text-gray-900",
                      )}
                    >
                      {m.Subject || "(no subject)"}
                    </p>
                    <p className="mt-0.5 truncate pl-4 font-mono text-[11px] text-gray-400">
                      to {recipients(m.To) || "—"}
                    </p>
                  </button>
                ))
              )}
            </div>

            <div className="flex flex-shrink-0 items-center gap-3 border-t border-gray-100 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-700">Catch all outgoing mail</p>
                <p className="truncate text-[11px] text-gray-400">Sites' mail stays here, never delivered</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={!!status?.catch_all}
                aria-label="Catch all outgoing mail"
                disabled={!status || busy === "catch"}
                onClick={() => void toggleCatchAll()}
                className={clsx(
                  "relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
                  status?.catch_all ? "bg-emerald-500" : "bg-gray-300",
                )}
              >
                <span
                  className={clsx(
                    "h-4 w-4 rounded-full bg-white shadow transition-transform",
                    status?.catch_all ? "translate-x-[18px]" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
          </aside>

          {/* Reader */}
          <section className="flex min-w-0 flex-1 flex-col bg-gray-50/50">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center p-8">
                <div className="text-center">
                  <EnvelopeIcon className="mx-auto h-10 w-10 text-gray-300" />
                  <p className="mt-2 text-sm text-gray-500">
                    {messages.length ? "Select a message to read it" : "Nothing to read yet"}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <header className="flex-shrink-0 border-b border-gray-200 bg-white px-6 py-4">
                  <div className="flex items-start gap-3">
                    <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full bg-gray-100 text-sm font-semibold uppercase text-gray-600">
                      {initial(detail?.From ?? summary?.From ?? null)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-base font-semibold text-gray-900">
                        {(detail?.Subject ?? summary?.Subject) || "(no subject)"}
                      </h2>
                      <p className="mt-1 truncate text-xs text-gray-500">
                        From{" "}
                        <span className="font-mono text-gray-800">
                          {address(detail?.From ?? summary?.From ?? null)}
                        </span>
                      </p>
                      <p className="truncate text-xs text-gray-500">
                        To{" "}
                        <span className="font-mono text-gray-800">
                          {recipients(detail?.To ?? summary?.To ?? null) || "—"}
                        </span>
                      </p>
                    </div>
                    <span className="flex-shrink-0 text-xs text-gray-400">
                      {fullDate(detail?.Date || summary?.Created || "")}
                    </span>
                  </div>
                </header>

                <div role="tablist" aria-label="Message view" className="flex flex-shrink-0 gap-1 border-b border-gray-200 bg-white px-4">
                  {(
                    [
                      ["html", "HTML"],
                      ["text", "Text"],
                      ["raw", "Raw source"],
                      ["headers", "Headers"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={view === key}
                      onClick={() => setView(key)}
                      className={clsx(
                        "relative px-3 py-2.5 text-[13px] font-medium transition-colors",
                        view === key ? "text-wp-blue" : "text-gray-500 hover:text-gray-900",
                      )}
                    >
                      {label}
                      {view === key && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-wp-blue" />}
                    </button>
                  ))}
                </div>

                <div className="relative min-h-0 flex-1 overflow-auto">
                  {detailError ? (
                    <p className="p-6 text-sm text-red-600">{detailError}</p>
                  ) : !detail && (view === "html" || view === "text") ? (
                    <p className="p-6 text-sm text-gray-400">Opening…</p>
                  ) : view === "html" ? (
                    detail?.HTML ? (
                      <iframe
                        title="Message"
                        sandbox="allow-popups allow-popups-to-escape-sandbox"
                        srcDoc={`<base target="_blank">${detail.HTML}`}
                        className="h-full w-full border-0 bg-white"
                      />
                    ) : (
                      <p className="p-6 text-sm text-gray-400">This message has no HTML version.</p>
                    )
                  ) : view === "text" ? (
                    <pre className="whitespace-pre-wrap break-words p-6 font-mono text-[13px] leading-relaxed text-gray-800">
                      {detail?.Text || "This message has no text version."}
                    </pre>
                  ) : view === "raw" ? (
                    <pre className="whitespace-pre-wrap break-all p-6 font-mono text-[12px] leading-relaxed text-gray-700">
                      {raw ?? "Loading…"}
                    </pre>
                  ) : headers ? (
                    <dl className="divide-y divide-gray-100 bg-white">
                      {Object.entries(headers).map(([name, values]) => (
                        <div key={name} className="grid grid-cols-[180px_minmax(0,1fr)] gap-4 px-6 py-2">
                          <dt className="truncate text-xs font-medium text-gray-500">{name}</dt>
                          <dd className="break-all font-mono text-xs text-gray-800">{values.join(", ")}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="p-6 text-sm text-gray-400">Loading…</p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        title={`Delete ${siteName}'s mail?`}
        body={`The ${list?.total ?? 0} message(s) caught from ${siteName} are deleted. Other sites' mail is kept.`}
        confirmLabel="Clear all"
        busy={busy === "clear"}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearAll()}
      />
    </div>
  );
}

function StatusPill({ status, loading }: { status: MailStatus | null; loading: boolean }) {
  if (status?.running) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-100">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        Mailpit · :{status.ui_port}
      </span>
    );
  }
  if (status && !status.installed) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500">
        <span className="h-2 w-2 rounded-full bg-gray-400" />
        Mailpit not installed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-100">
      <span className={clsx("h-2 w-2 rounded-full bg-amber-500", loading && "animate-pulse")} />
      {loading ? "Starting Mailpit…" : "Mailpit stopped"}
    </span>
  );
}

function BarButton({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-[13px] font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        danger ? "text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700" : "text-gray-700 hover:bg-gray-50",
      )}
    >
      {children}
    </button>
  );
}

function ListSkeleton() {
  return (
    <div aria-hidden className="space-y-px">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-2 border-b border-gray-100 px-4 py-3.5">
          <div className="flex justify-between">
            <span className="h-3 w-28 animate-pulse rounded bg-gray-100" />
            <span className="h-3 w-10 animate-pulse rounded bg-gray-100" />
          </div>
          <span className="block h-3 w-48 animate-pulse rounded bg-gray-100" />
          <span className="block h-2.5 w-36 animate-pulse rounded bg-gray-50" />
        </div>
      ))}
    </div>
  );
}

type Addr = { Name: string; Address: string } | null | undefined;

function sender(a: Addr) {
  return a?.Name || a?.Address || "(unknown sender)";
}

function address(a: Addr) {
  if (!a) return "—";
  return a.Name ? `${a.Name} <${a.Address}>` : a.Address;
}

function recipients(list: { Name: string; Address: string }[] | null | undefined) {
  return (list ?? []).map((a) => a.Address).join(", ");
}

function initial(a: Addr) {
  return (a?.Name || a?.Address || "?").trim().charAt(0) || "?";
}

/** A time for today's mail, a date for anything older. */
function when(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fullDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
