// The WebTransport client class for Node, from the optional @fails-components/webtransport package, or null when it is not
// installed (topics then use streaming HTTPS). Browsers have WebTransport built in and do not use this file.

export async function loadNodeWebTransport() {
  try {
    await import("reflect-metadata");
    const m = await import("@fails-components/webtransport");
    await m.quicheLoaded;
    return m.WebTransport;
  } catch {
    return null;
  }
}
