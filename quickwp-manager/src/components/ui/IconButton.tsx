import clsx from "clsx";

/**
 * A small square button that is only an icon, named by a tooltip that shows
 * the moment it is pointed at or focused -- and by `label` for screen readers.
 */
export default function IconButton({
  label,
  onClick,
  disabled,
  active,
  tone = "default",
  tipAlign = "center",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Pressed-in look, for a toggle that is on. */
  active?: boolean;
  /** "danger" reddens on hover, for destructive actions. */
  tone?: "default" | "danger";
  /** "right" keeps the tooltip inside a container's right edge. */
  tipAlign?: "center" | "right";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "group/tip relative grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/30 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-gray-300",
        active
          ? "bg-gray-100 text-gray-900"
          : tone === "danger"
            ? "text-gray-500 hover:bg-red-50 hover:text-red-600"
            : "text-gray-500 hover:bg-gray-100 hover:text-gray-900",
      )}
    >
      {children}
      <span
        aria-hidden
        className={clsx(
          "pointer-events-none absolute top-full z-30 mt-1.5 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-sm transition-opacity duration-100 group-hover/tip:opacity-100 group-focus-visible/tip:opacity-100",
          tipAlign === "right" ? "right-0" : "left-1/2 -translate-x-1/2",
        )}
      >
        {label}
      </span>
    </button>
  );
}
