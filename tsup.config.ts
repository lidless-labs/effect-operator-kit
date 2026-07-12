import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Declarations come from `tsc -p tsconfig.build.json`; tsup's dts rollup
  // crashes against the TypeScript 7 native compiler shim.
  dts: false,
  splitting: false,
});
