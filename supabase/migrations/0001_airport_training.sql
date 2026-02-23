create extension if not exists "pgcrypto";

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  role text not null,
  active boolean not null default true
);

create table if not exists trainings (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  renewal_months integer not null default 12 check (renewal_months >= 0)
);

create table if not exists requirements (
  id uuid primary key default gen_random_uuid(),
  role text not null,
  training_id uuid not null references trainings(id) on delete cascade,
  required boolean not null default true,
  unique (role, training_id)
);

create table if not exists completions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  training_id uuid not null references trainings(id) on delete cascade,
  completion_date date not null
);

create index if not exists completions_employee_training_idx
  on completions (employee_id, training_id, completion_date desc);

create table if not exists coverage_minima (
  coverage_key text primary key,
  label text,
  minimum integer not null default 0 check (minimum >= 0)
);
