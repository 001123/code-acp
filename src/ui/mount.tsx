import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./errorBoundary";
import { useL10n } from "./l10n";

function Crashed({ message, retry }: { message: string; retry: () => void }) {
  const { t } = useL10n();
  return (
    <div className="crashed">
      <div>{t("webview.crashed", message)}</div>
      <button onClick={retry}>{t("webview.reload")}</button>
    </div>
  );
}

export function mount(app: ReactNode): void {
  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary fallback={(message, retry) => <Crashed message={message} retry={retry} />}>{app}</ErrorBoundary>,
  );
}
