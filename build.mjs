// Build: tsc type-checks and emits dist/*.js, then esbuild folds the two
// runtime dependencies (@modelcontextprotocol/sdk, zod) and everything under
// them into dist/index.js. Users of `npx idmly-mcp` then install nothing at
// run time: they get exactly the file the tests ran against.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { chmodSync } from "node:fs";

execSync("tsc", { stdio: "inherit" });
const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  // bundled CommonJS libraries call require(); give the ESM bundle a real one
  banner: { js: "import { createRequire as __idmlyCreateRequire } from 'node:module';\nconst require = __idmlyCreateRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});
chmodSync("dist/index.js", 0o755);
const kb = Math.round(result.metafile.outputs["dist/index.js"].bytes / 1024);
console.log(`bundled dist/index.js: ${kb} KB, ${Object.keys(result.metafile.inputs).length} source files folded in`);
