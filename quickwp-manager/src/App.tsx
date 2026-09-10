import { useState } from "react";
import Layout from "./components/Layout";
import Onboarding from "./components/Onboarding";
import { api, hasBackend } from "./lib/api";
import { useAsync } from "./lib/useAsync";
import "./App.css";

function App() {
  // The first run is decided by the backend, not by anything in this window:
  // it is a row in the settings table, so reinstalling the app over an existing
  // setup does not greet someone who has been using QuickWP for months.
  const { data: setup, loading } = useAsync(
    () => (hasBackend ? api.setupStatus() : Promise.resolve(null)),
    [],
  );
  const [dismissed, setDismissed] = useState(false);

  if (loading) return null;

  // Rendered instead of the app, not over it. An overlay leaves every tab and
  // button behind it in the tab order and reachable by a screen reader, and
  // mounting the app only afterwards means its PHP and MySQL tabs open already
  // knowing about whatever setup just installed.
  if (setup && !setup.done && !dismissed) {
    return <Onboarding status={setup} onClose={() => setDismissed(true)} />;
  }
  return <Layout />;
}

export default App;
