/** Versioned child execution selection. Async-local state never changes another launch. */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ChildExecution {
  version: 1;
  type: "orca-tui";
  coordinationRoot: string;
  parentJournal: string;
  todoExtension: string;
  statusExtension: string;
  /** Explicit Pi user directory, independent of the hook installation. */
  agentDir?: string;
}
const selection = new AsyncLocalStorage<ChildExecution | undefined>();
let runnerSelection: ChildExecution | undefined;
export function validateChildExecution(
  value: unknown,
): ChildExecution | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value as ChildExecution;
  if (v.version !== 1 || v.type !== "orca-tui")
    throw new Error(
      "Unsupported childExecution protocol (expected orca-tui v1).",
    );
  for (const key of [
    "coordinationRoot",
    "parentJournal",
    "todoExtension",
    "statusExtension",
  ] as const) {
    if (typeof v[key] !== "string" || !path.isAbsolute(v[key]))
      throw new Error(`childExecution.${key} must be an absolute path.`);
  }
  for (const file of [
    v.todoExtension,
    v.statusExtension,
    path.join(v.coordinationRoot, "mapping.json"),
  ]) {
    if (!fs.existsSync(file))
      throw new Error(`Orca TUI prerequisite is missing: ${file}`);
  }
  if (v.agentDir !== undefined && (typeof v.agentDir !== "string" || !path.isAbsolute(v.agentDir))) throw new Error("childExecution.agentDir must be an absolute path.");
  return Object.freeze({
    version: 1,
    type: "orca-tui",
    coordinationRoot: v.coordinationRoot,
    parentJournal: v.parentJournal,
    todoExtension: v.todoExtension,
    statusExtension: v.statusExtension,
    ...(v.agentDir ? { agentDir: v.agentDir } : {}),
  });
}
export function currentChildExecution(): ChildExecution | undefined {
  return selection.getStore() ?? runnerSelection;
}
export function setRunnerChildExecution(value: unknown): void {
  runnerSelection = validateChildExecution(value);
}
export function withChildExecution<T>(value: unknown, work: () => T): T {
  return selection.run(validateChildExecution(value), work);
}

/** Apply before the canonical tool-plan calculation, including ceilings and launch receipts. */
export function childExecutionRequirements<
  T extends {
    tools?: string[];
    excludeTools?: string[];
    extensions?: string[];
    subagentOnlyExtensions?: string[];
    capabilityCeiling?: any;
    inheritedCapabilityCeiling?: any;
  },
>(input: T): T {
  const mode = currentChildExecution();
  if (!mode) return input;
  for (const ceiling of [
    input.capabilityCeiling,
    input.inheritedCapabilityCeiling,
  ]) {
    if (
      ceiling?.denyExtensions ||
      (ceiling?.allowedTools && !ceiling.allowedTools.includes("todo"))
    )
      throw new Error(
        "orca-tui requires the todo extension and tool, but the capability ceiling denies them.",
      );
  }
  if (input.excludeTools?.includes("todo"))
    throw new Error(
      "orca-tui requires todo; excludeTools explicitly denies it.",
    );
  return {
    ...input,
    ...(input.tools ? { tools: [...new Set([...input.tools, "todo"])] } : {}),
    subagentOnlyExtensions: [
      ...new Set([
        ...(input.subagentOnlyExtensions ?? []),
        mode.todoExtension,
        mode.statusExtension,
      ]),
    ],
  };
}
