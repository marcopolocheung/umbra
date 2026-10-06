import type * as maplibregl from 'maplibre-gl';
import type { IShadowLayer } from './IShadowLayer';
import { LocalShadowAdapter } from './LocalShadowAdapter';

export interface ShadowLayerOptions {
  /** Initial date to render at */
  date: Date;
}

/**
 * Creates the local shadow layer.
 *
 * Previously this factory tried a remote shadow API first with a fallback to local.
 * Now it always returns the LocalShadowAdapter (custom WebGL renderer).
 */
export function createShadowLayer(
  _map: maplibregl.Map,
  options: ShadowLayerOptions,
): IShadowLayer {
  return new LocalShadowAdapter({ date: options.date });
}
