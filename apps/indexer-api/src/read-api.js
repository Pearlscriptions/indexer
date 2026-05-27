import { routeSnapshot } from "./indexer.js";
import { snapshotDigest, summarizeSnapshot } from "./snapshot-compare.js";

export function createReadOnlyApi({
  getSnapshot,
  getStatus,
  storage = null,
  chain,
  manifestDigest,
  startedAt = new Date().toISOString()
}) {
  return async function handleReadOnlyRequest(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://indexer.local");
      if (request.method !== "GET") {
        return sendJson(response, 405, {
          ok: false,
          error: "METHOD_NOT_ALLOWED",
          message: "This public indexer serves read-only GET requests."
        });
      }

      if (url.pathname === "/health") {
        const status = sanitizeStatus(await getStatus());
        return sendJson(response, 200, {
          ok: true,
          service: "pearlscriptions-indexer",
          chain,
          readOnly: true,
          startedAt,
          indexer: status
        }, cacheHeaders("live"));
      }

      if (url.pathname === "/indexer/status") {
        return sendJson(response, 200, sanitizeStatus(await getStatus()), cacheHeaders("live"));
      }

      if (url.pathname === "/indexer/digest") {
        const snapshot = await getSnapshot();
        return sendJson(response, 200, {
          chain: snapshot?.network?.chain ?? chain,
          indexedHeight: snapshot?.network?.indexedHeight ?? snapshot?.network?.bestHeight ?? null,
          indexedHash: snapshot?.network?.indexedHash ?? null,
          snapshotDigest: snapshotDigest(snapshot),
          releaseManifestDigest: manifestDigest,
          summary: summarizeSnapshot(snapshot)
        }, cacheHeaders("short"));
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
