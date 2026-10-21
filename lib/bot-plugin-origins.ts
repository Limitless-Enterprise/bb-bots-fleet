/** Upstream Bots Sidebar runtime id; kept for routing and pending-start handoff. */
export const BOTS_SIDEBAR_ORIGIN = "bots-sidebar";

/** Earlier private build id; bindings remain, but new explicit starts are not trusted. */
export const LEGACY_BOTS_ORIGIN = "bots";

/** Threads created by Bots Fleet or Bots Sidebar keep explicit-start routing semantics. */
export function isFleetPluginOrigin(originPluginId: string | null, pluginId: string): boolean {
  return originPluginId === pluginId || originPluginId === BOTS_SIDEBAR_ORIGIN;
}
