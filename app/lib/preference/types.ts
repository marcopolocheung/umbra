/**
 * S2a — learned shade preference, shared types.
 *
 * A "pick" is one observed route choice: the chosen Pareto option against the
 * rejected ones from the same request, each with its (distance, sun-exposure)
 * pair. Distance is the whole route length; sun is the metres of it the shadow
 * model leaves in the open (sun-lit), tree metres are tree-shaded, shade metres
 * are building-shaded. The three are additive: length = sun + tree + shade
 * within the tolerance the shadow sampler reports.
 */

/** One route option as the preference model sees it. Metres. */
export interface RouteOption {
	/** Total route length in metres. */
	distanceM: number;
	/** Metres in the open (no shade). */
	sunM: number;
	/** Metres under tree canopy. Credited at fraction ρ of full shade. */
	treeM: number;
	/** Metres in building shade. */
	shadeM: number;
}

/** One observed choice: `chosen` was picked over every entry of `rejected`. */
export interface Pick {
	chosen: RouteOption;
	rejected: RouteOption[];
}

/**
 * Population prior — the fitted Melnikov model. α (beta in the paper) is the
 * sun-aversion: how many metres of distance one metre of open sun is worth.
 * The hierarchical fit is carried by a Gamma shape/rate on α across the
 * population plus the fitted tree-shade factor ρ and temperature τ.
 */
export interface PopulationPrior {
	/** Gamma shape of the population distribution of α. */
	alphaShape: number;
	/** Gamma rate of the population distribution of α. */
	alphaRate: number;
	/** Tree-shade effectiveness ρ ∈ (0,1): fraction of full shade a tree gives. */
	rho: number;
	/** Choice temperature τ (logit scale, in 100 m units). */
	tau: number;
}

/**
 * Per-user fit: posterior mode of α with an uncertainty band.
 * `band` is the ±1σ (≈68%) credible band from the Laplace approximation;
 * `ci95` the wider band. `n` is the number of picks behind the fit.
 */
export interface PreferenceFit {
	/** Posterior mode of sun aversion α (metres of distance per metre of sun). */
	alpha: number;
	/** ±1σ band around `alpha` (Laplace approximation at the mode). */
	sigma: number;
	/** Number of observed picks behind the fit. */
	n: number;
}
