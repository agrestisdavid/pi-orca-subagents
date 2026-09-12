import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJson,
  bridgeStatus,
  recoverWorkflowAdapters,
  terminalPaneKey,
} from "./orca-bridge.mjs";
import { command } from "./orca-adapter.mjs";
import {stopOnTabClose,settingsFile} from './settings.mjs';
import {
  connect,
  atomicJson,
} from "../../../src/tui-host/protocol.mjs";

export function nativeTuiChildren(run) {
  const dir = path.join(run.coordinationRoot || "", "children");
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => name.startsWith("native-") && name.endsWith(".json"))
        .map((name) => readJson(path.join(dir, name)))
        .filter(Boolean)
    : [];
}

export async function cleanupTuiViews(run, close = false) {
  const status = readJson(path.join(run.asyncDir, "status.json"));
  if (!status || status.runId !== run.runId)
    throw Error("Native run identity is unavailable for view cleanup.");
  const mapping = readJson(path.join(run.coordinationRoot, "mapping.json"));
  const listed = await command(mapping.exe, [
    "terminal",
    "list",
    "--worktree",
    `path:${status.cwd}`,
    "--json",
  ]);
  if (!listed.ok)
    throw Error("Orca could not verify the owned terminal views.");
  const current = listed.data.result.terminals.map((t) => ({
      ...t,
      paneKey: terminalPaneKey(t),
    })),
    views = [];
  const workflowSettled = Boolean(readJson(path.join(run.coordinationRoot, "health.json"))?.done);
  for (let index = 0; index < (status.steps?.length || 0); index++) {
    const link = readJson(
      path.join(run.asyncDir, "tui", `child-${index}.json`),
    );
    if (!link) continue;
    const host = readJson(link.manifest);
    if (!host?.view) continue;
    const found = current.find((t) => t.handle === host.view.handle);
    if (!found) continue;
    if (found.paneKey !== host.view.paneKey || found.tabId !== host.view.tabId)
      throw Error("The recorded TUI terminal identity no longer matches Orca.");
    views.push({
      index,
      handle: found.handle,
      tabId: found.tabId,
      paneKey: found.paneKey,
      sessionId: host.sessionId,
      sharedDispatch: mapping.tuiViewPolicy === "dispatch-first" && found.paneKey === mapping.worker.terminal.paneKey,
    });
  }
  const stopEnabled = stopOnTabClose(mapping.piBotsSettingsFile || settingsFile);
  const cancelsDispatch = !workflowSettled && views.some(view => view.sharedDispatch);
  if (close)
    for (const view of views) {
      const result = await command(mapping.exe, [
        "terminal",
        "close",
        "--terminal",
        view.handle,
        "--json",
      ]);
      if (!result.ok)
        throw Error("Orca did not confirm closure of " + view.handle);
    }
  if (close && views.length) {
    const after = await command(mapping.exe, [
      "terminal",
      "list",
      "--worktree",
      `path:${status.cwd}`,
      "--json",
    ]);
    if (
      !after.ok ||
      views.some((view) =>
        after.data.result.terminals.some((t) => t.handle === view.handle),
      )
    )
      throw Error(
        "TUI view closure remains unconfirmed; inspect the native tab-close receipts.",
      );
  }
  return {
    runId: run.runId,
    safeToClose: true,
    cleanupNeeded: views.length > 0,
    views,
    stopOnTabClose:stopEnabled,
    cancelsDispatch,
    ...(close ? { closed: views.length, nativeStop:stopEnabled?'pending native confirmation':'disabled' } : {}),
  };
}

export async function syncTuiViews(run, status, signal) {
  const results = [];
  let adapterError;
  if (run.syncMissing && run.coordinationRoot)
    try {
      await recoverWorkflowAdapters(run.coordinationRoot);
    } catch (error) {
      adapterError = String(error.message || error);
    }
  for (let index = 0; index < (status.steps?.length || 0); index++) {
    if (signal?.aborted) break;
    const pointer = path.join(run.asyncDir, "tui", `child-${index}.json`);
    let link = readJson(pointer);
    if (!link) {
      const step = status.steps[index];
      const candidates = nativeTuiChildren(run).filter(
        (child) =>
          child.runId === step.runId ||
          (child.sessionFile && child.sessionFile === step.sessionFile),
      );
      if (candidates.length === 1) {
        link = candidates[0];
        atomicJson(pointer, link);
      }
    }
    if (!link) continue;
    let host = readJson(link.manifest);
    if (!host) continue;
    if (run.syncMissing && host.viewState !== "attached" && !host.tabClose?.stop) {
      const channel = await connect(link.manifest);
      try {
        await channel.call("openView");
      } finally {
        channel.close();
      }
      host = readJson(link.manifest);
    }
    if (host.view?.handle) run.published.add(index);
    const originalWorkerPane = run.coordinationRoot && readJson(path.join(run.coordinationRoot, "mapping.json"))?.worker?.terminal?.paneKey;
    const inDispatchPane = host.dispatchView && host.view?.paneKey === originalWorkerPane;
    if (run.coordinationRoot) {
      const file = path.join(
        run.coordinationRoot,
        "children",
        `${run.runId}-${index}.json`,
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicJson(file, {
        runId: run.runId,
        index,
        nativeRunId: host.runId,
        nativeIndex: host.index,
        agent: host.agent,
        manifest: link.manifest,
        sessionId: host.sessionId,
        sessionFile: host.sessionFile,
        terminal: host.view,
      });
    }
    if (
      run.viewMode === "both" &&
      !readJson(path.join(path.dirname(link.manifest), "herdr-view.json"))
    ) {
      const ps = path.join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      const result = await command(ps, [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./Publish-PiBotView.ps1", import.meta.url)),
        "-RunId",
        run.runId,
        "-AsyncDir",
        run.asyncDir,
        "-ChildIndex",
        String(index),
        "-Title",
        `${run.titlePrefix} ${host.agent}`,
        "-NoOrca",
      ]);
      fs.writeFileSync(
        path.join(path.dirname(link.manifest), "herdr-view.json"),
        JSON.stringify(result),
      );
    }
    results.push({
      index,
      exitCode: host.error ? 1 : 0,
      json: {
        summary: `Real Pi TUI · ${host.state} · ${host.viewState} · session ${host.sessionId || "initializing"}${inDispatchPane ? " · shared dispatch pane" : host.dispatchView ? " · original Orca dispatch pane closed" : ""}${host.tabClose?.stop ? ' · native stop requested by tab close' : ''}${host.tabCloseError ? ' · '+host.tabCloseError : ''}`,
        host: {
          state: host.state,
          sessionId: host.sessionId,
          sessionFile: host.sessionFile,
          view: host.view,
          manifest: link.manifest,
        },
      },
      error: host.error,
    });
  }
  run.syncMissing = false;
  return {
    runId: run.runId,
    state: status.state,
    execution: "orca-tui",
    published: [...run.published],
    results,
    ...(run.coordinationRoot
      ? {
          coordination: {
            ...bridgeStatus(run.coordinationRoot),
            ...(adapterError ? { restoreError: adapterError } : {}),
          },
        }
      : {}),
  };
}
