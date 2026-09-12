import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Offer only tools the child can actually use before it owns a Todo plan. */
export function registerTuiTodoPlan(api: ExtensionAPI): void {
  let ownTodoPlan = false;
  let workTools: string[] | undefined;

  const offerPlanningTools = () => {
    // Capture only the active, capability-filtered tools, never the registry.
    // Repeated starts while planning must not replace this with ["todo"].
    workTools ??= api.getActiveTools();
    api.setActiveTools(workTools.filter((name) => name === "todo"));
  };

  api.on("before_agent_start", (event) => {
    if (!ownTodoPlan) offerPlanningTools();
    return {
      systemPrompt: event.systemPrompt +
        "\n\nPi Bots visibility contract: This child owns its Todo plan. " +
        (!ownTodoPlan
          ? 'Your first tool call must be todo({action:"create",subject:"<one short task>"}). If parent todos were inherited, clear them with todo first. Only todo is available until create succeeds; do not batch a read or any work tool with that first call. '
          : "") +
        "Update the current item to in_progress before working and completed only after finishing it. Keep unfinished items truthful on interruption. The user can read and steer this exact session in its Pi TUI. Do not start another agent or change session identity to fulfil this task.",
    };
  });

  // Keep the execution guard for stale or invented calls even when their
  // schemas were not offered to the model. A failed create never opens it.
  api.on("tool_call", (event) => {
    if (ownTodoPlan) return;
    if (event.toolName !== "todo") return {
      block: true,
      reason: "Create a short plan for this child with todo before starting the assigned work.",
    };
    if (event.input?.action === "update") return {
      block: true,
      reason: "Create this child's own todo item first; inherited tasks are not its plan.",
    };
  });

  api.on("tool_result", (event) => {
    if (event.toolName !== "todo" || event.isError) return;
    if (event.input?.action === "create") {
      ownTodoPlan = true;
      if (workTools) {
        api.setActiveTools(workTools);
        workTools = undefined;
      }
    } else if (event.input?.action === "clear") {
      ownTodoPlan = false;
      offerPlanningTools();
    }
  });
}
