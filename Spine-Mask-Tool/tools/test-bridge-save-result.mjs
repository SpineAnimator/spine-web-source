import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("async function writeToEditor(epoch){");
const end = app.indexOf('$("bridge-refresh").addEventListener', start);
assert.ok(start >= 0 && end > start, "writeToEditor must remain a testable standalone function");
const implementation = app.slice(start, end);

async function invokeCommitResult(commitResult) {
  const context = {
    TextEncoder,
    JSON,
    state: {
      bridge: { session: "test-session" },
      result: { multi: true, json: { slots: [] } },
      json: { slots: [] }
    },
    bridgeStatusMessage: "",
    bridgeStatus(message) { this.bridgeStatusMessage = message; },
    async requestBridge(method) {
      if (method === "begin_result") return { stage: "test-stage" };
      if (method === "commit_result") {
        if (commitResult instanceof Error) throw commitResult;
        return commitResult;
      }
      throw new Error("Unexpected bridge method: " + method);
    },
    async writeBytesToHost() {},
    exportLocalEditorMask() { throw new Error("multi-mask path must not call single-mask export"); },
    selectedRegion() { return null }
  };
  const harness = `
    (async () => {
      let bridgeWriterBusy = false;
      let bridgeWriteEpoch = 1;
      const state = globalThis.state;
      const bridgeStatus = message => { globalThis.bridgeStatusMessage = message; };
      const requestBridge = (...args) => globalThis.requestBridge(...args);
      const writeBytesToHost = (...args) => globalThis.writeBytesToHost(...args);
      const exportLocalEditorMask = (...args) => globalThis.exportLocalEditorMask(...args);
      const selectedRegion = (...args) => globalThis.selectedRegion(...args);
      ${implementation}
      globalThis.writeResult = await writeToEditor(1);
    })()
  `;
  await vm.runInNewContext(harness, context);
  return { result: context.writeResult, status: context.bridgeStatusMessage, state: context.state };
}

const failed = await invokeCommitResult(new Error("Create failed: Spine Editor rejected the project"));
assert.equal(failed.result, false,
  "a rejected native commit must return failure to Make Mask");
assert.match(failed.status, /Create failed/,
  "the exact native editor failure must remain visible");
assert.equal(failed.state.editorOpenResult, false);

const saved = await invokeCommitResult({ saved: true, imported: true, opened: true, project: "scene-mask.spine" });
assert.equal(saved.result, true,
  "a confirmed native import and editor open must return success");
assert.equal(saved.state.editorOpenResult, true);
console.log("SPINE_MASK_BRIDGE_SAVE_RESULT_REGRESSION_PASS");
