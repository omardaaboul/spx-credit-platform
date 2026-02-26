export type RuntimeDataMode = "LIVE" | "DELAYED" | "HISTORICAL" | "FIXTURE";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function boolEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return TRUTHY.has(String(raw).trim().toLowerCase());
}

export function simulationModeEnabled(): boolean {
  return boolEnv("SIMULATION_MODE", false);
}

export function allowSimAlertsEnabled(): boolean {
  return boolEnv("ALLOW_SIM_ALERTS", false);
}

export function feature0dteEnabled(): boolean {
  return boolEnv("FEATURE_0DTE", true);
}

export function telegramToken(): string {
  return (
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.TELEGRAM_TOKEN ||
    ""
  ).trim();
}

export function telegramChatId(): string {
  return (process.env.TELEGRAM_CHAT_ID || "").trim();
}

export function telegramConfigured(): boolean {
  return Boolean(telegramToken() && telegramChatId());
}

export function tastyApiToken(): string {
  return (process.env.TASTY_API_TOKEN || "").trim();
}

export function tastyApiSecret(): string {
  return (process.env.TASTY_API_SECRET || "").trim();
}

export function tastyCredentialsPresent(): boolean {
  return Boolean(tastyApiToken() && tastyApiSecret());
}

export function operationalModeLabel(): "SIM" | "LIVE" {
  return simulationModeEnabled() ? "SIM" : "LIVE";
}

export function effectiveRuntimeDataMode(): RuntimeDataMode {
  return simulationModeEnabled() ? "HISTORICAL" : "LIVE";
}

export function requiredEnvIssues(): string[] {
  const issues: string[] = [];

  if (!simulationModeEnabled() && !tastyCredentialsPresent()) {
    issues.push(
      "Missing broker credentials. Set TASTY_API_TOKEN and TASTY_API_SECRET.",
    );
  }

  if (boolEnv("SPX0DTE_ENABLE_TELEGRAM", false) && !telegramConfigured()) {
    issues.push(
      "Telegram enabled but TELEGRAM_BOT_TOKEN (or TELEGRAM_TOKEN) and TELEGRAM_CHAT_ID are not fully configured.",
    );
  }

  return issues;
}
