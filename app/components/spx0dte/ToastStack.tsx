import type { AlertItem } from "@/lib/spx0dte";
import { severityDotClass } from "@/lib/spx0dte";

type ToastStackProps = {
  toasts: AlertItem[];
};

export default function ToastStack({ toasts }: ToastStackProps) {
  return (
    <div className="pointer-events-none fixed right-5 top-20 z-50 w-[340px] space-y-2">
      {toasts.map((toast) => (
        <div key={toast.id} className="rounded-xl border border-[var(--spx-border)] bg-[var(--spx-surface)] p-3 shadow-lg">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${severityDotClass(toast.severity)}`} aria-hidden />
            <span className="text-sm font-medium text-[var(--spx-text)]">
              {toast.type === "ENTRY" ? "Signal Ready" : "Exit Trigger"} - {toast.strategy}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--spx-muted)]">{toast.timeEt} ET</p>
          <p className="mt-1 text-sm text-[var(--spx-text)]">{toast.reason}</p>
        </div>
      ))}
    </div>
  );
}
