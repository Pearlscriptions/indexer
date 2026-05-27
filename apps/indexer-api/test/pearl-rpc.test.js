import assert from "node:assert/strict";
import test from "node:test";
import { createPearlRpcClient } from "../src/pearl-rpc.js";

test("Pearl RPC client retries transient HTTP failures", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) {
      return new Response("busy", { status: 503 });
    }
    return Response.json({ result: "block-hash" });
  };

  try {
    const rpc = createPearlRpcClient({
      url: "http://127.0.0.1:44107",
      retries: 2,
      retryDelayMs: 0
    });

    assert.equal(await rpc("getblockhash", [1]), "block-hash");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].id, calls[1].id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pearl RPC client does not retry JSON-RPC protocol errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      error: {
        code: -8,
        message: "Block height out of range"
      }
    });
  };

  try {
    const rpc = createPearlRpcClient({
      url: "http://127.0.0.1:44107",
      retries: 2,
      retryDelayMs: 0
    });

    await assert.rejects(() => rpc("getblockhash", [-1]), /Block height out of range/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
