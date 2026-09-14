import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  entryPoints: [`${root}src/client/index.ts`], outfile: `${root}lib/client.js`,
  tsconfig: `${root}tsconfig.client.json`,
  bundle: true, format: "cjs", platform: "browser", target: "es2022",
  // Shell platform modules: the client module table supplies these, so they stay
  // one browser identity instead of a second bundled copy.
  // `react*` are shell platform modules; the session-controller client half is a
  // declared `dsh.client.external`, so it must resolve to the shell's single
  // instance instead of being inlined as a second copy with its own private tag.
  external: ["react", "react/jsx-runtime", "react-dom", "@deepseek-ai/dsh-api-session-controller/client"],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-codex-app-provider", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: "return module.exports; } });" },
});
