const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const normalizeHost = (host: string) => {
  const trimmed = host.trim();
  if (!trimmed) return "";
  try {
    return new URL(`http://${trimmed}`).hostname.toLowerCase();
  } catch {
    const lowered = trimmed.toLowerCase();
    if (lowered.startsWith("[")) {
      const end = lowered.indexOf("]");
      if (end > 0) return lowered.slice(1, end);
      return lowered;
    }
    const firstColon = lowered.indexOf(":");
    return firstColon > -1 ? lowered.slice(0, firstColon) : lowered;
  }
};

export const isLocalHost = (host: string | null | undefined) => {
  if (!host) return false;
  const normalized = normalizeHost(host);
  return LOCAL_HOSTS.has(normalized) || normalized.endsWith(".localhost");
};

