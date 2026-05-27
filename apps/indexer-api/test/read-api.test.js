import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPublicIndexerConfig } from "../src/config.js";
import { createReadOnlyApi } from "../src/read-api.js";
import { createPublicIndexerRuntime } from "../src/server.js";

test("config loader reads local env files without overriding explicit environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pearlscriptions-env-test-"));
  const envFilePath = join(dir, ".env");
  await writeFile(
    envFilePath,
    [
      "HOST=0.0.0.0",
      "PORT=3911",
      "PRL20_CHAIN=pearl-simnet",
      "PRL20_INDEXER_BACKGROUND_SYNC_MS=0",
      "PEARL_RPC_URL="
    ].join("\n")
  );

  const config = loadPublicIndexerConfig(undefined, { envFilePath });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 3911);
  assert.equal(config.chain, "pearl-simnet");
  assert.equal(config.backgroundSyncMs, 0);

  const explicit = loadPublicIndexerConfig(
    {
      HOST: "127.0.0.1",
      PORT: "3001",
      PRL20_CHAIN: "pearl-simnet"
    },
    { envFilePath }
  );
  assert.equal(explicit.host, "127.0.0.1");
  assert.equal(explicit.port, 3001);
});

test("config loader resolves the root release manifest from workspace scripts", () => {
  const config = loadPublicIndexerConfig({});

  assert.equal(config.chain, "pearl-mainnet");
  assert.equal(
    config.mintFeePolicy.address,
    "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea"
  );
  assert.equal(
    config.mintFeePolicy.scriptPubKey,
    "51200effd3c4e44fd3886e8c1ebe943138fa6a944e21e4bbe7e2d9ab800b7f4c4ffa"
  );
});

test("public read API exposes health and digest without opening mutation methods", async () => {
  const config = loadPublicIndexerConfig({
    PRL20_CHAIN: "pearl-simnet",
    PRL20_INDEXER_SYNC_ON_START: "0"
  });
  const runtime = await createPublicIndexerRuntime(config);
  const handler = createReadOnlyApi({
    getSnapshot: runtime.getSnapshot,
    getStatus: runtime.getStatus,
    storage: runtime.storage,
    chain: config.chain,
    manifestDigest: config.manifestDigest
  });

  const health = await invoke(handler, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.readOnly, true);
  assert.equal(health.body.indexer.mode, "fixture");
  assert.equal(health.body.indexer.storeDir, undefined);

  const digest = await invoke(handler, "GET", "/indexer/digest");
  assert.equal(digest.status, 200);
  assert.match(digest.body.snapshotDigest, /^[0-9a-f]{64}$/);
  assert.equal(digest.body.summary.mintCount, 2);
  assert.equal(Object.hasOwn(digest.body.summary, "marketListings"), false);
  assert.equal(Object.hasOwn(digest.body.summary, "activeMarketListings"), false);
  assert.equal(Object.hasOwn(digest.body.summary, "marketEvents"), false);

  const market = await invoke(handler, "GET", "/market/listings");
  assert.equal(market.status, 404);
  assert.equal(market.body.error, "NOT_FOUND");

  for (const [method, url] of [
    ["POST", "/health"],
    ["PUT", "/indexer/digest"],
    ["PATCH", "/addresses/prl1alice/balances"],
    ["DELETE", "/operations"]
  ]) {
    const blocked = await invoke(handler, method, url);
    assert.equal(blocked.status, 405);
    assert.equal(blocked.body.error, "METHOD_NOT_ALLOWED");
  }
});

function invoke(handler, method, url) {
  return new Promise((resolve, reject) => {
    const response = {
      status: null,
      headers: null,
      chunks: [],
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(chunk = "") {
        if (chunk) {
          this.chunks.push(Buffer.from(chunk));
        }
        try {
          resolve({
            status: this.status,
            headers: this.headers,
            body: JSON.parse(Buffer.concat(this.chunks).toString("utf8"))
          });
        } catch (error) {
          reject(error);
        }
      }
    };
    Promise.resolve(handler({ method, url }, response)).catch(reject);
  });
}
