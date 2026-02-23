import EnvWarning from "../../components/env-warning";
import { SectionCard } from "../../components/tiles";
import { StatusChip } from "../../components/status-chip";
import {
  buildEmployeeTrainingRecords,
  buildLatestCompletionMap,
  buildRequirementMap,
  buildTrainingMap,
  fetchAirportData,
  formatDate,
} from "../../../../lib/airport/data";

type DetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function EmployeeDetailPage({ params }: DetailPageProps) {
  let data;
  try {
    data = await fetchAirportData();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Supabase environment variables")) {
      return <EnvWarning />;
    }
    throw error;
  }

  const { id } = await params;
  const employee = data.employees.find((item) => item.id === id);
  if (!employee) {
    return (
      <SectionCard title="Employee">
        <p className="text-sm text-zinc-500">Employee not found.</p>
        <a className="mt-4 inline-block text-sm text-zinc-600 hover:text-zinc-900" href="/airport/people">
          Back to People
        </a>
      </SectionCard>
    );
  }

  const today = new Date();
  const trainingsById = buildTrainingMap(data.trainings);
  const requirementsByRole = buildRequirementMap(data.requirements);
  const latestCompletions = buildLatestCompletionMap(data.completions);

  const records = buildEmployeeTrainingRecords(
    employee,
    requirementsByRole,
    trainingsById,
    latestCompletions,
    today,
  );

  return (
    <div className="space-y-6">
      <SectionCard title="Employee">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Profile</p>
            <h2 className="mt-2 text-2xl font-semibold text-zinc-900">
              {employee.first_name} {employee.last_name}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">{employee.role}</p>
          </div>
          <a className="text-sm text-zinc-600 hover:text-zinc-900" href="/airport/people">
            Back to People
          </a>
        </div>
      </SectionCard>

      <SectionCard title="Training Status">
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-y-2 text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.2em] text-zinc-400">
              <tr>
                <th className="px-3 py-2">Training</th>
                <th className="px-3 py-2">Completion</th>
                <th className="px-3 py-2">Expiry</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.training.id} className="rounded-2xl bg-zinc-50 text-zinc-700">
                  <td className="px-3 py-3 font-medium text-zinc-900">{record.training.name}</td>
                  <td className="px-3 py-3">{formatDate(record.status.completionDate)}</td>
                  <td className="px-3 py-3">{formatDate(record.status.expirationDate)}</td>
                  <td className="px-3 py-3">
                    <StatusChip status={record.status.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
