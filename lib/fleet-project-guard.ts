/** Blocks fleet bots from owning or joining the reserved CTO coordination project. */
export function assertFleetProjectAllowed(project: { id: string; name: string }, action: "own" | "bind") {
  if (project.name.trim().toLowerCase() === "cto") {
    throw new Error(`Bots cannot ${action === "own" ? "own" : "bind to"} the CTO project`);
  }
}
