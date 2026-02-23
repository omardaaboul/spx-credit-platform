export type Employee = {
  id: string;
  first_name: string;
  last_name: string;
  role: string;
  active: boolean;
};

export type Training = {
  id: string;
  name: string;
  renewal_months: number;
};

export type Requirement = {
  id: string;
  role: string;
  training_id: string;
  required: boolean;
};

export type Completion = {
  id: string;
  employee_id: string;
  training_id: string;
  completion_date: string;
};

export type CoverageMinimum = {
  coverage_key: string;
  minimum: number;
  label: string | null;
};

export type TrainingStatus = {
  status: "missing" | "expired" | "expiring-30" | "expiring-60" | "expiring-90" | "compliant";
  completionDate?: string;
  expirationDate?: string;
  daysUntilExpiration?: number;
};
