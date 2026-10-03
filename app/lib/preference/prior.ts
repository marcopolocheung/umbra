/**
 * S2a — the fitted population prior, the one constant this module ships.
 *
 * Refit of Melnikov et al., *Scientific Reports* 2022 (46 participants, 408
 * Treatment>0 choices, OSF aj4vk) as a hierarchical logit, by
 * `studies/shade-preference/refit.mjs` (marginal-likelihood MAP with β
 * integrated out; see `docs/notes/shade-preference.md` for the method and
 * the reproduce command). α is metres of distance per metre of open sun.
 *
 * β̄ = shape/rate = 9.140/7.587 = 1.205 (paper: ≈ 1.16), ρ = 0.414 (tree
 * shade at 41% of building shade; ROADMAP §5c's ≈ 0.5), τ = 0.229 (logit
 * scale, 100 m units). Until real Umbra picks exist, this prior — 46
 * Singaporeans in a courtyard — is the whole model; see the note for the
 * domain-shift caveat.
 */
import type { PopulationPrior } from "./types";

export const POPULATION_PRIOR: PopulationPrior = {
	alphaShape: 9.14,
	alphaRate: 7.587,
	rho: 0.414,
	tau: 0.229,
};
