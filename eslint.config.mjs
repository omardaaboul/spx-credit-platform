import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [
      "app/airport/**/*.{ts,tsx}",
      "app/cashflows/**/*.{ts,tsx}",
      "app/coach/**/*.{ts,tsx}",
      "app/dashboard/**/*.{ts,tsx}",
      "app/settings/**/*.{ts,tsx}",
      "app/trades/**/*.{ts,tsx}",
      "lib/campaigns.ts",
      "lib/coach-data.ts",
      "lib/journal.ts",
      "lib/strategy.ts",
    ],
    rules: {
      // Legacy modules: keep lint practical while avoiding noisy false positives.
      "@typescript-eslint/no-explicit-any": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: [
      "app/spx-0dte/**/*.{ts,tsx}",
      "app/components/spx0dte/**/*.{ts,tsx}",
      "app/api/spx0dte/**/*.{ts,tsx}",
      "lib/spx0dte.ts",
      "lib/payoff.ts",
    ],
    rules: {
      // SPX control-center modules stay strict.
      "@typescript-eslint/no-explicit-any": "error",
      // These components intentionally hydrate client/session state in effects.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "error",
      "@next/next/no-html-link-for-pages": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".venv/**",
    "__pycache__/**",
    "storage/**",
    "_tmp/**",
  ]),
]);

export default eslintConfig;
