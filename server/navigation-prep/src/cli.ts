/**
 * navigation-prep <plan|fixture|acquire|validate|normalize|build|verify|publish>
 *
 * The NYC navigation pipeline, modelled on transit-prep's discipline:
 * every stage after `acquire` reads only local bytes, and every mutating
 * command retains an evidence record. Raw inputs and generated generations
 * live outside git under NAVIGATION_PREP_ROOT.
 */

import { acquireExecute, acquirePlan } from "./acquire";
import { build, type BuildOptions } from "./build";
import { buildFixtureGeneration } from "./fixture";
import { publishExecute, publishPlan, publishRollback } from "./publish";
import { normalize } from "./normalize";
import { navigationAcquisitionPlan } from "./sources";
import { validate } from "./validate";
import { verifyGeneration } from "./verify";
import { writeEvidence } from "./evidence";
import type { GridZoom } from "./boundary";

const usage =
  "usage: navigation-prep <plan|fixture|acquire [--plan|--execute]|validate|normalize [--plan|--only streets|buildings]|build [--dry-run] [--grid z13|z14]|verify [generation]|publish [generation] [--execute|--rollback]>";

async function main(): Promise<void> {
  const command = process.argv[2];
  const flags = process.argv.slice(3);
  const has = (flag: string) => flags.includes(flag);

  if (command === "plan" || (command === "plan" && has("--plan"))) {
    process.stdout.write(`${JSON.stringify(navigationAcquisitionPlan(), null, 2)}\n`);
    return;
  }
  if (command === "fixture") {
    const fixture = buildFixtureGeneration();
    process.stdout.write(
      `${JSON.stringify(
        {
          command,
          generation: fixture.generation,
          streets: [...fixture.manifest.streetShards].map(({ key, nodes, edges, bytes }) => ({
            key,
            nodes,
            edges,
            bytes,
          })),
          buildings: [...fixture.manifest.buildingShards].map(
            ({ key, buildings, missingHeights, bytes }) => ({
              key,
              buildings,
              missingHeights,
              bytes,
            }),
          ),
          totalBytes: fixture.manifest.budgets.totalBytes,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "acquire" && has("--plan")) {
    process.stdout.write(`${JSON.stringify(await acquirePlan(), null, 2)}\n`);
    return;
  }
  if (command === "acquire" && has("--execute")) {
    await writeEvidence(command, await acquireExecute());
    return;
  }
  if (command === "validate") {
    await writeEvidence(command, await validate());
    return;
  }
  if (command === "normalize" && has("--plan")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          plan: "read raw ≤ receipts, parse the PBF into the current highway filter, and normalize buildings once; writes work/streets.json + work/buildings.ndjson",
          only: has("--only") ? flags[flags.indexOf("--only") + 1] : "streets+buildings",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "normalize") {
    const only = has("--only")
      ? (flags[flags.indexOf("--only") + 1] as "streets" | "buildings")
      : undefined;
    if (only !== undefined && only !== "streets" && only !== "buildings")
      throw new Error("--only requires streets|buildings");
    await writeEvidence(command, await normalize(only));
    return;
  }
  if (command === "build") {
    const rawGrid = has("--grid") ? flags[flags.indexOf("--grid") + 1] : "14";
    const gridValue = rawGrid.replace(/^z/, "");
    let grid: GridZoom = 14;
    if (gridValue === "13") grid = 13;
    else if (gridValue === "14") grid = 14;
    else throw new Error("--grid requires z13|z14");
    const reportOnly = has("--report-only");
    const options: BuildOptions = { grid, dryRun: has("--dry-run") || reportOnly, reportOnly };
    await writeEvidence(command, await build(options));
    return;
  }
  if (command === "verify") {
    const generation = flags.find((flag) => !flag.startsWith("--"));
    await writeEvidence(command, await verifyGeneration(generation));
    return;
  }
  if (command === "publish") {
    const generation = flags.find((flag) => !flag.startsWith("--"));
    if (has("--execute") && has("--rollback"))
      throw new Error("--execute and --rollback are mutually exclusive");
    if (has("--rollback")) {
      await writeEvidence(command, await publishRollback(generation, {}));
      return;
    }
    if (has("--execute")) {
      await writeEvidence(command, await publishExecute(generation, {}));
      return;
    }
    // Dry-run: local verification and the ordered upload plan; no bucket, no
    // credentials, no network writes.
    const verified = await verifyGeneration(generation);
    const plan = await publishPlan(verified.generation);
    await writeEvidence(command, {
      mode: "dry-run",
      generation: plan.generation,
      publicBase: process.env.R2_PUBLIC_BASE ?? null,
      verifier: {
        objects: verified.objects,
        streetShards: verified.streetShards,
        buildingShards: verified.buildingShards,
        totalBytes: verified.budgets.actual.totalBytes,
      },
      plan: {
        count: plan.objects.length,
        bytes: plan.objects.reduce((sum, object) => sum + object.bytes, 0),
        payloadBytes: plan.payloadBytes,
        first: plan.objects[0].key,
        last: plan.objects[plan.objects.length - 1].key,
        pointerSha256: plan.objects[plan.objects.length - 1].sha256,
      },
      note: "immutable objects upload first and current.json is promoted strictly last; run publish --execute to upload",
    });
    return;
  }
  throw new Error(usage);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
});
