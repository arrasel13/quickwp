import { useState } from "react";
import Layout from "./components/Layout";
import Onboarding from "./components/Onboarding";
import { api, hasBackend } from "./lib/api";
import { useAsync } from "./lib/useAsync";
import "./App.css";

function App() {
  // The first run is decided by the backend, not by anything in this window:
  // it is a row in the settings table, so reinstalling the app over an existing
  // setup does not greet someone who has been using Nexora for months.
  const { data: setup, loading } = useAsync(
    () => (hasBackend ? api.setupStatus() : Promise.resolve(null)),
    [],
    // Shared with the New site dialog, which reads the same components.
    hasBackend ? "setup-status" : undefined,
  );
  const [dismissed, setDismissed] = useState(false);
  // Set by setup's "Start Build": the app opens on the New site dialog.
  const [startBuild, setStartBuild] = useState(false);

  // A spinner rather than nothing: a blank window reads as a broken app.
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-white" role="status" aria-label="Loading">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-wp-blue" />
      </div>
    );
  }

  // Rendered instead of the app, not over it. An overlay leaves every tab and
  // button behind it in the tab order and reachable by a screen reader, and
  // mounting the app only afterwards means its PHP and MySQL tabs open already
  // knowing about whatever setup just installed.
  if (setup && !setup.done && !dismissed) {
    return (
      <Onboarding
        status={setup}
        onClose={(opts) => {
          setStartBuild(Boolean(opts?.startBuild));
          setDismissed(true);
        }}
      />
    );
  }
  return <Layout openNewSite={startBuild} />;
}

export default App;
