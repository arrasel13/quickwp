import { useState } from "react";
import {
  PlayIcon,
  StopIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  InformationCircleIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  LockOpenIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, Finding, PreflightCheck, VerifyReport } from "../../lib/api";
import { useAppData } from "../../lib/appData";

const LEVEL_STYLE: Record<string, { ring: string; icon: typeof CheckCircleIcon; tone: string }> = {
  ok: { ring: "border-green-200 bg-green-50", icon: CheckCircleIcon, tone: "text-green-700" },
  info: { ring: "border-blue-200 bg-blue-50", icon: InformationCircleIcon, tone: "text-blue-700" },
  warn: { ring: "border-amber-200 bg-amber-50", icon: ExclamationTriangleIcon, tone: "text-amber-700" },
  error: { ring: "border-red-200 bg-red-50", icon: ExclamationTriangleIcon, tone: "text-red-700" },
};

const BTN =
  "inline-flex items-center justify-center gap-2 h-9 px-4 text-[13px] font-medium rounded-sm border border-gray-300 text-gray-900 bg-white hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap";
const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 h-9 px-4 text-[13px] font-medium rounded-sm text-white bg-wp-blue hover:bg-wp-blue-dark disabled:opacity-50 whitespace-nowrap";
const BOX = "rounded border border-gray-200 bg-white";
const SECTION = "text-[13px] font-semibold text-gray-900";

export default function GeneralTab() {
  const { data: status, error, loading, reload } = useAppData("stack-status");
  const { data: findings, reload: reloadDoctor } = useAppData("doctor");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightCheck[] | null>(null);
  const [verified, setVerified] = useState<VerifyReport | null>(null);
  // Taking a TLD from another tool is a decision, never a side effect.
  const [takeover, setTakeover] = useState(false);

  const refreshAll = async () => {
    await Promise.all([reload(), reloadDoctor()]);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (typeof r === "string") setNotice(r);
      await refreshAll();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!hasBackend) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-5 max-w-xl">
          <h2 className="text-sm font-semibold text-amber-900 mb-1">No backend behind this window</h2>
          <p className="text-xs text-amber-800 leading-relaxed">
            Run <code className="bg-amber-100 px-1 rounded">npm run tauri dev</code> to start the
            desktop app with its Rust backend.
          </p>
        </div>
      </div>
    );
  }

  const running = status?.edge_running ?? false;

  return (
    <div>
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-8 pt-6 pb-5">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">General</h1>
          <p className="mt-0.5 text-[13px] text-gray-500">The stack, HTTPS and diagnostics.</p>
        </div>
        <button onClick={() => void refreshAll()} disabled={loading} className={BTN}>
          <ArrowPathIcon className={clsx("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      <div className="max-w-6xl px-8 py-6 space-y-8">
      {notice && (
        <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-[13px] text-blue-900 whitespace-pre-wrap">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-900">
          {error}
        </div>
      )}

      {/* stack */}
      <div className="rounded border border-gray-200 bg-gray-50 p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span
              className={clsx(
                "h-2.5 w-2.5 rounded-full",
                running ? "bg-green-500" : "bg-gray-300",
              )}
            />
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                {running ? "Serving" : "Stopped"}
              </h2>
              <p className="mt-0.5 text-[13px] text-gray-600 tabular-nums">
                {running
                  ? `Edge on 127.0.0.1:${status?.edge_port} · ${status?.site_count ?? 0} site(s) · .${status?.tld ?? "test"}`
                  : "Nothing is listening."}
              </p>
            </div>
          </div>
          <button
            onClick={() => void act(running ? api.stackStop : api.stackStart)}
            disabled={busy}
            className={running ? BTN : BTN_PRIMARY}
          >
            {running ? <StopIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
            {running ? "Stop all" : "Start all"}
          </button>
        </div>

        {(status?.pools?.length ?? 0) > 0 && (
          <div className="mt-5 border-t border-gray-200 pt-4">
            <h3 className="text-xs font-medium text-gray-500 mb-2">
              PHP pools
            </h3>
            <div className="flex flex-wrap gap-2">
              {status!.pools.map((p) => (
                <span
                  key={p.name}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs",
                    p.running
                      ? "border-green-200 bg-green-50 text-green-800"
                      : "border-gray-200 bg-white text-gray-600",
                  )}
                >
                  <span
                    className={clsx(
                      "h-1.5 w-1.5 rounded-full",
                      p.running ? "bg-green-500" : "bg-gray-300",
                    )}
                  />
                  <span className="font-mono">{p.name.replace("php-fpm-", "PHP ")}</span>
                  {p.port && <span className="tabular-nums text-[10px] opacity-70">:{p.port}</span>}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>


      {/* https --------------------------------------------------------- */}
      <div className={clsx(BOX, "p-6")}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            {status?.https_ready ? (
              <LockClosedIcon className="h-5 w-5 text-green-600 mt-0.5" />
            ) : (
              <LockOpenIcon className="h-5 w-5 text-gray-400 mt-0.5" />
            )}
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                {status?.https_ready ? "HTTPS is on" : "HTTPS is off"}
              </h2>
              <p className="mt-0.5 text-[13px] text-gray-600">
                {status?.https_ready ? (
                  <>
                    Sites open at{" "}
                    <code className="bg-gray-100 px-1 rounded">
                      https://name.{status?.tld}
                    </code>{" "}
                    with a real green lock.
                  </>
                ) : (
                  <>Turn this on and Nexora asks for your password once.</>
                )}
              </p>
            </div>
          </div>
          {!status?.https_ready ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    setNotice(null);
                    try {
                      setPreflight(await api.httpsPreflight(takeover));
                    } catch (e) {
                      setNotice(errorText(e));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
                disabled={busy}
                className={BTN}
              >
                Check first
              </button>
              <button
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    setNotice(null);
                    try {
                      const checks = await api.httpsPreflight(takeover);
                      setPreflight(checks);
                      if (checks.some((c) => c.blocking && !c.ok)) {
                        setNotice(
                          "Not asking for your password — the checks below have to pass first.",
                        );
                        return;
                      }
                      setNotice(await api.httpsEnable(takeover));
                      setVerified(await api.httpsVerify());
                      await refreshAll();
                    } catch (e) {
                      setNotice(errorText(e));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
                disabled={busy}
                className={BTN_PRIMARY}
              >
                <LockClosedIcon className="h-4 w-4" />
                Turn on HTTPS
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                if (
                  !confirm(
                    "Remove the DNS resolver, the edge service and the certificate trust?\n\n" +
                      "Your sites, their files and their databases are untouched.",
                  )
                )
                  return;
                void (async () => {
                  setBusy(true);
                  setNotice(null);
                  try {
                    setNotice(await api.removeSystemChanges());
                    setVerified(null);
                    setPreflight(null);
                    await refreshAll();
                  } catch (e) {
                    setNotice(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
              disabled={busy}
              className={BTN}
            >
              Remove system changes
            </button>
          )}
        </div>

        {/* Four legs, each named. "Mostly on" is not a green lock, so the
            panel shows which one is missing rather than one vague state. */}
        <div className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              label: `DNS for .${status?.tld ?? "test"}`,
              ok: status?.system?.resolver_installed ?? false,
              detail: status?.system?.resolver_path ?? "",
            },
            {
              label: "DNS server",
              ok: status?.dns_running ?? false,
              detail: "answers *.{tld} with 127.0.0.1",
            },
            {
              label: "Edge on 443",
              ok: status?.system?.daemon_running ?? false,
              detail: "root LaunchDaemon",
            },
            {
              label: "CA trusted",
              ok: status?.system?.ca_trusted ?? false,
              detail: "login keychain",
            },
          ].map((leg) => (
            <div
              key={leg.label}
              className={clsx(
                "flex h-11 items-center rounded-sm border px-4",
                leg.ok ? "border-green-200 bg-green-50" : "border-gray-200 bg-white",
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={clsx(
                    "h-2 w-2 rounded-full flex-shrink-0",
                    leg.ok ? "bg-green-500" : "bg-gray-300",
                  )}
                />
                <span
                  className={clsx(
                    "text-[13px] font-medium truncate",
                    leg.ok ? "text-green-900" : "text-gray-900",
                  )}
                >
                  {leg.label}
                </span>
              </div>
            </div>
          ))}
        </div>

        {preflight && (
          <div className="mt-4 border-t border-gray-100 pt-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">
              Checked before anything asks for your password
            </h3>
            <ul className="space-y-1.5">
              {preflight.map((c) => (
                <li key={c.id} className="flex items-start gap-2">
                  <span
                    className={clsx(
                      "mt-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0",
                      c.ok
                        ? "bg-green-100 text-green-800"
                        : c.blocking
                          ? "bg-red-100 text-red-800"
                          : "bg-amber-100 text-amber-900",
                    )}
                  >
                    {c.ok ? "OK" : c.blocking ? "STOP" : "WARN"}
                  </span>
                  <span className="min-w-0">
                    <span className="text-xs text-gray-900">{c.label}</span>
                    {!c.ok && c.fix && (
                      <span className="block text-[11px] text-gray-600 leading-relaxed">{c.fix}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {preflight.some((c) => (c.id === "resolver-free" || c.id === "no-rival") && !c.ok) && (
              <label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={takeover}
                  onChange={(e) => {
                    setTakeover(e.target.checked);
                    void api
                      .httpsPreflight(e.target.checked)
                      .then(setPreflight)
                      .catch((err) => setNotice(errorText(err)));
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                />
                <span className="text-[11px] text-amber-900 leading-relaxed">
                  <strong>Take over from the other tool.</strong> Nexora will replace the
                  resolver file so the domain points here instead and, if the other tool's server
                  holds ports 80 and 443, pause that server. Nothing of it is deleted — its sites
                  just stop loading, and Remove system changes gives it all back. Leave this
                  unticked to pick a different TLD in Settings instead.
                </span>
              </label>
            )}
            {preflight.some((c) => c.blocking && !c.ok) && (
              <p className="mt-2 text-[11px] text-gray-600">
                Nexora will not ask for your password for an install that cannot succeed.
              </p>
            )}
          </div>
        )}

        {verified && (
          <div className="mt-4 border-t border-gray-100 pt-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">
              Measured after the install — not just "files were written"
            </h3>
            <ul className="space-y-1.5">
              {verified.items.map((i) => (
                <li key={i.id} className="flex items-start gap-2">
                  <span
                    className={clsx(
                      "mt-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0",
                      i.ok ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800",
                    )}
                  >
                    {i.ok ? "OK" : "NO"}
                  </span>
                  <span className="min-w-0">
                    <span className="text-xs text-gray-900">{i.label}</span>
                    {i.detail && (
                      <span className="block text-[11px] text-gray-500 break-all">{i.detail}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {status?.system?.ca_exists && !status?.system?.ca_trusted && (
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => void act(api.httpsTrustCa)}
              disabled={busy}
              className={BTN}
            >
              Trust the certificate authority
            </button>
            <span className="text-[11px] text-gray-500">
              macOS asks for your login password, not an admin one.
            </span>
          </div>
        )}

        {status?.https_ready && (
          <div className="mt-3">
            <button
              onClick={() => void act(api.httpsRegenerateCerts)}
              disabled={busy}
              className={BTN}
            >
              Regenerate certificates
            </button>
          </div>
        )}

        <p className="mt-4 text-xs leading-relaxed text-gray-500">
          The certificate authority signs only your local sites, its private key never leaves
          this Mac, and trust lives in your <strong>login</strong> keychain rather than the
          System one — so removing it needs no admin rights. Leaves are issued for under 398
          days, because Safari rejects anything longer outright.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* doctor */}
        <section>
          <h2 className={SECTION}>Diagnostics</h2>
          <p className="mt-0.5 mb-3 text-[13px] text-gray-500">
            What is actually true right now — ports, and anything already claiming a TLD.
          </p>
          <div className="space-y-2">
            {(findings ?? []).map((f: Finding, i: number) => {
              const s = LEVEL_STYLE[f.level] ?? LEVEL_STYLE.info;
              const Icon = s.icon;
              return (
                <div key={i} className={clsx("rounded border p-4", s.ring)}>
                  <div className="flex items-start gap-2">
                    <Icon className={clsx("h-4 w-4 flex-shrink-0 mt-0.5", s.tone)} />
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-semibold text-gray-900">{f.title}</h3>
                      <p className="mt-0.5 text-xs text-gray-700 leading-relaxed break-words">{f.detail}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed max-w-3xl">
        {status?.https_ready
          ? `Requests arrive on 443, TLS terminates in the root edge, and the plaintext is forwarded to Nexora's router on ${status?.edge_port}. The root process does nothing else.`
          : `Sites are reachable through the edge on port ${status?.edge_port ?? 18089} until HTTPS is on.`}
      </p>
      </div>
    </div>
  );
}
