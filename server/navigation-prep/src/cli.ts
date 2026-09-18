import { buildFixtureGeneration } from "./fixture";
import { navigationAcquisitionPlan } from "./sources";

const command = process.argv[2];
if (command !== "fixture" && command !== "plan") {
  process.stderr.write("usage: navigation-prep <plan|fixture>\n");
  process.exitCode = 1;
} else if (command === "plan") {
  process.stdout.write(`${JSON.stringify(navigationAcquisitionPlan(), null, 2)}\n`);
} else {
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
}
