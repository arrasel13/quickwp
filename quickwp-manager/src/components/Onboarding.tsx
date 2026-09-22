import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExclamationTriangleIcon, LockClosedIcon } from "@heroicons/react/24/outline";
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
 * It looks and reads like a macOS installer -- the steps down the left, one
 * page at a time in a bordered panel, Go Back and Continue at the bottom --
 * in a small fixed window the backend sizes before the first paint. "Create
 * a Site" hands the full window back to the app.
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
      id: "cloudflared",
      label: "Cloudflared",
      activity: "Installing Cloudflared",
      already: installed("cloudflared"),
      run: () => api.tunnelInstall(),
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
    // Marked as started, so a setup the app quits during opens again to
    // finish rather than being taken as done. Best effort.
    void api.setupFinish(false).catch(() => {});
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

  const page: Page =
    phase === "welcome" ? "intro" : phase === "plan" ? "setup" : phase === "preparing" ? "install" : "summary";

  return (
    <div className="flex h-screen select-none flex-col overflow-hidden bg-[#f5f5f7] text-gray-900">
      {/* The title bar: the window has none of its own on macOS, so this strip
          carries the name, drags the window and clears the traffic lights. */}
      <header data-tauri-drag-region className="relative flex h-11 flex-shrink-0 items-center justify-center">
        <span className="pointer-events-none flex items-center gap-2 text-[13px] font-semibold text-gray-500">
          <Logo className="h-4 w-4" />
          Install Nexora
        </span>
        <LockClosedIcon className="pointer-events-none absolute right-4 h-4 w-4 text-gray-400" />
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar page={page} />

        <main className="flex min-w-0 flex-1 flex-col pb-4 pr-5">
          <h1 className="flex-shrink-0 pb-2.5 text-[15px] font-medium text-gray-900">
            {page === "intro" && "Welcome to the Nexora Installer"}
            {page === "setup" && "Here's what Nexora sets up on this Mac"}
            {page === "install" && "Installing Nexora…"}
            {page === "summary" &&
              (failed.length === 0
                ? "The installation was completed successfully."
                : "The installation did not finish.")}
          </h1>

          <section className="min-h-0 flex-1 overflow-y-auto rounded-md border border-gray-300 bg-white px-5 py-4">
            {page === "intro" && <Intro />}
            {page === "setup" && <SetupPlan status={status} steps={steps} />}
            {page === "install" && (
              <InstallProgress
                steps={steps}
                states={states}
                percent={percent}
                activity={activity}
                password={Boolean(current?.password)}
                conflict={
                  blocked && states[blocked.id]?.conflict ? (
                    <ConflictCard
                      conflict={states[blocked.id]!.conflict!}
                      tld={status.tld}
                      onDecide={onDecide}
                      className="mt-3"
                    />
                  ) : null
                }
              />
            )}
            {page === "summary" && (
              <Summary tld={status.tld} failed={failed} skipped={skipped.length > 0} states={states} />
            )}
          </section>

          <footer className="flex flex-shrink-0 items-center justify-end gap-3 pt-4">
            {page === "intro" && (
              <>
                <MacButton disabled>Go Back</MacButton>
                <MacButton primary onClick={() => setPhase("plan")}>
                  Continue
                </MacButton>
              </>
            )}
            {page === "setup" && (
              <>
                <MacButton onClick={() => setPhase("welcome")}>Go Back</MacButton>
                <MacButton primary onClick={start}>
                  Install
                </MacButton>
              </>
            )}
            {page === "install" && (
              <>
                <MacButton disabled>Go Back</MacButton>
                <MacButton primary disabled>
                  Continue
                </MacButton>
              </>
            )}
            {page === "summary" && failed.length === 0 && (
              <>
                <MacButton disabled>Go Back</MacButton>
                <MacButton primary onClick={() => void createSite()}>
                  Create a Site
                </MacButton>
              </>
            )}
            {page === "summary" && failed.length > 0 && (
              <>
                <MacButton onClick={() => void createSite()}>Create a Site Anyway</MacButton>
                <MacButton primary onClick={retry}>
                  Try Again
                </MacButton>
              </>
            )}
          </footer>
        </main>
      </div>
    </div>
  );
}

type Page = "intro" | "setup" | "install" | "summary";

const PAGES: Array<[Page, string]> = [
  ["intro", "Introduction"],
  ["setup", "Setup"],
  ["install", "Installation"],
  ["summary", "Summary"],
];

/** The installer's steps down the left, the current one marked, and the
 *  Nexora mark where an installer shows its package artwork. */
function Sidebar({ page }: { page: Page }) {
  return (
    <nav className="relative flex w-[190px] flex-shrink-0 flex-col pl-7 pt-9" aria-label="Installer steps">
      <ol className="space-y-3.5">
        {PAGES.map(([id, label]) => {
          const active = id === page;
          return (
            <li
              key={id}
              aria-current={active ? "step" : undefined}
              className={clsx(
                "flex items-center gap-3 text-[14px]",
                active ? "font-semibold text-gray-900" : "text-gray-500",
              )}
            >
              <span
                className={clsx("h-2.5 w-2.5 flex-shrink-0 rounded-full", active ? "bg-[#0a7aff]" : "bg-gray-300")}
              />
              {label}
            </li>
          );
        })}
      </ol>
      <div className="pointer-events-none absolute bottom-6 left-7">
        <Logo className="h-[88px] w-[88px] drop-shadow-md" />
      </div>
    </nav>
  );
}

function MacButton({
  children,
  primary,
  disabled,
  onClick,
}: {
  children: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "inline-flex h-8 min-w-[96px] items-center justify-center rounded-md px-4 text-[13px] font-medium shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0a7aff]/50",
        primary
          ? "bg-[#0a7aff] text-white hover:bg-[#0068e0] disabled:bg-gray-200 disabled:text-gray-400 disabled:shadow-none"
          : "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:shadow-none",
      )}
    >
      {children}
    </button>
  );
}

function Intro() {
  return (
    <div className="text-[13px] leading-relaxed text-gray-700">
      <p className="text-[22px] font-semibold tracking-tight text-gray-900">Nexora</p>
      <p className="text-gray-500">The modern development workspace</p>
      <p className="mt-4">
        Create, run and manage local WordPress sites on your Mac, with PHP, MySQL, email testing and
        trusted HTTPS set up for you.
      </p>
      <p className="mt-3">
        This installer downloads what your sites need, sets up secure local addresses and starts
        Nexora's web server. It takes a few minutes, and macOS will ask for your password along the
        way.
      </p>
      <p className="mt-3 text-gray-500">Click Continue to see what will be installed.</p>
    </div>
  );
}

function SetupPlan({ status, steps }: { status: SetupStatus; steps: Step[] }) {
  const size = status.components.filter((c) => !c.installed).reduce((n, c) => n + c.size_mb, 0);
  const version = (id: string) => status.components.find((c) => c.id === id)?.version;
  return (
    <div className="text-[13px]">
      <ul className="divide-y divide-gray-100">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2.5 py-[3px]">
            <CheckCircleIcon
              className={clsx("h-4 w-4 flex-shrink-0", step.already ? "text-green-500" : "text-[#0a7aff]")}
            />
            <span className="text-gray-900">{step.label.replace(/ \d.*$/, "")}</span>
            {version(step.id) && <span className="font-mono text-[11px] text-gray-400">{version(step.id)}</span>}
            {step.already && <span className="ml-auto text-[11px] text-green-600">Already installed</span>}
            {!step.already && step.password && (
              <span className="ml-auto text-[11px] text-gray-400">Needs your password</span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-500">
        {size > 0 ? `About ${size} MB to download. ` : ""}Sites will open at https://name.{status.tld}.
      </p>
    </div>
  );
}

function InstallProgress({
  steps,
  states,
  percent,
  activity,
  password,
  conflict,
}: {
  steps: Step[];
  states: Record<string, StepState>;
  percent: number;
  activity: string;
  password: boolean;
  conflict: ReactNode;
}) {
  return (
    <div className="text-[13px]">
      <div className="flex items-baseline justify-between gap-3">
        <span data-activity className="truncate text-gray-800" aria-live="polite">
          {activity}
        </span>
        <span className="flex-shrink-0 tabular-nums text-gray-500">{percent}%</span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={activity}
      >
        <div
          className="h-full rounded-full bg-[#0a7aff] transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      {password && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700">
          <LockClosedIcon className="h-3.5 w-3.5 flex-shrink-0" />
          macOS may ask for your password to trust HTTPS and route local sites to this Mac.
        </p>
      )}
      {conflict}
      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {steps.map((step) => {
          const st = states[step.id]?.status ?? "pending";
          return (
            <li key={step.id} className="flex items-center gap-2 text-xs">
              <StatusDot status={st} />
              <span className={clsx(st === "running" ? "font-medium text-gray-900" : "text-gray-600")}>
                {step.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatusDot({ status }: { status: Status }) {
  if (status === "done") return <CheckCircleIcon className="h-4 w-4 flex-shrink-0 text-green-500" />;
  if (status === "error") return <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 text-red-500" />;
  if (status === "running")
    return (
      <span className="mx-px h-3.5 w-3.5 flex-shrink-0 animate-spin rounded-full border-2 border-gray-200 border-t-[#0a7aff]" />
    );
  if (status === "blocked" || status === "skipped")
    return <span className="mx-px h-3.5 w-3.5 flex-shrink-0 rounded-full border-2 border-amber-400" />;
  return <span className="mx-px h-3.5 w-3.5 flex-shrink-0 rounded-full border-2 border-gray-200" />;
}

function Summary({
  tld,
  failed,
  skipped,
  states,
}: {
  tld: string;
  failed: Step[];
  skipped: boolean;
  states: Record<string, StepState>;
}) {
  if (failed.length > 0) {
    return (
      <div className="text-[13px] leading-relaxed text-gray-700">
        <p>
          {failed.length === 1 ? "One step" : `${failed.length} steps`} did not finish. Try again, or
          create a site now and finish the rest later from Nexora Settings.
        </p>
        <ul className="mt-3 space-y-2">
          {failed.map((s) => (
            <li key={s.id} data-failed={s.id} className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
              <p className="text-[13px] font-medium text-red-900">{s.label}</p>
              <p className="mt-0.5 break-words text-xs text-red-700">{states[s.id]?.error}</p>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <CheckCircleIcon className="h-14 w-14 text-green-500" />
      <p className="mt-3 text-[20px] font-semibold tracking-tight text-gray-900">Nexora is ready</p>
      <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-gray-600">
        Everything Nexora needs is installed and running. Create your first WordPress site to get
        started.
      </p>
      {skipped && (
        <p className="mt-3 max-w-sm rounded-md bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600">
          HTTPS for .{tld} was skipped, so sites won't open at https://name.{tld} until it's set up. Do
          that any time from Nexora Settings → General.
        </p>
      )}
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
            className="inline-flex h-7 items-center rounded-md bg-[#0a7aff] px-3 text-xs font-medium text-white hover:bg-[#0068e0]"
          >
            Use Nexora instead
          </button>
        )}
        <button
          onClick={() => onDecide("skip")}
          className="inline-flex h-7 items-center rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-800 hover:bg-gray-50"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
