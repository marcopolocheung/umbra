#!/usr/bin/env node

const mode = process.argv[2];
const major = Number.parseInt(process.versions.node.split(".")[0], 10);

if (mode !== "fixture" && mode !== "prep") {
  console.error("usage: node scripts/preflight-shadow-v2.mjs <fixture|prep>");
  process.exitCode = 2;
} else if (!Number.isInteger(major)) {
  console.error(`cannot determine Node major version from ${process.version}`);
  process.exitCode = 2;
} else if (mode === "prep" && major !== 24) {
  // The prep manifests and container deliberately require exactly the supported
  // major.  Do not let a passing fixture test turn a GDAL/PROJ preparation run
  // on an unqualified host into an implicit compatibility promise.
  console.error(`shadow prep requires Node 24.x; found ${process.version}`);
  process.exitCode = 1;
} else if (mode === "fixture" && major < 20) {
  console.error(`fixture checks require Node 20 or newer; found ${process.version}`);
  process.exitCode = 1;
} else {
  // This line is intentionally machine-readable.  Keep it in CI logs and save
  // it beside any fixture evidence; it records the actual compatibility runtime.
  console.log(JSON.stringify({
    check: "shadow-engine-v2-preflight",
    mode,
    node: process.version,
    result: "pass",
    runtimePolicy: mode === "prep"
      ? "Node 24.x is required for preparation"
      : "Node 24.x is the application runtime; Node 20+ is allowed only for deterministic fixture checks",
  }));
}
