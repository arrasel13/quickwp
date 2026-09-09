import { useEffect, useState } from "react";
import {
  PlayIcon,
  StopIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  InformationCircleIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
  LockClosedIcon,
  LockOpenIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, Finding, PreflightCheck, VerifyReport } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

const LEVEL_STYLE: Record<string, { ring: string; icon: typeof CheckCircleIcon; tone: string }> = {
  ok: { ring: "border-green-200 bg-green-50", icon: CheckCircleIcon, tone: "text-green-700" },
  info: { ring: "border-blue-200 bg-blue-50", icon: InformationCircleIcon, tone: "text-blue-700" },
  warn: { ring: "border-amber-200 bg-amber-50", icon: ExclamationTriangleIcon, tone: "text-amber-700" },
  error: { ring: "border-red-200 bg-red-50", icon: ExclamationTriangleIcon, tone: "text-red-700" },
};

export default function GeneralTab() {
  const { data: status, error, loading, reload } = useAsync(() => api.stackStatus(), []);
  const { data: settings, reload: reloadSettings } = useAsync(() => api.settingsGet(), []);
  const { data: findings, reload: reloadDoctor } = useAsync(() => api.doctor(), []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightCheck[] | null>(null);
  const [verified, setVerified] = useState<VerifyReport | null>(null);
  // Taking a TLD from another tool is a decision, never a side effect.
  const [takeover, setTakeover] = useState(false);
  const [sitesDir, setSitesDir] = useState<string>("");

  // Keep the input in step with what the backend reports, without clobbering
  // an edit in progress.
  useEffect(() => {
    if (settings?.sites_dir && sitesDir === "") setSitesDir(settings.sites_dir);
  }, [settings?.sites_dir]);

  const refreshAll = async () => {
    await Promise.all([reload(), reloadSettings(), reloadDoctor()]);
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
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">General</h1>
          <p className="text-xs text-gray-600">The stack, and where everything lives.</p>
        </div>
        <button
          onClick={() => void refreshAll()}
          disabled={loading}
          className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <ArrowPathIcon className={clsx("h-4 w-4 mr-2", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {notice && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900 whitespace-pre-wrap">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">
          {error}
        </div>
      )}

      {/* stack */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span
              className={clsx(
                "h-2.5 w-2.5 rounded-full",
                running ? "bg-green-500" : "bg-gray-300",
              )}
            />
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                {running ? "Serving" : "Stopped"}
              </h2>
              <p className="text-xs text-gray-600 tabular-nums">
                {running
                  ? `Edge on 127.0.0.1:${status?.edge_port} · ${status?.site_count ?? 0} site(s) · .${status?.tld ?? "test"}`
                  : "Nothing is listening."}
              </p>
            </div>
          </div>
          <button
            onClick={() => void act(running ? api.stackStop : api.stackStart)}
            disabled={busy}
            className={clsx(
              "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md text-white disabled:opacity-50",
              running ? "bg-gray-700 hover:bg-gray-800" : "bg-blue-600 hover:bg-blue-700",
            )}
          >
            {running ? <StopIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
            {running ? "Stop all" : "Start all"}
          </button>
        </div>

        {(status?.pools?.length ?? 0) > 0 && (
          <div className="mt-4 border-t border-gray-100 pt-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">
              PHP pools
            </h3>
            <div className="flex flex-wrap gap-2">
              {status!.pools.map((p) => (
                <span
                  key={p.name}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                    p.running
                      ? "border-green-200 bg-green-50 text-green-800"
                      : "border-gray-200 bg-gray-50 text-gray-500",
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
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            {status?.https_ready ? (
              <LockClosedIcon className="h-5 w-5 text-green-600 mt-0.5" />
            ) : (
              <LockOpenIcon className="h-5 w-5 text-gray-400 mt-0.5" />
            )}
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                {status?.https_ready ? "HTTPS is on" : "HTTPS is off"}
              </h2>
              <p className="text-xs text-gray-600">
                {status?.https_ready ? (
                  <>
                    Sites open at{" "}
                    <code className="bg-gray-100 px-1 rounded">
                      https://name.{status?.tld}
                    </code>{" "}
                    with a real green lock.
                  </>
                ) : (
                  <>Turn this on and QuickWP asks for your password once.</>
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
                className="px-3 py-2 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
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
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md text-white bg-green-700 hover:bg-green-800 disabled:opacity-50"
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
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              Remove system changes
            </button>
          )}
        </div>

        {/* Four legs, each named. "Mostly on" is not a green lock, so the
            panel shows which one is missing rather than one vague state. */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
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
                "rounded-lg border px-3 py-2",
                leg.ok ? "border-green-200 bg-green-50" : "border-gray-200 bg-gray-50",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={clsx(
                    "h-1.5 w-1.5 rounded-full flex-shrink-0",
                    leg.ok ? "bg-green-500" : "bg-gray-300",
                  )}
                />
                <span
                  className={clsx(
                    "text-[11px] font-medium truncate",
                    leg.ok ? "text-green-900" : "text-gray-600",
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
            {preflight.some((c) => c.id === "resolver-free" && !c.ok) && (
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
                  <strong>Take this TLD over.</strong> QuickWP will replace the resolver file so
                  the domain points here instead. The other tool keeps its sites and settings —
                  only the name stops resolving to it, and its own uninstall still works. Leave
                  this unticked to pick a different TLD in Settings instead.
                </span>
              </label>
            )}
            {preflight.some((c) => c.blocking && !c.ok) && (
              <p className="mt-2 text-[11px] text-gray-600">
                QuickWP will not ask for your password for an install that cannot succeed.
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
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
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
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              Regenerate certificates
            </button>
          </div>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
          The certificate authority signs only your local sites, its private key never leaves
          this Mac, and trust lives in your <strong>login</strong> keychain rather than the
          System one — so removing it needs no admin rights. Leaves are issued for under 398
          days, because Safari rejects anything longer outright.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* doctor */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Diagnostics</h2>
          <p className="text-xs text-gray-600 mb-3">
            What is actually true right now — ports, and anything already claiming a TLD.
          </p>
          <div className="space-y-2">
            {(findings ?? []).map((f: Finding, i: number) => {
              const s = LEVEL_STYLE[f.level] ?? LEVEL_STYLE.info;
              const Icon = s.icon;
              return (
                <div key={i} className={clsx("rounded-lg border p-3", s.ring)}>
                  <div className="flex items-start gap-2">
                    <Icon className={clsx("h-4 w-4 flex-shrink-0 mt-0.5", s.tone)} />
                    <div className="min-w-0">
                      <h3 className="text-xs font-semibold text-gray-900">{f.title}</h3>
                      <p className="text-xs text-gray-700 leading-relaxed break-words">{f.detail}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* where things live */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Where things live</h2>
          <p className="text-xs text-gray-600 mb-3">
            One directory holds your sites, the downloaded runtimes and the logs.
          </p>
          <div className="border border-gray-200 rounded-lg px-3 py-2 mb-2">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Sites folder
              </span>
              <span className="block text-[11px] text-gray-600 mb-1.5">
                Where new sites are created. Existing sites stay where they are.
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={sitesDir}
                  onChange={(e) => setSitesDir(e.target.value)}
                  placeholder={settings?.default_sites_dir ?? "~/QuickWP/Sites"}
                  className="block w-full px-2 py-1.5 border border-gray-300 rounded-md text-[11px] font-mono focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                />
                <button
                  onClick={() => void act(() => api.settingsSet("sites_dir", sitesDir))}
                  disabled={busy || !sitesDir.trim()}
                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
                >
                  Save
                </button>
              </div>
              {settings?.sites_dir !== settings?.default_sites_dir && (
                <button
                  onClick={() => {
                    setSitesDir(settings?.default_sites_dir ?? "");
                    void act(() => api.settingsSet("sites_dir", ""));
                  }}
                  disabled={busy}
                  className="mt-1.5 text-[10px] text-blue-600 hover:text-blue-800 disabled:opacity-50"
                >
                  Reset to {settings?.default_sites_dir}
                </button>
              )}
            </label>
          </div>

          <dl className="space-y-2 text-xs">
            {[
              ["Data directory", settings?.root],
              ["Logs", settings?.logs_dir],
            ].map(([label, value]) => (
              <div key={label as string} className="border border-gray-200 rounded-lg px-3 py-2">
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  {label}
                </dt>
                <dd className="font-mono text-[11px] text-gray-800 break-all">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => {
                if (settings?.root) void api.siteOpen("").catch(() => {});
              }}
              className="hidden"
            />
            <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500">
              <FolderOpenIcon className="h-3.5 w-3.5" />
              Default TLD is <code className="bg-gray-100 px-1 rounded">.{settings?.tld ?? "test"}</code>,
              default PHP is {settings?.default_php ?? "—"}
            </span>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed max-w-3xl">
        {status?.https_ready
          ? `Requests arrive on 443, TLS terminates in the root edge, and the plaintext is forwarded to QuickWP's router on ${status?.edge_port}. The root process does nothing else.`
          : `Sites are reachable through the edge on port ${status?.edge_port ?? 18089} until HTTPS is on.`}
      </p>
    </div>
  );
}
