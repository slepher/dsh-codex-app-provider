import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  entryPoints: [`${root}src/client/index.ts`],
  outfile: `${root}lib/client.js`,
  tsconfig: `${root}tsconfig.client.json`,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  // The shell's module table supplies the baseline identities, so the bundle
  // must request them instead of inlining a second copy.
  external: [
    "react", "react/jsx-runtime", "react-dom", "react-dom/client",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-ui-slots",
  ],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-codex-app-provider", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: "return module.exports; } });" },
});
