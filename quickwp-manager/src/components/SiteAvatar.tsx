import clsx from "clsx";

// WordPress admin colours, in pairs.
const GRADIENTS: [string, string][] = [
  ["#3858e9", "#9b51e0"],
  ["#00a32a", "#3858e9"],
  ["#d63638", "#dba617"],
  ["#2271b1", "#00a32a"],
  ["#9b51e0", "#d63638"],
  ["#dba617", "#00a32a"],
];

/**
 * A site's initial on a colour picked from its name -- the same colour every
 * time, so a site is recognisable at a glance, and in the collapsed sidebar
 * where there is no room for its name.
 */
export default function SiteAvatar({ name, className }: { name: string; className?: string }) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const [from, to] = GRADIENTS[hash % GRADIENTS.length];
  return (
    <span
      aria-hidden
      className={clsx(
        "inline-flex flex-shrink-0 items-center justify-center rounded-md font-semibold uppercase text-white",
        className,
      )}
      style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
    >
      {name.trim().charAt(0) || "?"}
    </span>
  );
}
