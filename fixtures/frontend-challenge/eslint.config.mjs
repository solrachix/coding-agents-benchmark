import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "coverage/**", "dist/**", "next-env.d.ts", "**/*.tsbuildinfo"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
