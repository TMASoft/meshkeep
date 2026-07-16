import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import configPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/node_modules/", "**/*.d.ts", "docker/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs["flat/recommended"],
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    files: ["packages/web/**"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ["packages/server/**", "packages/shared/**"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      // interop with meshcore.js and raw frame parsing relies on loose shapes
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  configPrettier,
);
