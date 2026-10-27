import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assertFleetProjectAllowed as assertReserved, getReservedProjectIds } from "./fleet-reserved-projects";

/** Blocks fleet bots from owning or joining operator-reserved coordination projects. */
export function assertFleetProjectAllowed(bb: BbPluginApi, project: { id: string }, action: "own" | "bind") {
  assertReserved(project.id, getReservedProjectIds(bb), action);
}
