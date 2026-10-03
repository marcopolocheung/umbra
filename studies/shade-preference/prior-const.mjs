/**
 * S2a — the shipped prior constants, mirrored from
 * app/lib/preference/prior.ts (copied, not imported — the studies contract:
 * a study may import from `app/`, but this constant is the one number both
 * sides must stay in sync on, and a literal copy makes drift loud in review
 * rather than silent through a shared module).
 */
export const POPULATION_PRIOR_SRC = {
	alphaShape: 9.14,
	alphaRate: 7.587,
	rho: 0.414,
	tau: 0.229,
};
