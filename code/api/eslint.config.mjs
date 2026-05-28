import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  js.configs.recommended, // Base recommended JS rules
  {
    files: ["**/*.ts", "**/*.tsx"], // Apply to TypeScript files
    languageOptions: {
      parser: tsParser, // Specify the TypeScript parser
      ecmaVersion: 2020, // Enable modern JavaScript features
      sourceType: "module", // Use ES Modules
      globals: {
        process: "readonly", // Explicitly define `process` as a global variable
        console: "readonly", // Explicitly define `console` as a global variable
        Express: "readonly", // Explicitly define `Express` as a global variable
        __dirname: "readonly", // Explicitly define `__dirname` as a global variable
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules, // TypeScript recommended rules
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ], // Warn on unused variables
      "@typescript-eslint/no-explicit-any": "off", // Allow `any` type
      "@typescript-eslint/no-namespace": "off", // Allow namespaces
    },
  },
];
