export function createPearlRpcClient({
  url,
  user = "",
  password = "",
  timeoutMs = 30_000,
  retries = 3,
  retryDelayMs = 750
}) {
  if (!url) {
    throw new Error("PEARL_RPC_URL is required for Pearl RPC sync");
  }

  let id = 0;
  return async function pearlRpc(method, params = []) {
    id += 1;
    const attempts = Math.max(1, retries + 1);
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = {
          "content-type": "application/json"
        };
        if (user || password) {
          headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
        }
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "1.0",
            id,
            method,
            params
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          throw new PearlRpcHttpError(method, response.status);
        }
        const payload = await response.json();
        if (payload.error) {
          throw new Error(`Pearl RPC ${method} failed: ${payload.error.message ?? payload.error.code}`);
        }
        return payload.result;
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || !isRetryableRpcError(error)) {
          throw error;
        }
        await sleep(retryDelayMs * attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError;
  };
}

class PearlRpcHttpError extends Error {
  constructor(method, status) {
    super(`Pearl RPC ${method} failed with HTTP ${status}`);
    this.status = status;
  }
}

function isRetryableRpcError(error) {
  if (error instanceof PearlRpcHttpError) {
    return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
  }
  return error?.name === "AbortError" || error instanceof TypeError;
}

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
