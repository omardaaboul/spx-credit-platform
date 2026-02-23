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
  return boolEnv("FEATURE_0DTE", false);
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

export function tastyUsername(): string {
  return (
    process.env.TASTY_USERNAME ||
    process.env.TASTYTRADE_USERNAME ||
    ""
  ).trim();
}

export function tastyPassword(): string {
  return (
    process.env.TASTY_PASSWORD ||
    process.env.TASTYTRADE_PASSWORD ||
    ""
  ).trim();
}

export function tastyOauthSecret(): string {
  return (process.env.TASTY_CLIENT_SECRET || "").trim();
}

export function tastyOauthRefresh(): string {
  return (process.env.TASTY_REFRESH_TOKEN || "").trim();
}

export function tastyCredentialsPresent(): boolean {
  const userPass = Boolean(tastyUsername() && tastyPassword());
  const oauth = Boolean(tastyOauthSecret() && tastyOauthRefresh());
  return userPass || oauth;
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
      "Missing broker credentials. Set TASTY_USERNAME/TASTY_PASSWORD or TASTY_CLIENT_SECRET/TASTY_REFRESH_TOKEN.",
    );
  }

  if (boolEnv("SPX0DTE_ENABLE_TELEGRAM", false) && !telegramConfigured()) {
    issues.push(
      "Telegram enabled but TELEGRAM_BOT_TOKEN (or TELEGRAM_TOKEN) and TELEGRAM_CHAT_ID are not fully configured.",
    );
  }

  return issues;
}
