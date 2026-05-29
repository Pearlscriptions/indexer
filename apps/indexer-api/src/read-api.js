import { routeSnapshot } from "./indexer.js";
import { operatorMetadataDocument } from "./operator-metadata.js";
import {
  normalizeProtocolSnapshotForComparison,
  snapshotDigest,
  summarizeSnapshot
} from "./snapshot-compare.js";

export function createReadOnlyApi({
  getSnapshot,
  getStatus,
  storage = null,
  chain,
  manifestDigest,
  version = null,
  operatorMetadata = null,
  startedAt = new Date().toISOString()
}) {
  return async function handleReadOnlyRequest(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://indexer.local");
      if (request.method === "HEAD" && url.pathname === "/") {
        return sendEmpty(response, 200, cacheHeaders("live"));
      }
      if (request.method !== "GET") {
        return sendJson(response, 405, {
          ok: false,
          error: "METHOD_NOT_ALLOWED",
          message: "This public indexer serves read-only GET requests."
        });
      }

      if (url.pathname === "/") {
        return sendJson(response, 200, {
          ok: true,
          service: "pearlscriptions-indexer",
          chain,
          version,
          readOnly: true,
          message: "Read-only Pearlscriptions indexer API.",
          endpoints: {
            health: "/health",
            status: "/indexer/status",
            digest: "/indexer/digest",
            operator: "/operator",
            wellKnown: "/.well-known/pearlscriptions-indexer.json",
            tokens: "/tokens",
            operations: "/operations",
            inscriptions: "/inscriptions"
          }
        }, cacheHeaders("live"));
      }

      if (url.pathname === "/health") {
        const status = sanitizeStatus(await getStatus());
        return sendJson(response, 200, {
          ok: true,
          service: "pearlscriptions-indexer",
          chain,
          version,
          readOnly: true,
          startedAt,
          indexer: status
        }, cacheHeaders("live"));
      }

      if (url.pathname === "/indexer/status") {
        return sendJson(response, 200, sanitizeStatus(await getStatus()), cacheHeaders("live"));
      }

      if (url.pathname === "/indexer/digest") {
        const publishedDigest = await readPublishedDigest(storage, { chain, manifestDigest });
        if (publishedDigest) {
          return sendJson(response, 200, publishedDigest, cacheHeaders("live"));
        }
        const snapshot = await getSnapshot();
        const normalized = normalizeProtocolSnapshotForComparison(snapshot);
        return sendJson(response, 200, {
          chain: snapshot?.network?.chain ?? chain,
          indexedHeight: snapshot?.network?.indexedHeight ?? snapshot?.network?.bestHeight ?? null,
          indexedHash: snapshot?.network?.indexedHash ?? null,
          snapshotDigest: snapshotDigest(normalized),
          releaseManifestDigest: manifestDigest,
          summary: summarizeSnapshot(normalized)
        }, cacheHeaders("live"));
      }

      if (url.pathname === "/operator" || url.pathname === "/.well-known/pearlscriptions-indexer.json") {
        return sendJson(
          response,
          200,
          operatorMetadataDocument(operatorMetadata, { chain, version }),
          cacheHeaders("live")
        );
      }

      const readModelResponse = await routeReadModel(storage, url);
      if (readModelResponse) {
        return sendJson(response, readModelResponse.status, readModelResponse.body, cacheHeaders("short"));
      }

      const snapshot = await getSnapshot();
      const routed = routeSnapshot(snapshot, "GET", url);
      return sendJson(response, routed.status, routed.body, cacheHeaders(routed.status === 200 ? "short" : "none"));
    } catch (error) {
      return sendJson(response, 500, {
        ok: false,
        error: "INDEXER_INTERNAL_ERROR",
        message: process.env.NODE_ENV === "development" ? error.message : "Internal indexer error"
      });
    }
  };
}

async function routeReadModel(storage, url) {
  if (!storage) {
    return null;
  }
  if (url.pathname === "/inscriptions" && typeof storage.listInscriptionsPage === "function") {
    return json(200, await storage.listInscriptionsPage(url.searchParams));
  }
  const addressInscriptions = url.pathname.match(/^\/addresses\/([^/]+)\/inscriptions$/);
  if (addressInscriptions && typeof storage.listAddressInscriptionsPage === "function") {
    return json(
      200,
      await storage.listAddressInscriptionsPage(decodeURIComponent(addressInscriptions[1]), url.searchParams)
    );
  }
  const addressUtxos = url.pathname.match(/^\/addresses\/([^/]+)\/utxos$/);
  if (addressUtxos && typeof storage.listAddressUtxos === "function") {
    return json(200, await storage.listAddressUtxos(decodeURIComponent(addressUtxos[1]), url.searchParams));
  }
  return null;
}

async function readPublishedDigest(storage, { chain, manifestDigest }) {
  if (!storage || typeof storage.readSnapshotNetworkMetadata !== "function") {
    return null;
  }
  const network = await storage.readSnapshotNetworkMetadata();
  if (!network?.protocolSnapshotDigest || !network?.protocolSummary) {
    return null;
  }
  return {
    chain: network.chain ?? chain,
    indexedHeight: network.indexedHeight ?? null,
    indexedHash: network.indexedHash ?? null,
    snapshotDigest: network.protocolSnapshotDigest,
    releaseManifestDigest: manifestDigest,
    summary: network.protocolSummary
  };
}


function sanitizeStatus(status) {
  const cleaned = structuredClone(status ?? {});
  delete cleaned.storeDir;
  if (cleaned.storage) {
    delete cleaned.storage.storeDir;
  }
  return cleaned;
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(body));
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, {
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end();
}

function json(status, body) {
  return { status, body };
}

function cacheHeaders(mode) {
  if (mode === "live") {
    return { "cache-control": "no-store" };
  }
  if (mode === "short") {
    return { "cache-control": "public, max-age=5, stale-while-revalidate=30" };
  }
  return { "cache-control": "no-store" };
}
