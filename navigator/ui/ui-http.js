// The transport for the Node Navigator: HTTP requests to the local server, and server-sent events back.

import { mountUi } from "/_navigator/ui-core.js";

const events = new EventSource("/_navigator/events");
const handlers = new Set();
events.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  for (const h of handlers) h(msg);
};

mountUi({
  async post(endpoint, body) {
    const res = await fetch(`/_navigator/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Navigator": "1" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const { error } = await res.json().catch(() => ({}));
    return { ok: false, error: error ?? `Something went wrong (${res.status}).` };
  },
  subscribe(handler) {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
  state: () => fetch("/_navigator/state").then((r) => r.json()),
});
