import { FleetBus } from './fleet-bus.js';

/**
 * A no-op FleetBus that discards all events. Used when no real fleet
 * bus is available (non-director mode) so the runner's `fleetBus`
 * field is always valid and the `attach()` call is always safe.
 *
 * One singleton instance is sufficient — it has no state to reset.
 */
export const NULL_FLEET_BUS = new FleetBus();
