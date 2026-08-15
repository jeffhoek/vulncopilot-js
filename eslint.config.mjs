// eslint-config-next 16 ships real flat configs, so the entrypoints are spread
// directly. The previous @eslint/eslintrc FlatCompat shim no longer works
// against them (compat.extends() runs the eslintrc schema validator over an
// already-flat config and dies on the circular plugin references).
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default eslintConfig;
