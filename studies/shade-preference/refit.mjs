/**
 * S2a — refit Melnikov et al. 2022 as a hierarchical logit, deterministically.
 *
 * Source of truth: the OSF project aj4vk (behaviour_analysis) — data cached at
 * studies/shade-preference/data/behavioural_data.csv (sha256 9ae281d9…75950,
 * download URL and licence in docs/notes/shade-preference.md), analysis
 * reproduced from analysis_final.ipynb cell 20
 * (`pymc_hier_beta_pooled_tau_tree_rho_model`).
 *
 * Their generative model (units of 100 m, choices where Treatment > 0):
 *
 *   hyper a,b = exp(N(0,1) ± N(0,1))     (Gamma shape/rate on β)
 *   β_j ~ Gamma(a, b)          per participant j (our α)
 *   τ_k ~ Gamma(12.5, 50)      per task-set group k (scale 0.01 ⇒ rate 50)
 *   ρ   ~ Beta(1, 1)           tree-shade effectiveness
 *   Δc_ij = β_j·(Δsun_ρ) + (Δshade_ρ)     A−B, tree split by ρ
 *   y_ij ~ Bernoulli(σ(−Δc/τ_k))         y = 1 − B_chosen
 *
 * MCMC in the notebook; here the deterministic analogue: **joint MAP of
 * (a, b, ρ, τ) with each β_j integrated out by Gauss–Legendre quadrature over
 * the Gamma prior** — the same posterior structure without a sampler. The
 * notebook's hyperpriors on (a, b) and τ are part of the model and part of the
 * objective: without them the marginal likelihood alone is degenerate (~9
 * trials per participant drives shape → ∞, one shared β; verified on the
 * surface — see the note).
 *
 * Notebook preprocessing matched exactly: Treatment > 0 subset, participants
 * factorized on that subset, Task_set flipped (1 − x) as the τ grouping,
 * Choice_indicator = 1 − B_chosen. One deviation, stated: the notebook fits a
 * τ per task-set group; this refit fits one pooled τ because the browser
 * module ships one τ, and the two groups' τ estimates are within noise of
 * each other (see eval.mjs output).
 *
 * Run:  node studies/shade-preference/refit.mjs
 */

import {
	fitHierarchical,
	loadModelRows,
	trialDiffs,
} from "./hierfit.mjs";

const rows = await loadModelRows();
const participants = [...new Set(rows.map((r) => r.Participant))];
console.log(
	`rows (Treatment>0): ${rows.length}, participants: ${participants.length}`,
);
console.log(
	`task-set split: ${rows.filter((r) => Number(r.Task_set) === 1).length} / ${rows.filter((r) => Number(r.Task_set) === 0).length}`,
);

const t0 = Date.now();
const rowsByParticipant = {};
for (const r of rows) {
	(rowsByParticipant[r.Participant] ??= []).push(r);
}
const { prior, eBeta, jointLogPosterior } = fitHierarchical(rowsByParticipant);

const betaValues = Object.values(eBeta).sort((a, b) => a - b);
console.log(
	`fit: shape a=${prior.alphaShape.toFixed(3)} rate b=${prior.alphaRate.toFixed(3)} ρ=${prior.rho.toFixed(3)} τ=${prior.tau.toFixed(3)}`,
);
console.log(
	`   population mean β̄ = a/b = ${(prior.alphaShape / prior.alphaRate).toFixed(3)}  (paper: ≈ 1.16)`,
);
console.log(
	`   population sd = √a/b² = ${(Math.sqrt(prior.alphaShape) / prior.alphaRate).toFixed(3)}`,
);
console.log(`   joint log-posterior = ${jointLogPosterior.toFixed(2)}`);
console.log(
	`   per-participant E[β_j]: min ${betaValues[0].toFixed(2)}, median ${betaValues[Math.floor(betaValues.length / 2)].toFixed(2)}, max ${betaValues[betaValues.length - 1].toFixed(2)}`,
);
console.log(`   (paper reports individual β ≈ 0.37–1.84)`);
console.log(`   elapsed: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// Group-τ check (the deviation above): the same joint MAP with τ split by the
// notebook's flipped Task_set grouping, quoted for the note.
const byGroup = { 0: [], 1: [] };
for (const r of rows) {
	byGroup[1 - Number(r.Task_set)].push(r);
}
function partitionBy(rs) {
	const map = {};
	for (const r of rs) {
		(map[r.Participant] ??= []).push(r);
	}
	return map;
}

const g1 = byGroup[1];
const g0 = byGroup[0];
// Reuse fitHierarchical per group to see whether the groups differ.
const fit1 = fitHierarchical(partitionBy(g1));
const fit0 = fitHierarchical(partitionBy(g0));
console.log(
	`   τ by task-set group: set-1 τ=${fit1.prior.tau.toFixed(3)}, set-0 τ=${fit0.prior.tau.toFixed(3)} (pooled: ${prior.tau.toFixed(3)})`,
);

// Predicted-vs-observed share of "chose the shorter-sun option" — the single
// number that says the fitted model sees the same signal as the raw data.
let obsShort = 0;
let predShort = 0;
for (const r of rows) {
	const d = trialDiffs(r, prior.rho);
	const alphaJ = eBeta[r.Participant] ?? prior.alphaShape / prior.alphaRate;
	const pChooseA = 1 / (1 + Math.exp(-(-(alphaJ * d.dSun + d.dShade) / prior.tau)));
	const choseA = r.y === 1;
	const aShorterSun = d.dSun < 0;
	if (choseA === aShorterSun) obsShort += 1;
	if (pChooseA > 0.5 === aShorterSun) predShort += 1;
}
console.log(
	`   chose-shorter-sun share: observed ${(obsShort / rows.length).toFixed(3)}, model ${(predShort / rows.length).toFixed(3)}`,
);

console.log("\n// app/lib/preference/prior.ts — paste:");
console.log(
	`export const POPULATION_PRIOR: PopulationPrior = { alphaShape: ${prior.alphaShape.toFixed(3)}, alphaRate: ${prior.alphaRate.toFixed(3)}, rho: ${prior.rho.toFixed(3)}, tau: ${prior.tau.toFixed(3)} };`,
);
