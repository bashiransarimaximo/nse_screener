import { build } from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(__dirname, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: resolve(__dirname, "dist/index.mjs"),
  sourcemap: true,
  external: [
    // node_modules — NOT bundled (loaded at runtime from server/node_modules)
    "express", "cors", "pino", "pino-http", "pino-pretty",
    "yahoo-finance2", "drizzle-orm", "pg", "node-cron",
    "resend", "cookie-parser", "@anthropic-ai/sdk",
  ],
  // workspace packages (@nse/*) ARE bundled — no separate compilation step needed
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

console.log("Build complete");
