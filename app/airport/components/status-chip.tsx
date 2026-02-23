const STATUS_STYLES: Record<string, string> = {
  missing: "bg-zinc-900 text-white",
  expired: "bg-rose-100 text-rose-700",
  "expiring-30": "bg-amber-200 text-amber-900",
  "expiring-60": "bg-amber-100 text-amber-800",
  "expiring-90": "bg-amber-50 text-amber-700",
  compliant: "bg-emerald-100 text-emerald-700",
};

const STATUS_LABELS: Record<string, string> = {
  missing: "Missing",
  expired: "Expired",
  "expiring-30": "Expiring ≤30d",
  "expiring-60": "Expiring ≤60d",
  "expiring-90": "Expiring ≤90d",
  compliant: "Compliant",
};

export function StatusChip({ status }: { status: string }) {
  const styles = STATUS_STYLES[status] ?? "bg-zinc-100 text-zinc-600";
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${styles}`}>
      {label}
    </span>
  );
}
