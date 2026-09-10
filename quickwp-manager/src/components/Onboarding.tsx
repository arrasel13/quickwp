import { useCallback, useEffect, useState } from "react";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, SetupComponent, SetupStatus } from "../lib/api";

/**
 * The first run: say what QuickWP is about to put on this machine, then put it
 * there.
 *
 * Disclosure before download, and specific rather than reassuring. A person
 * installing a local environment is handing it their ports, their DNS and their
 * keychain, and the honest version of that list is short enough to read.
 *
 * Nothing here claims an install QuickWP cannot perform. Node is absent because
 * this app deliberately does not ship one (see core/src/node.rs) and the Node
 * tab already reports what is on the machine; nginx is absent because QuickWP
 * serves sites itself.
 */

type Phase = "welcome" | "plan" | "installing" | "system" | "done";
type ItemState = {
  status: "pending" | "running" | "done" | "error";
  received?: number;
  total?: number | null;
  error?: string;
};

export default function Onboarding({
  status,
  onClose,
}: {
  status: SetupStatus;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const [fatal, setFatal] = useState<string | null>(null);
  const [systemBusy, setSystemBusy] = useState(false);
  const [systemNote, setSystemNote] = useState<string | null>(null);
  const [systemDone, setSystemDone] = useState(status.https_ready);

  // Only what is not here already.
  const toInstall = status.components.filter((c) => !c.installed);
  const totalMb = toInstall.reduce((n, c) => n + c.size_mb, 0);

  // Progress arrives on two channels: PHP has its own because a PHP install is
  // two downloads (fpm and cli) under one name.
  useEffect(() => {
    const offs: Array<() => void> = [];
    void api
      .onDownloadProgress((p) => {
        const id = p.id.startsWith("mysql-") ? "mysql" : p.id;
        setItems((s) =>
          s[id]?.status === "running"
            ? { ...s, [id]: { ...s[id], received: p.received, total: p.total } }
            : s,
        );
      })
      .then((f) => offs.push(f as () => void));
    void api
      .onInstallProgress((p) => {
        setItems((s) =>
          s.php?.status === "running"
            ? { ...s, php: { ...s.php, received: p.received, total: p.total } }
            : s,
        );
      })
      .then((f) => offs.push(f as () => void));
    return () => offs.forEach((f) => f());
  }, []);

  const install = useCallback(
    (c: SetupComponent) => {
      switch (c.id) {
        case "php":
          return api.phpInstall(status.default_php);
        case "mysql":
          return api.dbInstall(status.default_mysql);
        case "wp-cli":
          return api.wpEnsureCli();
        case "mailpit":
          return api.mailInstall();
        case "adminer":
          return api.setupInstallAdminer();
        default:
          return Promise.resolve("");
      }
    },
    [status.default_php, status.default_mysql],
  );

  const runAll = async () => {
    setPhase("installing");
    setFatal(null);
    setItems(
      Object.fromEntries(toInstall.map((c) => [c.id, { status: "pending" } as ItemState])),
    );
    for (const c of toInstall) {
      setItems((s) => ({ ...s, [c.id]: { status: "running" } }));
      try {
        await install(c);
        setItems((s) => ({ ...s, [c.id]: { status: "done" } }));
      } catch (e) {
        const message = errorText(e);
        setItems((s) => ({ ...s, [c.id]: { status: "error", error: message } }));
        // Keep going. A failed Mailpit download is not a reason to leave
        // someone without PHP, and the summary says what did not land.
      }
    }
    setPhase("system");
  };

  const enableHttps = async () => {
    setSystemBusy(true);
    setSystemNote(null);
    try {
      await api.httpsEnable(false);
      const report = await api.httpsVerify();
      setSystemDone(report.all_ok);
      if (!report.all_ok) {
        setSystemNote(
          report.items.find((i) => !i.ok)?.detail ??
            "Some of the system changes did not take. General → HTTPS has the detail.",
        );
      }
    } catch (e) {
      setSystemNote(errorText(e));
    } finally {
      setSystemBusy(false);
    }
  };

  const finish = async (remember: boolean) => {
    try {
      if (remember) await api.setupFinish(true);
    } catch (e) {
      setFatal(errorText(e));
      return;
    }
    onClose();
  };

  return (
    <div className="flex h-screen bg-white">
      {/* The brand rail. Fixed width so the content column never reflows
          between steps. */}
      <aside className="hidden w-[300px] flex-shrink-0 flex-col justify-between bg-blue-600 p-8 text-white sm:flex">
        <div className="inline-flex items-center gap-2 self-start rounded-full border border-white/40 px-4 py-2">
          <span className="text-base font-semibold tracking-tight">QuickWP</span>
        </div>
        <ol className="space-y-3 text-[28px] font-semibold leading-tight tracking-tight">
          {(
            [
              ["plan", "Review"],
              ["installing", "Install"],
              ["system", "Trust"],
              ["done", "Build"],
            ] as Array<[Phase, string]>
          ).map(([p, label]) => (
            <li
              key={p}
              className={clsx(
                phase === p ? "text-white" : "text-white/30",
                "transition-colors",
              )}
            >
              {label}
            </li>
          ))}
        </ol>
        <p className="text-xs leading-relaxed text-white/60">
          Everything QuickWP downloads is checked against a checksum built into
          this app.
        </p>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-8 py-10">
            {phase === "welcome" && (
              <Welcome
                totalMb={totalMb}
                count={toInstall.length}
                onNext={() => setPhase("plan")}
              />
            )}

            {phase === "plan" && (
              <Plan status={status} toInstall={toInstall} totalMb={totalMb} />
            )}

            {(phase === "installing" || phase === "done") && (
              <Installing
                toInstall={toInstall}
                items={items}
                finished={phase === "done"}
                systemDone={systemDone}
              />
            )}

            {phase === "system" && (
              <SystemStep
                tld={status.tld}
                busy={systemBusy}
                done={systemDone}
                note={systemNote}
                onEnable={() => void enableHttps()}
              />
            )}

            {fatal && (
              <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">
                {fatal}
              </p>
            )}
          </div>
        </div>

        {/* The action bar stays put, so the primary button never moves. */}
        <div className="flex flex-shrink-0 items-center justify-between gap-4 border-t border-gray-200 px-8 py-4">
          {/* Not offered mid-install: the downloads would carry on in the
              background, so "skip" would be a word for something else. */}
          <button
            onClick={() => void finish(phase === "done")}
            disabled={phase === "installing"}
            className="text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-800 hover:underline disabled:cursor-default disabled:text-gray-300 disabled:no-underline"
          >
            {phase === "done" ? "Close" : "Skip setup for now"}
          </button>

          <div className="flex items-center gap-2">
            {phase === "welcome" && (
              <Primary onClick={() => setPhase("plan")}>Get started</Primary>
            )}
            {phase === "plan" && (
              <>
                <Secondary onClick={() => setPhase("welcome")}>Back</Secondary>
                <Primary onClick={() => void runAll()}>
                  {toInstall.length === 0
                    ? "Continue"
                    : `Install ${toInstall.length} component${toInstall.length === 1 ? "" : "s"}`}
                </Primary>
              </>
            )}
            {phase === "installing" && (
              <span className="text-xs text-gray-500">Working…</span>
            )}
            {phase === "system" && (
              <>
                <Secondary onClick={() => setPhase("done")}>
                  {systemDone ? "Continue" : "Not now"}
                </Secondary>
                {!systemDone && (
                  <Primary onClick={() => void enableHttps()} disabled={systemBusy}>
                    {systemBusy ? "Waiting for your password…" : "Turn on HTTPS"}
                  </Primary>
                )}
                {systemDone && <Primary onClick={() => setPhase("done")}>Finish</Primary>}
              </>
            )}
            {phase === "done" && (
              <Primary onClick={() => void finish(true)}>Start using QuickWP</Primary>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Welcome({
  totalMb,
  count,
  onNext,
}: {
  totalMb: number;
  count: number;
  onNext: () => void;
}) {
  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight text-gray-900">
        Welcome to QuickWP
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-gray-600">
        QuickWP runs WordPress sites on your Mac at real{" "}
        <span className="font-medium text-gray-900">https://name.test</span>{" "}
        addresses. It brings its own PHP, its own MySQL and its own web server,
        so nothing here depends on what you already have installed — and nothing
        it installs is shared with the rest of your machine.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-gray-600">
        The next screen lists every component it wants to download
        {count > 0 ? ` — ${count} of them, about ${totalMb} MB` : ""} and every
        change it makes to your system, before any of it happens.
      </p>
      <button
        onClick={onNext}
        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
      >
        See what gets installed
      </button>
    </div>
  );
}

function Plan({
  status,
  toInstall,
  totalMb,
}: {
  status: SetupStatus;
  toInstall: SetupComponent[];
  totalMb: number;
}) {
  const already = status.components.filter((c) => c.installed);
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-gray-900">
        What QuickWP installs
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">
        Everything lands in{" "}
        <code className="rounded bg-gray-100 px-1 font-mono text-xs">
          ~/Library/Application Support/com.quickwp.manager
        </code>
        . Nothing is written to <code className="font-mono text-xs">/usr/local</code>{" "}
        or your PATH, and removing that one folder removes all of it.
      </p>

      <Section
        title={`Downloads${toInstall.length ? ` — about ${totalMb} MB` : ""}`}
      >
        {toInstall.map((c) => (
          <ComponentRow key={c.id} c={c} />
        ))}
        {toInstall.length === 0 && (
          <p className="px-4 py-3 text-xs text-gray-500">
            Everything is already here. Nothing to download.
          </p>
        )}
      </Section>

      {already.length > 0 && (
        <Section title="Already installed">
          {already.map((c) => (
            <ComponentRow key={c.id} c={c} />
          ))}
        </Section>
      )}

      <Section title="Changes to your Mac">
        <SystemRow
          label={`/etc/resolver/${status.tld}`}
          detail={`A four-line file telling macOS to ask QuickWP about .${status.tld} names, and nothing else. Your normal DNS is untouched.`}
        />
        <SystemRow
          label="A background service on ports 80 and 443"
          detail="Runs as root, because those ports require it. It reads only your certificates directory and forwards to QuickWP."
        />
        <SystemRow
          label="A certificate authority in your login keychain"
          detail="Created on this machine and never leaves it. It is what makes your sites open on a real lock instead of a browser warning."
        />
        <p className="flex items-start gap-2 px-4 py-3 text-xs leading-relaxed text-amber-800">
          <LockClosedIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            These three ask for your password, once, on the step after the
            downloads. You can skip them and turn HTTPS on later from App settings › General —
            sites still work, on{" "}
            <code className="font-mono">http://</code> with a port number.
          </span>
        </p>
      </Section>
    </div>
  );
}

function Installing({
  toInstall,
  items,
  finished,
  systemDone,
}: {
  toInstall: SetupComponent[];
  items: Record<string, ItemState>;
  finished: boolean;
  systemDone: boolean;
}) {
  const failed = toInstall.filter((c) => items[c.id]?.status === "error");
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-gray-900">
        {finished ? "QuickWP is ready" : "Setting up"}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">
        {finished
          ? "Create a site from the Sites tab and it will be serving in a few seconds."
          : "Each download is verified against a checksum built into this app before it is unpacked."}
      </p>

      <Section title="Components">
        {toInstall.length === 0 && (
          <p className="px-4 py-3 text-xs text-gray-500">
            Nothing needed downloading.
          </p>
        )}
        {toInstall.map((c) => {
          const st = items[c.id] ?? { status: "pending" as const };
          const pct =
            st.total && st.received !== undefined
              ? Math.min(100, Math.round((st.received / st.total) * 100))
              : null;
          return (
            <div key={c.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-xs font-medium text-gray-900">
                  <StatusDot status={st.status} />
                  {c.name}
                  <span className="font-mono text-[11px] font-normal text-gray-400">
                    {c.version}
                  </span>
                </span>
                <span className="text-[11px] text-gray-500">
                  {st.status === "done"
                    ? "installed"
                    : st.status === "error"
                      ? "failed"
                      : st.status === "running"
                        ? pct !== null
                          ? `${pct}%`
                          : "downloading…"
                        : "waiting"}
                </span>
              </div>
              {st.status === "running" && (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={clsx(
                      "h-full bg-blue-600 transition-[width] duration-200",
                      pct === null && "w-1/3 animate-pulse",
                    )}
                    style={pct !== null ? { width: `${pct}%` } : undefined}
                  />
                </div>
              )}
              {st.status === "error" && (
                <p className="mt-1.5 break-words text-[11px] leading-relaxed text-red-700">
                  {st.error}
                </p>
              )}
            </div>
          );
        })}
      </Section>

      {finished && (
        <>
          {failed.length > 0 && (
            <p className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
              <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                {failed.map((c) => c.name).join(", ")} did not install. QuickWP
                will try again the first time something needs{" "}
                {failed.length === 1 ? "it" : "them"}.
              </span>
            </p>
          )}
          {!systemDone && (
            <p className="mt-3 text-xs leading-relaxed text-gray-500">
              HTTPS is still off. Sites will work on{" "}
              <code className="font-mono">http://</code> with a port number
              until you turn it on in App settings › General.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SystemStep({
  tld,
  busy,
  done,
  note,
  onEnable,
}: {
  tld: string;
  busy: boolean;
  done: boolean;
  note: string | null;
  onEnable: () => void;
}) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-gray-900">
        {done ? "HTTPS is on" : "One password prompt"}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">
        {done
          ? `Your .${tld} names resolve here and open on a real lock.`
          : `This is the only part of setup that needs admin rights, and it is the part that makes https://name.${tld} work with no port number and no browser warning.`}
      </p>

      {!done && (
        <Section title="What it does, exactly">
          <SystemRow
            label={`Writes /etc/resolver/${tld}`}
            detail={`macOS asks QuickWP about .${tld} names. Every other domain resolves exactly as it does now.`}
          />
          <SystemRow
            label="Installs a small service on ports 80 and 443"
            detail="It terminates TLS and forwards to QuickWP. If another local environment holds those ports, QuickWP tells you which one instead of fighting it."
          />
          <SystemRow
            label="Trusts a certificate authority it generates here"
            detail="Added to your login keychain, not the system one. It can only vouch for the certificates QuickWP issues to your own sites."
          />
        </Section>
      )}

      {done && (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-xs text-green-900">
          <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
          Resolver, edge service and certificate authority all verified.
        </p>
      )}

      {note && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
          {note}
        </p>
      )}

      {!done && (
        <button
          onClick={onEnable}
          disabled={busy}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? (
            <ArrowPathIcon className="h-4 w-4 animate-spin" />
          ) : (
            <LockClosedIcon className="h-4 w-4" />
          )}
          {busy ? "Waiting for your password…" : "Turn on HTTPS"}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------- bits

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {title}
      </h2>
      <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white shadow-sm">
        {children}
      </div>
    </section>
  );
}

function ComponentRow({ c }: { c: SetupComponent }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-xs font-semibold text-gray-900">
          {c.name}
          <span className="font-mono text-[11px] font-normal text-gray-400">
            {c.version}
          </span>
          {c.installed && (
            <CheckCircleIcon className="h-3.5 w-3.5 text-green-600" />
          )}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
          {c.detail}
        </p>
      </div>
      <span className="flex-shrink-0 whitespace-nowrap text-[11px] text-gray-400">
        {c.size_mb > 0 ? `~${c.size_mb} MB` : ""}
      </span>
    </div>
  );
}

function SystemRow({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="px-4 py-3">
      <p className="font-mono text-[11px] font-semibold text-gray-900">{label}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">{detail}</p>
    </div>
  );
}

function StatusDot({ status }: { status: ItemState["status"] }) {
  if (status === "done")
    return <CheckCircleIcon className="h-3.5 w-3.5 text-green-600" />;
  if (status === "error")
    return <ExclamationTriangleIcon className="h-3.5 w-3.5 text-red-600" />;
  if (status === "running")
    return <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-blue-600" />;
  return <span className="h-2 w-2 rounded-full bg-gray-300" />;
}

function Primary({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function Secondary({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
    >
      {children}
    </button>
  );
}
