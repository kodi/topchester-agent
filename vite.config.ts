import { defineConfig } from "vite-plus";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [
    solidPlugin({
      hot: false,
      solid: { generate: "universal", moduleName: "@opentui/solid" },
    }),
  ],
  test: { environment: "node" },
  staged: {
    "*.{js,jsx,ts,tsx,json,jsonc,css,html,yml,yaml}": "vp check --fix",
  },
  lint: {
    ignorePatterns: ["bench/mini-bench/tasks/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    singleQuote: false,
    semi: true,
    trailingComma: "es5",
    bracketSpacing: true,
    insertPragma: false,
    proseWrap: "preserve",
    quoteProps: "consistent",
    printWidth: 120,
    requirePragma: false,
    ignorePatterns: [
      "**/templates/*.yaml",
      "**/templates/*.yml",
      "pnpm-lock.yaml",
      ".agents/**",
      "docs/KNOWLEDGE.md",
      "config/output/pump-schema.json",
      "**/dist/**",
      "web/.react-router/**/*",
      "web/app/routeTree.gen.ts",
    ],
    experimentalTailwindcss: {
      stylesheet: "./web/app/app.css",
      attributes: ["class", "className"],
      functions: ["clsx", "cn"],
      preserveDuplicates: false,
      preserveWhitespace: false,
    },
  },
});
