import type { Config } from "tailwindcss";

/**
 * Colours resolve to the CSS variables defined in globals.css. `<alpha-value>` is
 * what lets `bg-accent/10` work against a variable, so the tokens stay usable as
 * tints, not just solid fills.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "hsl(var(--bg) / <alpha-value>)",
        surface: "hsl(var(--surface) / <alpha-value>)",
        elevated: "hsl(var(--elevated) / <alpha-value>)",
        line: "hsl(var(--line) / <alpha-value>)",
        fg: "hsl(var(--fg) / <alpha-value>)",
        muted: "hsl(var(--muted) / <alpha-value>)",
        accent: "hsl(var(--accent) / <alpha-value>)",
        "accent-fg": "hsl(var(--accent-fg) / <alpha-value>)",
        ok: "hsl(var(--ok) / <alpha-value>)",
        bad: "hsl(var(--bad) / <alpha-value>)",
        warn: "hsl(var(--warn) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};

export default config;
