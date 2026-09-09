import * as path from "node:path";
import { readJson, connect } from "./protocol.mjs";
import type { TaskMutationVerdict } from "../runs/shared/llm-intent-arbiter.ts";
/** Run the upstream guard against the actual child's local model services. */
export async function arbitrateTuiTask(
  asyncDir: string,
  runId: string,
  index: number,
  task: string,
): Promise<TaskMutationVerdict> {
  const link = readJson(path.join(asyncDir, "tui", `child-${index}.json`)),
    host = link && readJson(link.manifest);
  if (!host || host.runId !== runId || host.index !== index)
    return "unavailable";
  const channel = await connect(link.manifest);
  try {
    return await channel.call("arbitrateTask", { text: task });
  } catch {
    return "unavailable";
  } finally {
    channel.close();
  }
}
