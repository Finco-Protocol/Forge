import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", ".sandbox/**", ".data/**", "playwright-report/**", "test-results/**", "next-env.d.ts", "src/shared/abis.generated.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: "Use crypto randomness." },
      ],
    },
  },
  {
    // Client code must never import server modules (keys, DB, GitHub tokens).
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/page.tsx", "src/app/**/layout.tsx", "src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["@/server/*", "**/server/**"], message: "Server-only module imported from client/shared code." }] }],
    },
  },
);
