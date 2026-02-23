import EnvWarning from "./components/env-warning";
import { MetricTile, SectionCard } from "./components/tiles";
import {
  buildLatestCompletionMap,
  buildRequirementMap,
  buildTrainingMap,
  evaluateTrainingStatus,
  fetchAirportData,
  isCurrent,
} from "../../lib/airport/data";

export default async function AirportDashboard() {
  let data;
  try {
    data = await fetchAirportData();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Supabase environment variables")) {
      return <EnvWarning />;
    }
    throw error;
  }

  const today = new Date();
  const activeEmployees = data.employees.filter((employee) => employee.active);
  const trainingsById = buildTrainingMap(data.trainings);
  const requirementsByRole = buildRequirementMap(data.requirements);
  const latestCompletions = buildLatestCompletionMap(data.completions);

  const summary = {
    compliant: 0,
    expiring30: 0,
    expiring60: 0,
    expiring90: 0,
    expired: 0,
    missing: 0,
  };

  activeEmployees.forEach((employee) => {
    const requirements = requirementsByRole.get(employee.role) ?? [];
    requirements
      .filter((req) => req.required)
      .forEach((req) => {
        const training = trainingsById.get(req.training_id);
        if (!training) return;
        const latest = latestCompletions.get(`${employee.id}:${training.id}`);
        const status = evaluateTrainingStatus(latest?.completion_date, training.renewal_months, today);
        switch (status.status) {
          case "missing":
            summary.missing += 1;
            break;
          case "expired":
            summary.expired += 1;
            break;
          case "expiring-30":
            summary.expiring30 += 1;
            break;
          case "expiring-60":
            summary.expiring60 += 1;
            break;
          case "expiring-90":
            summary.expiring90 += 1;
            break;
          default:
            summary.compliant += 1;
        }
      });
  });

  const trainingByName = new Map(data.trainings.map((training) => [training.name, training]));
  const minimumByKey = new Map(data.minima.map((item) => [item.coverage_key, item.minimum]));

  const rolesForTraining = (trainingName: string) => {
    const training = trainingByName.get(trainingName);
    if (!training) return new Set<string>();
    return new Set(
      data.requirements
        .filter((req) => req.training_id === training.id && req.required)
        .map((req) => req.role),
    );
  };

  const countQualified = (roles: Set<string>, trainingNames: string[]) => {
    let count = 0;
    activeEmployees.forEach((employee) => {
      if (!roles.has(employee.role)) return;
      const qualified = trainingNames.every((name) => {
        const training = trainingByName.get(name);
        if (!training) return false;
        const latest = latestCompletions.get(`${employee.id}:${training.id}`);
        const status = evaluateTrainingStatus(latest?.completion_date, training.renewal_months, today);
        return isCurrent(status);
      });
      if (qualified) count += 1;
    });
    return count;
  };

  const arffRoles = new Set([
    ...rolesForTraining("ARFF Annual"),
    ...rolesForTraining("Live Fire"),
  ]);
  const driverRoles = new Set([
    ...rolesForTraining("Movement Area Driver"),
    ...rolesForTraining("Wildlife"),
    ...rolesForTraining("FOD"),
  ]);
  const snowRoles = new Set([...rolesForTraining("Snow Ops")]);

  const coverageTiles = [
    {
      label: "ARFF",
      qualified: countQualified(arffRoles, ["ARFF Annual", "Live Fire"]),
      minimum: minimumByKey.get("arff"),
    },
    {
      label: "Driver",
      qualified: countQualified(driverRoles, ["Movement Area Driver", "Wildlife", "FOD"]),
      minimum: minimumByKey.get("driver"),
    },
    {
      label: "Snow",
      qualified: countQualified(snowRoles, ["Snow Ops"]),
      minimum: minimumByKey.get("snow"),
    },
  ];

  return (
    <div className="space-y-8">
      <SectionCard title="Compliance Overview">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <MetricTile label="Compliant" value={summary.compliant} tone="emerald" />
          <MetricTile label="Expiring ≤30" value={summary.expiring30} tone="amber" />
          <MetricTile label="Expiring ≤60" value={summary.expiring60} tone="amber" />
          <MetricTile label="Expiring ≤90" value={summary.expiring90} tone="amber" />
          <MetricTile label="Expired" value={summary.expired} tone="rose" />
          <MetricTile label="Missing" value={summary.missing} tone="zinc" />
        </div>
        <p className="mt-4 text-xs uppercase tracking-[0.2em] text-zinc-400">
          Active employees: {activeEmployees.length}
        </p>
      </SectionCard>

      <SectionCard title="Coverage">
        <div className="grid gap-4 md:grid-cols-3">
          {coverageTiles.map((tile) => (
            <MetricTile
              key={tile.label}
              label={tile.label}
              value={`${tile.qualified} / ${tile.minimum ?? "—"}`}
              sublabel="Qualified vs minimum"
              tone="zinc"
            />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
