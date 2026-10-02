/**
 * S2a — evaluation of the hierarchical shade-preference model.
 *
 * TRACK_S.md S2a eval requirements, all on the cached Melnikov data, all with
 * **participant-blocked** splits (a whole person is in train or in test, never
 * split across — random rows from one person leak):
 *
 *  1. Held-out choice log-likelihood and accuracy for the hierarchical model
 *     vs three baselines — the population-mean α, shadewalker's fixed ladder
 *     (0/5/15/40 as fixed α rungs, the closest faithful mapping of a fixed
 *     preference ladder onto this model), and a non-hierarchical logit (one
 *     shared α, no per-user learning). 10-fold leave-participants-out; every
 *     model's prior is refit on the train participants only, so no held-out
 *     row leaks into its own model's hyperparameters.
 *  2. A calibration curve on the held-out A-choice probabilities.
 *  3. A simulated-user recovery curve: simulated walkers with known α draw
 *     picks from the fitted logit; how many picks until the MAP α is within
 *     ±20% of the truth.
 *
 * The hierarchical model's per-user update runs in two regimes, and both are
 * reported: **cold** (a brand-new user: α = population prior mean, no picks)
 * and **online** (α updated from that user's first k picks — the shipped
 * `updatePreference` behaviour). The baselines get the same first-k data.
 *
 * Run:  node studies/shade-preference/eval.mjs
 *
 * Honesty notes carried into docs/notes/shade-preference.md: the online half
 * is validated in simulation and on one study's participants only, until
 * real Umbra usage exists; and 46 Singaporeans in a courtyard are a domain
 * shift from Manhattan in July.
 */

import {
	chooseProb,
	fitAlphaMap,
	fitHierarchical,
	loadModelRows,
	trialDiffs,
	trialToPick,
} from "./hierfit.mjs";

const rows = await loadModelRows();
const participants = [...new Set(rows.map((r) => r.Participant))].sort();
const byParticipant = {};
for (const r of rows) {
	(byParticipant[r.Participant] ??= []).push(r);
}

const FOLDS = 10;

/** Deterministic fold assignment: round-robin over sorted participants. */
const foldOf = new Map(participants.map((p, i) => [p, i % FOLDS]));

const LADDER = [0, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0]; // fixed-α rungs incl. shadewalker's 0/5/15/40 shape

/**
 * A model maps (prior, first-k picks of this user) → α for predicting their
 * held-out picks. `train` is only used by models that refit on train rows.
 */
const models = {
	hierarchical: {
		/** α after k own picks: the shipped MAP update against the prior. */
		alphaAfterK: (prior, picks) => fitAlphaMap(prior, picks),
		/** Cold-start α. */
		alpha0: (prior) => prior.alphaShape / prior.alphaRate,
	},
	populationMean: {
		/** The population-mean-α baseline: no per-user learning, ever. */
		alphaAfterK: (prior) => prior.alphaShape / prior.alphaRate,
		alpha0: (prior) => prior.alphaShape / prior.alphaRate,
	},
	ladder: {
		/** Fixed-α rungs; the best rung on the user's first-k picks (a fixed
		 *  ladder has no smooth update — its only adaptation is rung choice). */
		alphaAfterK: (prior, picks) => {
			if (picks.length === 0) return 1.0; // the middle rung, cold
			let best = 1.0;
			let bestLL = Number.NEGATIVE_INFINITY;
			for (const alpha of LADDER) {
				let ll = 0;
				for (const pick of picks) ll += Math.log(chooseProb(pick, alpha, prior));
				if (ll > bestLL) {
					bestLL = ll;
					best = alpha;
				}
			}
			return best;
		},
		alpha0: () => 1.0,
	},
	nonHierarchical: {
		/** One shared α fit on the TRAIN participants' pooled rows (no
		 *  hierarchy, no per-user update — the pooled MLE compromise). */
		trainAlpha: (trainRows) => {
			// MLE of a single α on pooled rows via grid around the joint MAP:
			// reuse fitAlphaMap with a flat prior over each pooled row-pick.
			const flat = {
				alphaShape: 1.0001,
				alphaRate: 1e-6,
				rho: null, // filled by caller with train-fit ρ
				tau: null,
			};
			const picks = trainRows.map((r) => trialToPick(r, false));
			return (rhoTau) => {
				flat.rho = rhoTau.rho;
				flat.tau = rhoTau.tau;
				return fitAlphaMap(flat, picks);
			};
		},
		alphaAfterK: null, // handled inline: pooled α, constant for everyone
	},
};

// ---- 1. held-out LL + accuracy, participant-blocked ----

const K_GRID = [1, 2, 3, 4, 5, 8];
const acc = {};
for (const name of Object.keys(models)) {
	acc[name] = {
		cold: { ll: 0, correct: 0, n: 0 },
		online: K_GRID.map(() => ({ ll: 0, correct: 0, n: 0 })),
	};
}
const calib = {
	cold: bins10(),
	online: K_GRID.map(() => bins10()),
};
function bins10() {
	return Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, chosenA: 0 }));
}

for (let fold = 0; fold < FOLDS; fold++) {
	const trainP = participants.filter((p) => foldOf.get(p) !== fold);
	const testP = participants.filter((p) => foldOf.get(p) === fold);
	const trainRows = trainP.flatMap((p) => byParticipant[p]);
	// The train-only hierarchy: prior and per-user E[β] from train alone.
	const trainByP = {};
	for (const r of trainRows) {
		(trainByP[r.Participant] ??= []).push(r);
	}
	const trainFit = fitHierarchical(trainByP);
	const prior = trainFit.prior;

	// Non-hierarchical baseline: pooled MLE α on the same train rows.
	const pooledAlpha = (() => {
		const flat = {
			alphaShape: 1.0001,
			alphaRate: 1e-6,
			rho: prior.rho,
			tau: prior.tau,
		};
		const picks = trainRows.map((r) => trialToPick(r, false));
		return fitAlphaMap(flat, picks);
	})();

	for (const p of testP) {
		const pRows = byParticipant[p];
		const picks = pRows.map((r) => trialToPick(r, false));
		if (picks.length < 2) continue;
		// Cold: prior mean (or pooled α, or middle rung) predicts all picks.
		const coldAlphas = {
			hierarchical: prior.alphaShape / prior.alphaRate,
			populationMean: prior.alphaShape / prior.alphaRate,
			ladder: 1.0,
			nonHierarchical: pooledAlpha,
		};
		for (const [name, alpha] of Object.entries(coldAlphas)) {
			for (let i = 0; i < picks.length; i++) {
				const pr = chooseProb(picks[i], alpha, prior);
				scorePick(name, pr, pRows[i].y, "cold");
			}
		}
		// Online: first k picks update α, predict the rest.
		for (let gi = 0; gi < K_GRID.length; gi++) {
			const k = Math.min(K_GRID[gi], picks.length - 1);
			const seen = picks.slice(0, k);
			const alphas = {
				hierarchical: fitAlphaMap(prior, seen),
				populationMean: prior.alphaShape / prior.alphaRate,
				ladder: models.ladder.alphaAfterK(prior, seen),
				nonHierarchical: pooledAlpha,
			};
			for (const [name, alpha] of Object.entries(alphas)) {
				for (let i = k; i < picks.length; i++) {
					const pr = chooseProb(picks[i], alpha, prior);
					scorePick(name, pr, pRows[i].y, "online", gi);
				}
			}
		}
	}

	/** Score one held-out pick: `pr` = P(option A chosen), `y` = 1 if A was. */
	function scorePick(name, pr, y, regime, gi) {
		const a = acc[name][regime];
		const slot = regime === "online" ? a[gi] : a;
		// The pick's chosen option is the outcome; P(chosen) decides the LL.
		const prChosen = y === 1 ? pr : 1 - pr;
		slot.ll += Math.log(Math.max(prChosen, 1e-12));
		slot.correct += prChosen > 0.5 ? 1 : 0;
		slot.n += 1;
		// Calibration bins P(A chosen) against the binary outcome y.
		if (name === "hierarchical") {
			const bin = Math.min(9, Math.floor(pr * 10));
			const target = regime === "online" ? calib.online[gi] : calib.cold;
			target[bin].n += 1;
			target[bin].sumP += pr;
			target[bin].chosenA += y === 1 ? 1 : 0;
		}
	}
}

function fmt(x, d) {
	return x.toFixed(d);
}

console.log(
	"Participant-blocked 10-fold leave-participants-out — held-out log-likelihood per pick",
);
console.log(
	"(cold = no own picks; online k = own first-k picks seen; 46 people, 408 trials)\n",
);
const header =
	"model            cold    " +
	K_GRID.map((k) => `k=${k}`).join("   ");
console.log(header);
for (const name of Object.keys(models)) {
	const coldLL = acc[name].cold.ll / acc[name].cold.n;
	const onlineLL = acc[name].online.map((s) => fmt(s.ll / s.n, 4));
	console.log(
		name.padEnd(16),
		fmt(coldLL, 4).padEnd(7),
		onlineLL.join("  "),
	);
}
console.log();
console.log("Held-out accuracy");
console.log(header);
for (const name of Object.keys(models)) {
	const coldA = acc[name].cold.correct / acc[name].cold.n;
	const onlineA = acc[name].online.map((s) => fmt(s.correct / s.n, 4));
	console.log(
		name.padEnd(16),
		fmt(coldA, 4).padEnd(7),
		onlineA.join("  "),
	);
}
console.log();

// ---- 2. calibration curve (hierarchical, cold + online pooled over k) ----

function printCalibration(label, binList) {
	console.log(`Calibration (hierarchical, ${label}): bin → mean predicted P vs observed rate, ECE`);
	let num = 0;
	let den = 0;
	for (let bin = 0; bin < 10; bin++) {
		const merged = binList.reduce(
			(m, c) => {
				m.n += c[bin].n;
				m.sumP += c[bin].sumP;
				m.chosenA += c[bin].chosenA;
				return m;
			},
			{ n: 0, sumP: 0, chosenA: 0 },
		);
		if (merged.n === 0) continue;
		const meanP = merged.sumP / merged.n;
		const obs = merged.chosenA / merged.n;
		num += merged.n * Math.abs(obs - meanP);
		den += merged.n;
		console.log(
			`  ${((bin * 0.1) + 0.05).toFixed(2)}: n=${merged.n} predicted=${meanP.toFixed(3)} observed=${obs.toFixed(3)}`,
		);
	}
	console.log(`  ECE = ${(num / den).toFixed(4)}\n`);
	return num / den;
}
printCalibration("cold", [calib.cold]);
printCalibration("online (pooled over k)", calib.online);

// ---- 3. simulated-user recovery curve ----
// Simulated walkers with known α_*: each draws a history of picks from the
// fitted logit on the real trials' geometry, the shipped MAP update runs
// pick-by-pick, and we record the first k at which |α̂ − α*| ≤ 20% of α* and
// it stays there for the rest of the history (not a lucky bounce).

import { POPULATION_PRIOR_SRC } from "./prior-const.mjs";
const SIM_PRIOR = POPULATION_PRIOR_SRC;

const geometry = rows.map((r) => trialDiffs(r, SIM_PRIOR.rho));

function simulateRecovery() {
	const trueAlphas = [0.5, 0.8, 1.2, 1.6, 2.0];
	const N_SIM = 300;
	const HISTORY = 20;
	console.log(
		`Simulated-user recovery (${N_SIM} sims per α*, history ${HISTORY}, ±20% of truth held to the end):`,
	);
	for (const alphaTrue of trueAlphas) {
		let recoveredCount = 0;
		const atK = [];
		for (let sim = 0; sim < N_SIM; sim++) {
			const picks = [];
			let lastWithin = -1;
			let recovered = null;
			for (let t = 0; t < HISTORY; t++) {
				// Deterministic-ish geometry cycling through the 408 real trials.
				const g = geometry[(sim * 7 + t * 13) % geometry.length];
				// Simulated user draws A vs B; pick endorses the chosen option.
				const z = -(alphaTrue * g.dSun + g.dShade) / SIM_PRIOR.tau;
				const pChooseA = 1 / (1 + Math.exp(-z));
				const choseA = Math.random() < pChooseA;
				// Reconstruct metre pairs realizing (dSun, dShade) with the
				// chosen option endorsed: option A carries the geometry, B is
				// the baseline; flip sides when the user chose B.
				const makeA = (dSun, dShade) => ({
					distanceM: 120,
					sunM: 30 + dSun * 100,
					treeM: 0,
					shadeM: 80 + dShade * 100,
				});
				const base = { distanceM: 120, sunM: 30, treeM: 0, shadeM: 80 };
				const a = choseA ? makeA(g.dSun, g.dShade) : base;
				const b = choseA ? base : makeA(-g.dSun, -g.dShade);
				picks.push(choseA ? { chosen: a, rejected: [b] } : { chosen: b, rejected: [a] });
				const alphaFit = fitAlphaMap(SIM_PRIOR, picks);
				const within = Math.abs(alphaFit - alphaTrue) <= 0.2 * alphaTrue;
				if (within && lastWithin === t - 1 && t + 1 >= 3 && recovered === null) {
					recovered = t + 1;
				}
				if (!within) lastWithin = -1;
				else if (lastWithin === t - 1 || within) lastWithin = t;
				else lastWithin = t;
				// "stays there for the rest" is checked after the loop.
				if (!within) {
					recovered = null;
				}
			}
			// End-of-history check: α̂ within band at the last pick.
			const alphaFinal = fitAlphaMap(SIM_PRIOR, picks);
			const ok =
				recovered !== null &&
				Math.abs(alphaFinal - alphaTrue) <= 0.2 * alphaTrue;
			if (ok) {
				recoveredCount += 1;
				atK.push(recovered);
			}
		}
		atK.sort((x, y) => x - y);
		const median = atK.length ? atK[Math.floor(atK.length / 2)] : null;
		console.log(
			`  α*=${alphaTrue.toFixed(1)}: recovered-and-held ${recoveredCount}/${N_SIM}` +
				(median ? `; median picks = ${median}` : "; median —"),
		);
	}
}
simulateRecovery();
