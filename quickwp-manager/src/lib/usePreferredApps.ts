import { useAppData } from "./appData";

const appName = (bundle: string | null | undefined) =>
  bundle ? bundle.split("/").pop()!.replace(/\.app$/, "") : null;

/**
 * The names of the editor and terminal chosen in App settings, so buttons can
 * say "Cursor" rather than a generic "Editor". Follows changes made while the
 * screen is open: saving settings refreshes them for every screen.
 */
export function usePreferredApps() {
  const { data: s } = useAppData("settings");
  return { editor: appName(s?.editor), terminal: appName(s?.terminal) };
}
