import { useEffect, useRef, useState } from "react";
import { ArrowPathIcon, ExclamationTriangleIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import clsx from "clsx";
import { api, errorText, HttpsConflict, SetupStatus } from "../lib/api";
import Logo from "./Logo";

/**
 * The first run: a welcome, what setup will do, one screen that prepares
 * everything a local WordPress site needs, and a way straight into making one.
 *
 * Everything is installed here, up front, so creating a site later never
 * stops to download PHP, MySQL or WP-CLI. Progress is measured, not animated:
 * the bar moves with real downloads, and a step that fails says so.
 *
 * There is no Nginx or Caddy step. Nexora serves sites with its own built-in
 * server, and the last step starts it.
 *
 * It runs in a small fixed window (the backend sizes it before the first
 * paint); "Create a Site" hands the full window back to the app.
 */

type Phase = "welcome" | "plan" | "preparing" | "ready";
/** `blocked`: waiting for the user to decide something. `skipped`: they chose to leave it. */
type Status = "pending" | "running" | "done" | "error" | "blocked" | "skipped";

interface StepState {
  status: Status;
  /** How far the running step's downloads have got, 0 to 1. Never goes back. */
  fraction?: number;
  error?: string;
  /** Why a `blocked` step is waiting. */
  conflict?: HttpsConflict;
}

interface Step {
  id: string;
  label: string;
  /** Shown under the progress bar while this step runs. */
  activity: string;
  /** Already in place: counted as done without doing anything. */
  already: boolean;
  /** Needs the user's password: the screen says so while it runs. */
  password?: boolean;
  run: () => Promise<unknown>;
}

type Choice = "takeover" | "skip";

/** A step the user chose to leave for later. Not a failure. */
class Skipped extends Error {}

/** "ports 80 and 443 and .test" -- what another tool is holding. */
function conflictSubject(c: HttpsConflict, tld: string) {
  const parts: string[] = [];
  if (c.ports.length > 0) {
    parts.push(c.ports.length > 1 ? `ports ${c.ports.join(" and ")}` : `port ${c.ports[0]}`);
  }
  if (c.resolver_taken) parts.push(`.${tld}`);
  return parts.join(" and ");
}

const primaryButton =
  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-wp-blue px-6 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-wp-blue-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue focus-visible:ring-offset-2";
const secondaryButton =
  "inline-flex h-11 w-full items-center justify-center rounded-lg border border-gray-300 bg-white px-6 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue focus-visible:ring-offset-2";

export default function Onboarding({
  status,
  onClose,
}: {
  status: SetupStatus;
  /** `startBuild`: go straight to the New site dialog. */
  onClose: (opts?: { startBuild?: boolean }) => void;
}) {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [states, setStates] = useState<Record<string, StepState>>({});
  const running = useRef(false);
  // Resolves the question a blocked step is waiting on.
  const decide = useRef<((c: Choice) => void) | null>(null);
  // The highest percentage shown so far this run: a bar that moves backwards
  // reads as something going wrong.
  const shownPercent = useRef(0);

  const installed = (id: string) => status.components.find((c) => c.id === id)?.installed ?? false;

  const steps: Step[] = [
    {
      id: "php",
      label: `PHP ${status.default_php}`,
      activity: `Installing PHP ${status.default_php}`,
      already: installed("php"),
      run: () => api.phpInstall(status.default_php),
    },
    {
      id: "mysql",
      label: "MySQL",
      activity: "Installing MySQL",
      already: installed("mysql"),
      run: () => api.dbInstall(status.default_mysql),
    },
    {
      id: "mailpit",
      label: "Mailpit",
      activity: "Installing Mailpit",
      already: installed("mailpit"),
      run: () => api.mailInstall(),
    },
    {
      id: "wp-cli",
      label: "WP-CLI",
      activity: "Installing WP-CLI",
      already: installed("wp-cli"),
      run: () => api.wpEnsureCli(),
    },
    {
      id: "adminer",
      label: "Adminer",
      activity: "Installing Adminer",
      already: installed("adminer"),
      run: () => api.setupInstallAdminer(),
    },
    {
      id: "ca",
      label: "Local CA",
      activity: "Trusting the local certificate authority",
      already: false,
      password: true,
      run: () => api.httpsTrustCa(),
    },
    {
      id: "dns",
      label: "DNS resolver",
      activity: "Setting up the DNS resolver",
      already: status.https_ready,
      password: true,
      run: async () => {
        // Another local environment may already own .test or ports 80/443.
        // Taking those over is never done silently: setup asks, and waits.
        const conflict = await api.httpsConflict();
        let takeover = false;
        if (conflict.ports.length > 0 || conflict.resolver_taken) {
          setStates((s) => ({ ...s, dns: { status: "blocked", conflict } }));
          const choice = await new Promise<Choice>((resolve) => {
            decide.current = resolve;
          });
          decide.current = null;
          if (choice === "skip") {
            throw new Skipped(
              `${conflict.tool ?? "Another app"} is using ${conflictSubject(conflict, status.tld)}.`,
            );
          }
          setStates((s) => ({ ...s, dns: { status: "running" } }));
          takeover = true;
        }
        await api.httpsEnable(takeover);
        // Measured, not assumed: the resolver, DNS and the edge all answer.
        const report = await api.httpsVerify();
        if (!report.all_ok) {
          throw new Error(
            report.items.find((i) => !i.ok)?.detail ?? "Some of the system changes did not take.",
          );
        }
      },
    },
    {
      id: "web",
      label: "Web server",
      activity: "Starting MySQL and the web server",
      already: false,
      run: () => api.stackStart(),
    },
  ];

  // Download progress for whichever step is running, as one fraction per step.
  // PHP is two downloads (fpm, then cli), so each fills half of its share --
  // one continuous stretch of the bar rather than two runs to 100%.
  useEffect(() => {
    const offs: Array<() => void> = [];
    const advance = (id: string, fraction: number) =>
      setStates((s) =>
        s[id]?.status === "running"
          ? {
              ...s,
              [id]: { ...s[id], fraction: Math.max(s[id].fraction ?? 0, Math.min(1, fraction)) },
            }
          : s,
      );
    void api
      .onDownloadProgress((p) => {
        if (p.total) advance(p.id.startsWith("mysql-") ? "mysql" : p.id, p.received / p.total);
      })
      .then((f) => offs.push(f as () => void));
    void api
      .onInstallProgress((p) => {
        if (!p.total) return;
        const part = p.component === "cli" ? 1 : 0;
        advance("php", (part + p.received / p.total) / 2);
      })
      .then((f) => offs.push(f as () => void));
    return () => offs.forEach((f) => f());
  }, []);

  /** Run the given steps in order. A failure is recorded and the rest carry on. */
  const runSteps = async (ids: string[]) => {
    if (running.current) return;
    running.current = true;
    setPhase("preparing");
    for (const step of steps.filter((s) => ids.includes(s.id))) {
      if (step.already) {
        setStates((s) => ({ ...s, [step.id]: { status: "done" } }));
        continue;
      }
      setStates((s) => ({ ...s, [step.id]: { status: "running", fraction: 0 } }));
      try {
        await step.run();
        setStates((s) => ({ ...s, [step.id]: { status: "done" } }));
      } catch (e) {
        setStates((s) => ({
          ...s,
          [step.id]:
            e instanceof Skipped
              ? { status: "skipped", error: e.message }
              : { status: "error", error: errorText(e) },
        }));
      }
    }
    running.current = false;
    setPhase("ready");
  };

  const start = () => {
    shownPercent.current = 0;
    setStates(Object.fromEntries(steps.map((s) => [s.id, { status: "pending" } as StepState])));
    void runSteps(steps.map((s) => s.id));
  };

  const failed = steps.filter((s) => states[s.id]?.status === "error");
  const skipped = steps.filter((s) => states[s.id]?.status === "skipped");
  const retry = () => {
    const ids = failed.map((s) => s.id);
    shownPercent.current = 0;
    setStates((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, { status: "pending" }])) }));
    void runSteps(ids);
  };

  const createSite = async () => {
    // Remembered, so setup is not shown again. A failure to remember is not a
    // reason to keep someone out of the app.
    await api.setupFinish(true).catch(() => {});
    await api.windowSetupMode(false).catch(() => {});
    onClose({ startBuild: true });
  };

  // One bar for the whole setup: finished steps plus the running step's share.
  const finished = steps.filter((s) =>
    ["done", "error", "skipped"].includes(states[s.id]?.status ?? ""),
  ).length;
  const current = steps.find((s) => states[s.id]?.status === "running");
  const blocked = steps.find((s) => states[s.id]?.status === "blocked");
  const raw = Math.round(((finished + (current ? states[current.id]?.fraction ?? 0 : 0)) / steps.length) * 100);
  const percent = Math.max(shownPercent.current, raw);
  shownPercent.current = percent;
  const activity = current
    ? `${current.activity}…`
    : blocked
      ? "Waiting for your choice…"
      : finished === 0
        ? "Getting started…"
        : "Finishing up…";
  const onDecide = (c: Choice) => decide.current?.(c);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white">
      {/* The window has no title bar on macOS; this strip drags it and clears
          the traffic lights. */}
      <div data-tauri-drag-region className="h-11 flex-shrink-0" />

      {phase === "welcome" && <Welcome onStart={() => setPhase("plan")} />}

      {phase === "plan" && <Plan tld={status.tld} onContinue={start} />}

      {phase === "preparing" && (
        <>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-10">
            <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">
              <Logo className="h-16 w-16" />
              <h1 className="mt-6 text-xl font-semibold tracking-tight text-gray-900">
                We're preparing your environment
              </h1>
              <p className="mt-1 text-sm text-gray-500">Please wait a few moments.</p>

              <div className="mt-8 w-full">
                <div
                  className="h-2 overflow-hidden rounded-full bg-gray-100"
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuetext={activity}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#1ED2FA] via-[#3452FF] to-[#A23CF6] transition-[width] duration-500 ease-out"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="mt-3 flex items-baseline justify-between gap-3 text-sm">
                  <span data-activity className="truncate text-left text-gray-700" aria-live="polite">
                    {activity}
                  </span>
                  <span className="flex-shrink-0 tabular-nums text-gray-500">{percent}%</span>
                </div>
              </div>

              {blocked && states[blocked.id]?.conflict && (
                <ConflictCard
                  conflict={states[blocked.id]!.conflict!}
                  tld={status.tld}
                  onDecide={onDecide}
                  className="mt-6 w-full text-left"
                />
              )}
            </div>
          </div>
          <footer className="flex-shrink-0 px-10 pb-8">
            {current?.password ? (
              <p className="flex items-center justify-center gap-2 text-xs leading-relaxed text-amber-800">
                <LockClosedIcon className="h-4 w-4 flex-shrink-0" />
                macOS may ask for your password to trust HTTPS and route local sites to this Mac.
              </p>
            ) : (
              <p className="text-center text-xs text-gray-500">
                Step {Math.min(finished + 1, steps.length)} of {steps.length}
              </p>
            )}
          </footer>
        </>
      )}

      {phase === "ready" && failed.length === 0 && (
        <>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-10 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-50">
              <CheckCircleIcon className="h-14 w-14 text-green-500" />
            </div>
            <h1 className="mt-6 text-2xl font-semibold tracking-tight text-gray-900">
              Your app is ready for local development
            </h1>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-gray-600">
              Everything Nexora needs is installed and running. Create your first WordPress site to
              get started.
            </p>
            {skipped.length > 0 && (
              <p className="mt-4 rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600">
                HTTPS for .{status.tld} was skipped, so sites won't open at https://name.{status.tld}{" "}
                until it's set up. Do that any time from Nexora Settings → General.
              </p>
            )}
          </div>
          <footer className="flex-shrink-0 px-10 pb-8">
            <button onClick={() => void createSite()} className={primaryButton}>
              Create a Site
            </button>
          </footer>
        </>
      )}

      {phase === "ready" && failed.length > 0 && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-10 py-6">
            <div className="flex flex-col items-center text-center">
              <ExclamationTriangleIcon className="h-12 w-12 text-amber-500" />
              <h1 className="mt-4 text-xl font-semibold tracking-tight text-gray-900">Almost there</h1>
              <p className="mt-1.5 text-sm leading-relaxed text-gray-600">
                {failed.length === 1 ? "One step" : `${failed.length} steps`} did not finish. Try
                again, or create a site now and finish the rest later from Nexora Settings.
              </p>
            </div>
            <ul className="mt-6 space-y-2">
              {failed.map((s) => (
                <li key={s.id} data-failed={s.id} className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                  <p className="text-sm font-medium text-red-900">{s.label}</p>
                  <p className="mt-0.5 break-words text-xs leading-relaxed text-red-700">
                    {states[s.id]?.error}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <footer className="grid flex-shrink-0 grid-cols-2 gap-3 px-10 pb-8">
            <button onClick={() => void createSite()} className={secondaryButton}>
              Create a Site anyway
            </button>
            <button onClick={retry} className={primaryButton}>
              <ArrowPathIcon className="h-4 w-4" />
              Try again
            </button>
          </footer>
        </>
      )}
    </div>
  );
}

function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-10 pb-8">
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <Logo className="h-20 w-20" />
        <h1 className="mt-8 text-[30px] font-semibold tracking-tight text-gray-900">
          Welcome to Nexora
        </h1>
        <p className="mt-2 text-[15px] text-gray-600">The modern development workspace</p>
        <p className="mt-6 max-w-sm text-sm leading-relaxed text-gray-500">
          Create, run and manage local WordPress sites on your Mac, with PHP, MySQL, email testing
          and trusted HTTPS set up for you.
        </p>
      </div>
      <button onClick={onStart} className={primaryButton}>
        Get Started
      </button>
    </div>
  );
}

function Plan({ tld, onContinue }: { tld: string; onContinue: () => void }) {
  const points = [
    ["PHP, MySQL, WP-CLI and Adminer", "Installed once, ready for every new site"],
    ["Mailpit", "Every email your sites send, caught locally"],
    ["Trusted HTTPS and a DNS resolver", `Sites open at https://name.${tld} in any browser`],
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col px-10 pb-8">
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <Logo className="h-16 w-16" />
        <h1 className="mt-6 text-[28px] font-semibold tracking-tight text-gray-900">Quick Setup</h1>
        <p className="mt-1 text-[15px] text-gray-600">Here's what Nexora sets up for you</p>

        <ul className="mt-8 w-full space-y-2 text-left">
          {points.map(([title, text]) => (
            <li key={title} className="flex items-start gap-3 rounded-lg bg-gray-50 px-4 py-3">
              <CheckCircleIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-wp-blue" />
              <div>
                <p className="text-[13px] font-medium text-gray-900">{title}</p>
                <p className="text-xs text-gray-500">{text}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-5 text-xs leading-relaxed text-gray-500">
          It takes a few minutes, and macOS will ask for your password along the way.
        </p>
      </div>
      <button onClick={onContinue} className={primaryButton}>
        Continue
      </button>
    </div>
  );
}

/** Another tool holds what HTTPS needs: say what, what each choice does, and ask. */
function ConflictCard({
  conflict,
  tld,
  onDecide,
  className,
}: {
  conflict: HttpsConflict;
  tld: string;
  onDecide: (c: Choice) => void;
  className?: string;
}) {
  const tool = conflict.tool;
  const holdsPorts = conflict.ports.length > 0;
  return (
    <div className={clsx("rounded-lg bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900", className)}>
      <p className="font-semibold">
        {tool ?? "Another app"} is using {conflictSubject(conflict, tld)}.
      </p>
      <p className="mt-1">
        {holdsPorts
          ? `Only one app can serve https://name.${tld} at a time. ${tool ? `${tool}'s` : "Its"} server runs as a system service, so quitting ${tool ?? "the app"} doesn't free the ports.`
          : `.${tld} addresses currently go to ${tool ?? "another tool"}, not Nexora.`}
      </p>
      <p className="mt-1">
        {!conflict.can_take_over
          ? "Nexora can't pause what's holding the ports. Stop it yourself, then set up HTTPS any time from Nexora Settings → General."
          : holdsPorts
            ? `"Use Nexora instead" pauses ${tool}'s server and points .${tld} here. ${tool}'s sites stop loading, but nothing of it is deleted — Remove system changes in Nexora Settings gives it all back.`
            : `"Use Nexora instead" points .${tld} here. ${tool ?? "The other tool"} keeps its sites and settings, and Remove system changes in Nexora Settings puts it back.`}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {conflict.can_take_over && (
          <button
            onClick={() => onDecide("takeover")}
            className="inline-flex h-8 items-center rounded-md bg-wp-blue px-3 text-xs font-semibold text-white hover:bg-wp-blue-dark"
          >
            Use Nexora instead
          </button>
        )}
        <button
          onClick={() => onDecide("skip")}
          className="inline-flex h-8 items-center rounded-md border border-amber-300 bg-white px-3 text-xs font-medium text-amber-900 hover:bg-amber-100"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
