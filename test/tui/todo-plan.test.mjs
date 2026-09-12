import test from "node:test";
import assert from "node:assert/strict";
import { registerTuiTodoPlan } from "../../src/tui-host/todo-plan.ts";

function child(tools = ["read", "todo", "structured_output"]) {
  let active = [...tools];
  const handlers = new Map();
  registerTuiTodoPlan({
    on: (name, callback) => handlers.set(name, callback),
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active = [...names]; },
  });
  return {
    active: () => active,
    restrict: (names) => { active = [...names]; },
    start: () => handlers.get("before_agent_start")({ systemPrompt: "Task policy" }),
    call: (toolName, action) => handlers.get("tool_call")({ toolName, input: { action } }),
    result: (action, isError = false) => handlers.get("tool_result")({ toolName: "todo", input: { action }, isError }),
  };
}

test("a fresh child sees only Todo, then exactly its allowed work tools", () => {
  const c = child();
  c.start();
  assert.deepEqual(c.active(), ["todo"]);
  assert.equal(c.call("read").block, true);
  c.result("create");
  assert.deepEqual(c.active(), ["read", "todo", "structured_output"]);
  assert.equal(c.call("read"), undefined);
  assert(!c.active().includes("write"));
  c.start();
  assert.deepEqual(c.active(), ["read", "todo", "structured_output"]);
});

test("failed creation and inherited plan access never unlock work", () => {
  const c = child();
  c.start();
  c.result("create", true);
  c.result("list");
  assert.equal(c.call("todo", "update").block, true);
  assert.equal(c.call("read").block, true);
  assert.deepEqual(c.active(), ["todo"]);
  c.result("clear");
  c.start();
  c.result("create");
  assert.deepEqual(c.active(), ["read", "todo", "structured_output"]);
});

test("clearing a plan closes the gate and preserves the current restricted tools", () => {
  const c = child();
  c.start();
  c.result("create");
  c.restrict(["todo", "read"]);
  c.result("clear", true);
  assert.deepEqual(c.active(), ["todo", "read"]);
  c.result("clear");
  assert.deepEqual(c.active(), ["todo"]);
  assert.equal(c.call("read").block, true);
  c.result("create");
  assert.deepEqual(c.active(), ["todo", "read"]);
});

test("the planning gate never enables a Todo denied by capabilities", () => {
  const c = child(["read"]);
  c.start();
  assert.deepEqual(c.active(), []);
  assert.equal(c.call("read").block, true);
});
