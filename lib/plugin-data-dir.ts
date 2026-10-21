import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export function pluginDataDirectory(bb: BbPluginApi, pluginId: string) {
  return join(bb.server.experimental_dataDir, "plugins", pluginId);
}
