// Development uses the same staged publisher, with execution restart fencing.
import { watchPublication } from "./publish.mjs";
try { await watchPublication(true); }
catch (error) { console.error(String(error)); process.exitCode = 1; }
