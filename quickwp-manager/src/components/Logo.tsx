import clsx from "clsx";
import markUrl from "../assets/nexora-mark.svg";

/** The Nexora mark on its tile -- the same drawing as the app icon. */
export default function Logo({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        "flex flex-shrink-0 items-center justify-center rounded-2xl bg-[#0B0D1C]",
        className,
      )}
    >
      <img src={markUrl} alt="Nexora" className="h-[64%] w-auto" draggable={false} />
    </div>
  );
}
