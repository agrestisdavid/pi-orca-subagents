// The dispatch pane presents actual Pi terminal bytes. Its protocol adapter
// remains a separate process and never reads terminal input intended for Pi.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, atomicJson } from "../../../src/tui-host/protocol.mjs";

export async function serveDispatchTui(dir) {
  const root = path.dirname(dir);
  const entry = fileURLToPath(new URL("../../../src/tui-host/attach.mjs", import.meta.url));
  let attachment, manifest;
  process.stdout.write("Pi wird vorbereitet …\r\n");
  while (!fs.existsSync(path.join(dir, "exit"))) {
    const slot = readJson(path.join(root, "dispatch-tui.json"));
    const attachmentEnded = attachment && (attachment.exitCode !== null || attachment.signalCode !== null);
    if (slot?.manifest && (slot.manifest !== manifest || attachmentEnded)) {
      const host = readJson(slot.manifest);
      if (host?.port && host?.token && !host.tabClose?.stop) {
        if (attachment && slot.manifest !== manifest) {
          const old = readJson(manifest);
          if (!old?.exitObservedAt) throw Error("The previous Pi writer is still live; dispatch TUI replacement blocked.");
          if (attachment.exitCode === null && attachment.signalCode === null) {
            const exited = new Promise(resolve => attachment.once("exit", resolve));
            attachment.kill();
            await exited;
          }
        }
        manifest = slot.manifest;
        attachment = spawn(process.execPath, [entry, manifest], {
          cwd: process.cwd(), env: process.env, windowsHide: true, stdio: "inherit",
        });
        atomicJson(path.join(dir, "tui-attachment.json"), {
          manifest, pid: attachment.pid, parentPid: process.pid,
          handle: process.env.ORCA_TERMINAL_HANDLE, startedAt: Date.now(),
        });
        attachment.on("error", error => process.stderr.write(String(error) + "\n"));
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  attachment?.kill();
}
