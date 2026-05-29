export function normalizeSelfCheckUrl(rawUrl) {
  const url = new URL(String(rawUrl ?? ""));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("--url must use http or https");
  }
  if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) {
    throw new Error("--url must use https unless the target is localhost, 127.0.0.1, or [::1]");
  }
  if (url.protocol === "https:" && !isPublicHttpsHost(url.hostname)) {
    throw new Error("--url https targets must use a public hostname, not localhost, an internal name, or an IP literal");
  }
  if (url.username || url.password) {
    throw new Error("--url must not include username or password");
  }
  url.search = "";
  url.hash = "";
  return url;
}

function isLocalHttpHost(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isPublicHttpsHost(hostname) {
  const normalized = hostname.toLowerCase();
  const withoutBrackets = normalized.replace(/^\[(.*)\]$/, "$1");
  if (
    isLocalHttpHost(normalized) ||
    withoutBrackets.endsWith(".localhost") ||
    withoutBrackets.endsWith(".local") ||
    withoutBrackets === "0.0.0.0"
  ) {
    return false;
  }
  if (isIpv4Literal(withoutBrackets) || withoutBrackets.includes(":")) {
    return false;
  }
  return withoutBrackets.includes(".");
}

function isIpv4Literal(hostname) {
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}
