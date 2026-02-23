import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        spx: {
          bg: "#0f1724",
          surface: "#111b2b",
          panel: "#172236",
          border: "#263349",
          muted: "#9fb0c6",
          text: "#e7edf6",
          accent: "#63a1ff",
        },
      },
      fontFamily: {
        sans: ["Inter", "IBM Plex Sans", "Avenir Next", "Segoe UI", "sans-serif"],
      },
    },
  },
};

export default config;
