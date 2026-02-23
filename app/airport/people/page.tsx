import EnvWarning from "../components/env-warning";
import { SectionCard } from "../components/tiles";
import {
  buildEmployeeTrainingRecords,
  buildLatestCompletionMap,
  buildRequirementMap,
  buildTrainingMap,
  fetchAirportData,
  summarizeStatus,
} from "../../../lib/airport/data";

type PeoplePageProps = {
  searchParams: Promise<{
    q?: string;
  }>;
};

export default async function PeoplePage({ searchParams }: PeoplePageProps) {
  let data;
  try {
    data = await fetchAirportData();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Supabase environment variables")) {
      return <EnvWarning />;
    }
    throw error;
  }

  const params = await searchParams;
  const today = new Date();
  const query = params.q?.trim().toLowerCase() ?? "";

  const trainingsById = buildTrainingMap(data.trainings);
  const requirementsByRole = buildRequirementMap(data.requirements);
  const latestCompletions = buildLatestCompletionMap(data.completions);

  const employees = data.employees.filter((employee) => employee.active);
  const filteredEmployees = query
    ? employees.filter((employee) => {
        const fullName = `${employee.first_name} ${employee.last_name}`.toLowerCase();
        return (
          fullName.includes(query) ||
          employee.role.toLowerCase().includes(query)
        );
      })
    : employees;

  return (
    <div className="space-y-6">
      <SectionCard title="People">
        <form className="mb-4 flex flex-wrap items-center gap-3" method="get">
          <input
            className="w-full max-w-xs rounded-full border border-zinc-200 px-4 py-2 text-sm outline-none transition focus:border-zinc-400"
            name="q"
            placeholder="Search name or role"
            defaultValue={params.q ?? ""}
          />
          <button
            className="rounded-full border border-zinc-200 px-4 py-2 text-sm text-zinc-600 transition hover:border-zinc-400 hover:text-zinc-900"
            type="submit"
          >
            Search
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-y-2 text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.2em] text-zinc-400">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Missing</th>
                <th className="px-3 py-2">Expired</th>
                <th className="px-3 py-2">Expiring</th>
                <th className="px-3 py-2">Compliant</th>
              </tr>
            </thead>
            <tbody>
              {filteredEmployees.map((employee) => {
                const records = buildEmployeeTrainingRecords(
                  employee,
                  requirementsByRole,
                  trainingsById,
                  latestCompletions,
                  today,
                );
                const summary = summarizeStatus(records);
                const expiring =
                  (summary["expiring-30"] ?? 0) +
                  (summary["expiring-60"] ?? 0) +
                  (summary["expiring-90"] ?? 0);

                return (
                  <tr
                    key={employee.id}
                    className="rounded-2xl bg-zinc-50 text-zinc-700"
                  >
                    <td className="px-3 py-3 font-medium text-zinc-900">
                      <a className="hover:underline" href={`/airport/people/${employee.id}`}>
                        {employee.first_name} {employee.last_name}
                      </a>
                    </td>
                    <td className="px-3 py-3">{employee.role}</td>
                    <td className="px-3 py-3">{summary.missing ?? 0}</td>
                    <td className="px-3 py-3">{summary.expired ?? 0}</td>
                    <td className="px-3 py-3">{expiring}</td>
                    <td className="px-3 py-3">{summary.compliant ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filteredEmployees.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No people match that search.</p>
        ) : null}
      </SectionCard>
    </div>
  );
}
