import { useMemo, useState } from "react";
import type { ReadinessSummary } from "@/lib/readiness";
import StatusBar from "@/app/components/spx0dte/readiness/StatusBar";
import ReadinessGates from "@/app/components/spx0dte/readiness/ReadinessGates";
import SleeveGrid from "@/app/components/spx0dte/readiness/SleeveGrid";
import DiagnosticsDrawer from "@/app/components/spx0dte/readiness/DiagnosticsDrawer";

type ReadinessDashboardProps = {
  summary: ReadinessSummary;
  generatedAtEt?: string;
  generatedAtParis?: string;
  dataAgeSeconds?: number | null;
  alertsEnabled: boolean;
  onToggleAlerts: () => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  onOpenRiskSleeve: () => void;
  riskLocked: boolean;
  onRequestDiagnostics?: (sectionKey?: string) => void;
  showStatusBar?: boolean;
};

export default function ReadinessDashboard({
  summary,
  generatedAtEt,
  generatedAtParis,
  dataAgeSeconds,
  alertsEnabled,
  onToggleAlerts,
  focusMode,
  onToggleFocusMode,
  onOpenRiskSleeve,
  riskLocked,
  onRequestDiagnostics,
  showStatusBar = true,
}: ReadinessDashboardProps) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsSectionKey, setDiagnosticsSectionKey] = useState<string | null>(null);

  const visibleBanners = useMemo(() => {
    if (!focusMode) return summary.banners;
    const critical = summary.banners.find((banner) => banner.level === "critical");
    if (critical) return [critical];
    const warning = summary.banners.find((banner) => banner.level === "warning");
    if (warning) return [warning];
    return summary.banners.slice(0, 1);
  }, [focusMode, summary.banners]);

  const openDiagnostics = (sectionKey?: string) => {
    if (focusMode) return;
    if (onRequestDiagnostics) {
      onRequestDiagnostics(sectionKey);
      return;
    }
    setDiagnosticsSectionKey(sectionKey ?? null);
    setDiagnosticsOpen(true);
  };

  return (
    <section className="space-y-3">
      {showStatusBar && (
        <StatusBar
          summary={summary}
          generatedAtEt={generatedAtEt}
          generatedAtParis={generatedAtParis}
          dataAgeSeconds={dataAgeSeconds}
          alertsEnabled={alertsEnabled}
          onToggleAlerts={onToggleAlerts}
          focusMode={focusMode}
          onToggleFocusMode={onToggleFocusMode}
          onOpenRiskSleeve={onOpenRiskSleeve}
          riskLocked={riskLocked}
        />
      )}

      {visibleBanners.map((banner, idx) => (
        <section
          key={`${banner.level}-${idx}`}
          className={`rounded-xl border px-3 py-2 text-sm ${
            banner.level === "critical"
              ? "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200"
              : banner.level === "warning"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : "border-[var(--spx-border)] bg-[var(--spx-surface)] text-[var(--spx-muted)]"
          }`}
        >
          {banner.text}
        </section>
      ))}

      <ReadinessGates gates={summary.gates} focusMode={focusMode} onOpenDiagnostics={openDiagnostics} />

      <SleeveGrid sleeves={summary.sleeves} focusMode={focusMode} onOpenDiagnostics={openDiagnostics} />

      {!onRequestDiagnostics && (
        <DiagnosticsDrawer
          open={diagnosticsOpen}
          onClose={() => setDiagnosticsOpen(false)}
          sections={summary.diagnosticsSections}
          initialSectionKey={diagnosticsSectionKey}
        />
      )}
    </section>
  );
}
