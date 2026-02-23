import { addMonths, differenceInCalendarDays, format, parseISO } from "date-fns";
import { getSupabaseServerClient } from "./supabase";
import type { Completion, CoverageMinimum, Employee, Requirement, Training, TrainingStatus } from "./types";

export type AirportData = {
  employees: Employee[];
  trainings: Training[];
  requirements: Requirement[];
  completions: Completion[];
  minima: CoverageMinimum[];
};

export type EmployeeTrainingRecord = {
  training: Training;
  status: TrainingStatus;
};

export function formatDate(value?: string) {
  if (!value) return "—";
  return format(parseISO(value), "MMM d, yyyy");
}

function parseDate(value: string) {
  return parseISO(value);
}

export function evaluateTrainingStatus(
  completionDate: string | undefined,
  renewalMonths: number,
  today: Date,
): TrainingStatus {
  if (!completionDate) {
    return { status: "missing" };
  }

  const completion = parseDate(completionDate);
  const expiration = addMonths(completion, renewalMonths);
  const daysUntilExpiration = differenceInCalendarDays(expiration, today);

  if (daysUntilExpiration < 0) {
    return {
      status: "expired",
      completionDate,
      expirationDate: format(expiration, "yyyy-MM-dd"),
      daysUntilExpiration,
    };
  }

  if (daysUntilExpiration <= 30) {
    return {
      status: "expiring-30",
      completionDate,
      expirationDate: format(expiration, "yyyy-MM-dd"),
      daysUntilExpiration,
    };
  }

  if (daysUntilExpiration <= 60) {
    return {
      status: "expiring-60",
      completionDate,
      expirationDate: format(expiration, "yyyy-MM-dd"),
      daysUntilExpiration,
    };
  }

  if (daysUntilExpiration <= 90) {
    return {
      status: "expiring-90",
      completionDate,
      expirationDate: format(expiration, "yyyy-MM-dd"),
      daysUntilExpiration,
    };
  }

  return {
    status: "compliant",
    completionDate,
    expirationDate: format(expiration, "yyyy-MM-dd"),
    daysUntilExpiration,
  };
}

export function buildLatestCompletionMap(completions: Completion[]) {
  const latest = new Map<string, Completion>();

  completions.forEach((completion) => {
    const key = `${completion.employee_id}:${completion.training_id}`;
    const existing = latest.get(key);
    if (!existing) {
      latest.set(key, completion);
      return;
    }

    if (parseDate(completion.completion_date) > parseDate(existing.completion_date)) {
      latest.set(key, completion);
    }
  });

  return latest;
}

export function buildRequirementMap(requirements: Requirement[]) {
  const byRole = new Map<string, Requirement[]>();
  requirements.forEach((requirement) => {
    if (!byRole.has(requirement.role)) {
      byRole.set(requirement.role, []);
    }
    byRole.get(requirement.role)?.push(requirement);
  });
  return byRole;
}

export function buildTrainingMap(trainings: Training[]) {
  const map = new Map<string, Training>();
  trainings.forEach((training) => map.set(training.id, training));
  return map;
}

export function buildEmployeeTrainingRecords(
  employee: Employee,
  requirementsByRole: Map<string, Requirement[]>,
  trainingsById: Map<string, Training>,
  latestCompletions: Map<string, Completion>,
  today: Date,
): EmployeeTrainingRecord[] {
  const requirements = requirementsByRole.get(employee.role) ?? [];

  return requirements
    .filter((req) => req.required)
    .map((req) => {
      const training = trainingsById.get(req.training_id);
      if (!training) {
        throw new Error(`Training not found for requirement ${req.id}`);
      }
      const latest = latestCompletions.get(`${employee.id}:${training.id}`);
      const status = evaluateTrainingStatus(latest?.completion_date, training.renewal_months, today);
      return { training, status };
    })
    .sort((a, b) => a.training.name.localeCompare(b.training.name));
}

export function summarizeStatus(records: EmployeeTrainingRecord[]) {
  return records.reduce(
    (acc, record) => {
      acc[record.status.status] = (acc[record.status.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
}

export function isCurrent(status: TrainingStatus) {
  return status.status !== "missing" && status.status !== "expired";
}

export async function fetchAirportData(): Promise<AirportData> {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    throw new Error("Supabase environment variables are missing.");
  }

  const [employeesResult, trainingsResult, requirementsResult, completionsResult, minimaResult] =
    await Promise.all([
      supabase.from("employees").select("*").order("last_name", { ascending: true }),
      supabase.from("trainings").select("*").order("name", { ascending: true }),
      supabase.from("requirements").select("*"),
      supabase.from("completions").select("*"),
      supabase.from("coverage_minima").select("*"),
    ]);

  if (employeesResult.error) throw employeesResult.error;
  if (trainingsResult.error) throw trainingsResult.error;
  if (requirementsResult.error) throw requirementsResult.error;
  if (completionsResult.error) throw completionsResult.error;
  if (minimaResult.error) throw minimaResult.error;

  return {
    employees: employeesResult.data ?? [],
    trainings: trainingsResult.data ?? [],
    requirements: requirementsResult.data ?? [],
    completions: completionsResult.data ?? [],
    minima: minimaResult.data ?? [],
  };
}
