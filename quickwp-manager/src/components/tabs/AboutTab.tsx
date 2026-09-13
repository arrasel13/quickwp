import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { hasBackend } from "../../lib/api";
import Logo from "../Logo";

const FEATURES = [
  "WordPress site creation and management",
  "PHP version management",
  "Node.js environment control",
  "Laravel Herd integration",
  "Development tools integration",
];

const BUILT_WITH = [
  "Tauri (Rust + Web Technologies)",
  "React with TypeScript",
  "Tailwind CSS",
  "Headless UI",
  "Vite Build System",
];

const REQUIREMENTS: [string, string][] = [
  ["Operating System", "macOS 10.15+, Windows 10+, Linux"],
  ["Memory", "4GB RAM minimum, 8GB recommended"],
  ["Storage", "500MB free space"],
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-gray-200 bg-gray-50 px-6 py-5">
      <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function List({ items, dot }: { items: string[]; dot: string }) {
  return (
    <ul className="space-y-1.5 text-[13px] text-gray-600">
      {items.map((i) => (
        <li key={i} className="flex items-center gap-2.5">
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}`} />
          {i}
        </li>
      ))}
    </ul>
  );
}

/** Shown as a tab of App settings. */
export default function AboutTab() {
  // The version the binary was built as -- not a number typed into the page.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (hasBackend) void getVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="space-y-5">
      <section className="flex items-center gap-4 rounded-md border border-gray-200 bg-gray-50 px-6 py-5">
        <Logo className="h-14 w-14 rounded-xl" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-semibold text-gray-900">Nexora</h1>
          <p className="text-[13px] text-gray-600">The modern development workspace</p>
        </div>
        {version && (
          <span className="flex-shrink-0 rounded-full bg-wp-blue px-3 py-1 text-[11px] font-medium text-white tabular-nums">
            Version {version}
          </span>
        )}
      </section>

      <Section title="About This Application">
        <p className="text-[13px] leading-relaxed text-gray-600">
          Nexora is a powerful desktop application designed to streamline WordPress
          development workflows. Built with modern technologies, it provides an intuitive interface
          for managing WordPress sites, PHP versions, Node.js environments, and development tools
          all in one place.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-gray-900">Key Features</h3>
            <List items={FEATURES} dot="bg-wp-blue" />
          </div>
          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-gray-900">Built With</h3>
            <List items={BUILT_WITH} dot="bg-green-500" />
          </div>
        </div>
      </Section>

      <Section title="Developer">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-gray-900">
            <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <div>
            <div className="text-[13px] font-semibold text-gray-900">AR Rasel</div>
            <div className="text-xs text-gray-500">Lead Developer & Designer</div>
          </div>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-gray-600">
          Passionate full-stack developer with expertise in modern web technologies and desktop
          application development.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {["Frontend Specialist", "UI/UX Designer", "WordPress Expert"].map((r) => (
            <span key={r} className="rounded-sm border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700">
              {r}
            </span>
          ))}
        </div>
      </Section>

      <Section title="System Requirements">
        <dl className="divide-y divide-gray-200">
          {REQUIREMENTS.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-6 py-2.5 text-[13px]">
              <dt className="text-gray-900">{k}</dt>
              <dd className="text-right text-gray-600">{v}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <p className="text-center text-xs text-gray-500">
        © 2024 Nexora. All rights reserved. This software is licensed under the MIT License.
      </p>
    </div>
  );
}
