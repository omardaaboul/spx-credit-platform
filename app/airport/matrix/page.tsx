import { revalidatePath } from "next/cache";
import EnvWarning from "../components/env-warning";
import { SectionCard } from "../components/tiles";
import { fetchAirportData } from "../../../lib/airport/data";
import { getSupabaseServerClient } from "../../../lib/airport/supabase";

export default async function TrainingMatrixPage() {
  async function updateRenewalMonths(formData: FormData) {
    "use server";
    const supabase = getSupabaseServerClient();
    if (!supabase) {
      throw new Error("Supabase environment variables are missing.");
    }

    const trainingId = String(formData.get("training_id") ?? "");
    const renewalMonths = Number(formData.get("renewal_months"));
    if (!trainingId || Number.isNaN(renewalMonths) || renewalMonths < 0) {
      return;
    }

    const { error } = await supabase
      .from("trainings")
      .update({ renewal_months: renewalMonths })
      .eq("id", trainingId);

    if (error) {
      throw error;
    }

    revalidatePath("/airport/matrix");
  }

  let data;
  try {
    data = await fetchAirportData();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Supabase environment variables")) {
      return <EnvWarning />;
    }
    throw error;
  }

  const roles = Array.from(new Set(data.requirements.map((req) => req.role))).sort();

  const requirementsByTrainingRole = new Map<string, boolean>();
  data.requirements.forEach((req) => {
    requirementsByTrainingRole.set(`${req.training_id}:${req.role}`, req.required);
  });

  return (
    <div className="space-y-6">
      <SectionCard title="Training Matrix">
        <p className="mb-4 text-sm text-zinc-500">
          Edit renewal months to update expiration calculations. Requirements are shown by role.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-separate border-spacing-y-2 text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.2em] text-zinc-400">
              <tr>
                <th className="px-3 py-2">Training</th>
                <th className="px-3 py-2">Renewal (months)</th>
                {roles.map((role) => (
                  <th key={role} className="px-3 py-2">
                    {role}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.trainings.map((training) => (
                <tr key={training.id} className="rounded-2xl bg-zinc-50 text-zinc-700">
                  <td className="px-3 py-3 font-medium text-zinc-900">{training.name}</td>
                  <td className="px-3 py-3">
                    <form action={updateRenewalMonths} className="flex items-center gap-2">
                      <input type="hidden" name="training_id" value={training.id} />
                      <input
                        className="w-24 rounded-full border border-zinc-200 px-3 py-1 text-sm focus:border-zinc-400"
                        defaultValue={training.renewal_months}
                        min={0}
                        name="renewal_months"
                        type="number"
                      />
                      <button
                        className="rounded-full border border-zinc-200 px-3 py-1 text-xs uppercase tracking-[0.2em] text-zinc-500 hover:border-zinc-400 hover:text-zinc-800"
                        type="submit"
                      >
                        Save
                      </button>
                    </form>
                  </td>
                  {roles.map((role) => {
                    const required = requirementsByTrainingRole.get(`${training.id}:${role}`);
                    return (
                      <td key={role} className="px-3 py-3">
                        {required ? "Required" : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
