import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  { ignores: ["node_modules/**", ".wrangler/**"] },
  js.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
      },
    },
  },
  ...ts.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
