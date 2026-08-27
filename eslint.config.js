import tsParser from "@typescript-eslint/parser";

// Complexity gate only. This is deliberately not a general-purpose lint setup:
// the single rule here is a guardrail against functions growing unreviewably
// branchy, and keeping the config to one rule means a failure is always
// actionable and never a style argument.
export default [
  {
    ignores: ["node_modules/**", "dist/**", "build/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    rules: {
      complexity: ["error", 10],
    },
  },
];
