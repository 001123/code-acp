import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

export function mount(app: ReactNode): void {
  createRoot(document.getElementById("root")!).render(app);
}
