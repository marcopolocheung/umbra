/**
 * S2a study-internal shared machinery (refit + eval import it; nothing ships).
 * The studies contract forbids sharing modules with shipped code — this is
 * shared between two studies in the same folder, which is exactly the allowed
 * direction. app/lib/preference/model.ts carries its own copy on purpose.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const SCALE = 100; // 100 m units, as the notebook's `scaling = 0.01`

/** OSF aj4vk behavioural_data.csv — public download, cached once.
 * sha256 9ae281d97090040d42dbff5ab812cd8a2658f42a9b353b26b08c10fa75927950.
 * Not committed: the OSF component carries no explicit licence and the file
 * is individual-level human behavioural data (see the note's data section).
 */
const OSF_DATA_URL =
	"https://files.au-1.osf.io/v1/resources/aj4vk/providers/osfstorage/6062415a22950302206ea460";
const CACHE_PATH = "node_modules/.cache/umbra-shade-preference/behavioural_data.csv";

async function fetchCached() {
	if (!existsSync(CACHE_PATH)) {
		mkdirSync(CACHE_PATH.slice(0, CACHE_PATH.lastIndexOf("/")), {
			recursive: true,
		});
		const res = await fetch(OSF_DATA_URL);
		if (!res.ok) {
			throw new Error(`OSF download failed: ${res.status} ${OSF_DATA_URL}`);
		}
		writeFileSync(CACHE_PATH, await res.text());
	}
	return readFileSync(CACHE_PATH, "utf8");
}

export function parseCsvText(text) {
	const trimmed = text.trim();
	const lines = trimmed.split(/\r?\n/);
	const header = lines[0].split(",");
	return lines.slice(1).map((line) => {
		const cells = line.split(",");
		const row = {};
		header.forEach((h, i) => {
			row[h] = cells[i];
		});
		return row;
	});
}

/** The notebook's model dataset: Treatment > 0 rows, Choice_indicator = 1 − B_chosen. */
export async function loadModelRows() {
	const text = await fetchCached();
	const all = parseCsvText(text);
	return all
		.filter((r) => Number(r.Treatment) > 0)
		.map((r) => ({ ...r, y: 1 - Number(r.B_chosen) }));
}

export function logGamma(x) {
	if (x < 0.5) {
		return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
	}
	x -= 1;
	const g = [
		676.5203681218851, -1259.1392167224028, 771.32342877765313,
		-176.61502916214059, 12.507343278686905, -0.13857109526772012,
		9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	let a = 0.99999999999980993;
	const t = x + 7.5;
	for (let i = 1; i <= 8; i++) {
		a += g[i - 1] / (x + i);
	}
	return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Gauss–Legendre nodes on [lo, hi], both symmetric halves (see refit.mjs).
export function gaussLegendre(n, lo, hi) {
	const nodes = [];
	const weights = [];
	const m = Math.floor((n + 1) / 2);
	for (let i = 1; i <= m; i++) {
		let x = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
		let p0 = 1;
		let p1 = x;
		let dp = 1;
		for (let iter = 0; iter < 100; iter++) {
			p0 = 1;
			p1 = x;
			for (let k = 2; k <= n; k++) {
				const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k;
				p0 = p1;
				p1 = p2;
			}
			dp = (n * (x * p1 - p0)) / (x * x - 1);
			const dx = -p1 / dp;
			x += dx;
			if (Math.abs(dx) < 1e-14) break;
		}
		const w = 2 / ((1 - x * x) * dp * dp);
		nodes.push(((hi - lo) * x + (hi + lo)) / 2);
		weights.push(((hi - lo) * w) / 2);
		if (Math.abs(x) > 1e-14) {
			nodes.push(((hi - lo) * -x + (hi + lo)) / 2);
			weights.push(((hi - lo) * w) / 2);
		}
	}
	return { nodes, weights };
}

// A trial's A-minus-B effective diffs (100 m units) at a given ρ.
export function trialDiffs(row, rho) {
	const dSun =
		(Number(row.A_sun_length) + (1 - rho) * Number(row.A_tree_length) -
			Number(row.B_sun_length) - (1 - rho) * Number(row.B_tree_length)) / SCALE;
	const dShade =
		(Number(row.A_shade_length) + rho * Number(row.A_tree_length) -
			Number(row.B_shade_length) - rho * Number(row.B_tree_length)) / SCALE;
	return { dSun, dShade };
}

function logAdd(a, b) {
	if (a === Number.NEGATIVE_INFINITY) return b;
	if (b === Number.NEGATIVE_INFINITY) return a;
	const m = Math.max(a, b);
	return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/**
 * Marginal log-likelihood of one participant's rows with β integrated out
 * over the Gamma(shape, rate) grid; plus E[β] under the same posterior.
 * rows: the participant's own rows only. trialDiffsFn precomputes per-row
 * diffs once per (ρ) — pass dSun/dShade arrays to avoid re-deriving.
 */
export function marginalParticipant(rowsOfJ, dSun, dShade, y, a, b, rho, tau, GL) {
	const lGammaBeta = a * Math.log(b) - logGamma(a);
	let m0 = Number.NEGATIVE_INFINITY;
	let m1 = Number.NEGATIVE_INFINITY;
	for (let q = 0; q < GL.nodes.length; q++) {
		const beta = GL.nodes[q];
		let lp = lGammaBeta + (a - 1) * Math.log(beta) - b * beta;
		for (let i = 0; i < rowsOfJ.length; i++) {
			const z = -(beta * dSun[i] + dShade[i]) / tau;
			lp += y[i] === 1 ? -Math.log1p(Math.exp(-z)) : -Math.log1p(Math.exp(z));
		}
		const lw = Math.log(GL.weights[q]) + lp;
		m0 = logAdd(m0, lw);
		m1 = logAdd(m1, lw + Math.log(beta));
	}
	return { logM: m0, eBeta: Math.exp(m1 - m0) };
}

export function nelderMead(f, x0, step, iters) {
	const n = x0.length;
	let simplex = [x0.slice()];
	for (let i = 0; i < n; i++) {
		const p = x0.slice();
		p[i] += step[i];
		simplex.push(p);
	}
	let values = simplex.map(f);
	for (let it = 0; it < iters; it++) {
		const order = simplex.map((_, i) => i).sort((p, q) => values[p] - values[q]);
		simplex = order.map((i) => simplex[i]);
		values = order.map((i) => values[i]);
		const centroid = new Array(n).fill(0);
		for (let i = 0; i < n; i++) {
			for (let d = 0; d < n; d++) {
				centroid[d] += simplex[i][d] / n;
			}
		}
		const worst = simplex[n];
		const reflected = centroid.map((c, d) => c + (c - worst[d]));
		const fr = f(reflected);
		if (fr < values[0]) {
			const expanded = centroid.map((c, d) => c + 2 * (c - worst[d]));
			const fe = f(expanded);
			if (fe < fr) {
				simplex[n] = expanded;
				values[n] = fe;
			} else {
				simplex[n] = reflected;
				values[n] = fr;
			}
		} else if (fr < values[n - 1]) {
			simplex[n] = reflected;
			values[n] = fr;
		} else {
			const contracted = centroid.map((c, d) => c + 0.5 * (worst[d] - c));
			const fc = f(contracted);
			if (fc < values[n]) {
				simplex[n] = contracted;
				values[n] = fc;
			} else {
				for (let i = 1; i <= n; i++) {
					for (let d = 0; d < n; d++) {
						simplex[i][d] = (simplex[i][d] + simplex[0][d]) / 2;
					}
					values[i] = f(simplex[i]);
				}
			}
		}
		const spread = Math.max(...values) - Math.min(...values);
		if (spread < 1e-7) break;
	}
	let best = 0;
	for (let i = 1; i <= n; i++) {
		if (values[i] < values[best]) best = i;
	}
	return { x: simplex[best], f: values[best] };
}

/**
 * Fit the hierarchical hyperparameters (a, b, ρ, τ) on a set of rows, grouped
 * by participant — the joint log-posterior MAP (marginal likelihood + the
 * notebook's hyperpriors; see refit.mjs for why the hyperpriors are part of
 * the objective). Returns the fitted prior plus per-participant E[β_j].
 */
export function fitHierarchical(rowsByParticipant) {
	const GL = gaussLegendre(160, 0.02, 6);
	const names = Object.keys(rowsByParticipant);
	const groups = names.map((name) => {
		const rs = rowsByParticipant[name];
		return {
			name,
			rs,
			y: rs.map((r) => r.y),
		};
	});
	const joint = (a, b, rho, tau) => {
		let ll = 0;
		for (const g of groups) {
			const dSun = g.rs.map((r) => trialDiffs(r, rho).dSun);
			const dShade = g.rs.map((r) => trialDiffs(r, rho).dShade);
			const { logM } = marginalParticipant(g.rs, dSun, dShade, g.y, a, b, rho, tau, GL);
			if (!Number.isFinite(logM)) return Number.NEGATIVE_INFINITY;
			ll += logM;
		}
		const h1 = (Math.log(a) + Math.log(b)) / 2;
		const h2 = (Math.log(a) - Math.log(b)) / 2;
		const lpA = -(h1 * h1 + h2 * h2) / 2 - Math.log(2 * Math.PI);
		const lpTau = 12.5 * Math.log(50) - logGamma(12.5) + 11.5 * Math.log(tau) - 50 * tau;
		return ll + lpA + lpTau;
	};
	const fit = nelderMead(
		(x) => {
			const a = Math.exp(x[0]);
			const b = Math.exp(x[1]);
			const rho = 1 / (1 + Math.exp(-x[2]));
			const tau = Math.exp(x[3]);
			if (a < 0.3 || a > 40 || b < 0.2 || b > 40) return Number.POSITIVE_INFINITY;
			if (tau < 0.05 || tau > 5) return Number.POSITIVE_INFINITY;
			return -joint(a, b, rho, tau);
		},
		[Math.log(2), Math.log(1.7), 0, Math.log(0.5)],
		[0.3, 0.3, 0.2, 0.2],
		400,
	);
	const a = Math.exp(fit.x[0]);
	const b = Math.exp(fit.x[1]);
	const rho = 1 / (1 + Math.exp(-fit.x[2]));
	const tau = Math.exp(fit.x[3]);
	const prior = { alphaShape: a, alphaRate: b, rho, tau };
	const eBeta = {};
	for (const g of groups) {
		const dSun = g.rs.map((r) => trialDiffs(r, rho).dSun);
		const dShade = g.rs.map((r) => trialDiffs(r, rho).dShade);
		eBeta[g.name] = marginalParticipant(g.rs, dSun, dShade, g.y, a, b, rho, tau, GL).eBeta;
	}
	return { prior, eBeta, jointLogPosterior: -fit.f };
}

/**
 * Browser-shaped MAP update (mirrors app/lib/preference/model.ts): fit α for
 * one user from Pick-shaped data against a prior. `initialAlpha` warm-starts.
 */
export function effSun(o, rho) {
	return o.sunM + (1 - rho) * o.treeM;
}
export function effShade(o, rho) {
	return o.shadeM + rho * o.treeM;
}

export function pickLLGrad(pick, alpha, prior) {
	let ll = 0;
	let grad = 0;
	for (const rejected of pick.rejected) {
		const dSun = (effSun(pick.chosen, prior.rho) - effSun(rejected, prior.rho)) / SCALE;
		const dShade =
			(effShade(pick.chosen, prior.rho) - effShade(rejected, prior.rho)) / SCALE;
		const z = -(alpha * dSun + dShade) / prior.tau;
		ll += z >= 0 ? -Math.log1p(Math.exp(-z)) : z - Math.log1p(Math.exp(z));
		// d/dα log σ(z) = σ(−z)·(−dSun/τ); σ(−z) = 1/(1+e^{z}).
		const pNotChoose = 1 / (1 + Math.exp(z));
		grad -= (pNotChoose * dSun) / prior.tau;
	}
	return [ll, grad];
}

export function fitAlphaMap(prior, picks, initialAlpha) {
	const mode = (prior.alphaShape - 1) / prior.alphaRate;
	const obj = (alpha) => {
		let ll = 0;
		let grad = 0;
		for (const pick of picks) {
			const [l, g] = pickLLGrad(pick, alpha, prior);
			ll += l;
			grad += g;
		}
		const lp =
			prior.alphaShape * Math.log(prior.alphaRate) - logGamma(prior.alphaShape) +
			(prior.alphaShape - 1) * Math.log(alpha) - prior.alphaRate * alpha;
		return [ll + lp, grad + (prior.alphaShape - 1) / alpha - prior.alphaRate];
	};
	let logAlpha = Math.log(Math.max(initialAlpha ?? mode, 1e-3));
	let step = 0.5;
	for (let i = 0; i < 200; i++) {
		const alpha = Math.exp(logAlpha);
		const [f, df] = obj(alpha);
		const gLog = alpha * df;
		if (Math.abs(gLog) < 1e-8) break;
		let moved = false;
		for (let t = 0; t < 20; t++) {
			const trial = Math.exp(logAlpha + step * gLog);
			const [fT] = obj(trial);
			if (fT >= f + 1e-12) {
				logAlpha += step * gLog;
				step = Math.min(step * 1.5, 0.5);
				moved = true;
				break;
			}
			step *= 0.5;
		}
		if (!moved || step < 1e-10) break;
	}
	return Math.exp(logAlpha);
}

/** P(recorded chosen option beats the rejected one) under α. */
export function chooseProb(pick, alpha, prior) {
	const dSun = (effSun(pick.chosen, prior.rho) - effSun(pick.rejected[0], prior.rho)) / SCALE;
	const dShade =
		(effShade(pick.chosen, prior.rho) - effShade(pick.rejected[0], prior.rho)) / SCALE;
	const z = -(alpha * dSun + dShade) / prior.tau;
	return 1 / (1 + Math.exp(-z));
}

/** Trial → Pick, in the shipped shape; `flip` endorses the other option. */
export function trialToPick(row, flip) {
	const a = {
		distanceM: Number(row.A_length),
		sunM: Number(row.A_sun_length),
		treeM: Number(row.A_tree_length),
		shadeM: Number(row.A_shade_length),
	};
	const b = {
		distanceM: Number(row.B_length),
		sunM: Number(row.B_sun_length),
		treeM: Number(row.B_tree_length),
		shadeM: Number(row.B_shade_length),
	};
	const chooseA = row.y === 1 ? !flip : !!flip;
	return chooseA ? { chosen: a, rejected: [b] } : { chosen: b, rejected: [a] };
}
