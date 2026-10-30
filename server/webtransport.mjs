// WebTransport transport for topics (spec/rpc.md, "Topics over WebTransport"): HTTP/3 over QUIC, one session per client,
// one bidirectional stream per subscription. The client opens a stream and writes a single JSON line
//     {"topic":"world","api":"sha256-...","session":"..."}
// and the server answers on the same stream with the frames of the streaming-HTTPS transport (same JSON lines), or with
// one `{"error":{"code","message"}}` line and a closed stream when it refuses.
//
// Needs the optional packages @fails-components/webtransport (+ its quiche binary) and reflect-metadata. Without them `startWebTransport` returns null and topics keep working over HTTPS.

import { createHash, webcrypto, X509Certificate, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { ApiError } from "./rpc.mjs";

const DEV_CERT_DAYS = 13; // browsers accept a pinned certificate for at most 14 days
const MAX_REQUEST = 4096;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_STREAMS_PER_SESSION = 32;
const MAX_SESSIONS = 2000;

// ---- A throwaway certificate, built by hand -------------------------------------------------------------------------
// A development certificate is a few dozen bytes of DER, so it is written here rather than pulled in from an X.509
// library (whose ASN.1 dependencies collide with the ones WebAuthn verification uses).

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const SEQ = (...p) => der(0x30, ...p);
const SET = (...p) => der(0x31, ...p);
const OID = (hex) => der(0x06, Buffer.from(hex, "hex"));
const OIDS = { ecdsaSha256: "2a8648ce3d040302", commonName: "550403", subjectAltName: "551d11" };
const utc = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));

/** A throwaway ECDSA P-256 certificate for development, and the hash a client pins. Never for production. */
export async function devCertificate({ hosts = ["localhost", "127.0.0.1"] } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const name = SEQ(SET(SEQ(OID(OIDS.commonName), der(0x0c, Buffer.from("lattice-dev")))));
  const signature = SEQ(OID(OIDS.ecdsaSha256));
  const names = [...new Set(hosts)].map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? der(0x87, Buffer.from(h.split(".").map(Number))) : der(0x82, Buffer.from(h))));
  const extensions = der(0xa3, SEQ(SEQ(OID(OIDS.subjectAltName), der(0x04, SEQ(...names)))));
  const tbs = SEQ(
    der(0xa0, der(0x02, Buffer.from([2]))), // version 3
    der(0x02, Buffer.from([1, ...randomBytes(8).map((b) => b & 0x7f)])), // positive serial
    signature,
    name,
    SEQ(utc(new Date(Date.now() - 60_000)), utc(new Date(Date.now() + DEV_CERT_DAYS * 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions
  );
  const sig = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const cert = SEQ(tbs, signature, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const body = cert.toString("base64").match(/.{1,64}/g).join("\n");
  const pem = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }), hash: certHash(pem) };
}

/** "sha256-<base64url>" of the certificate, the form the manifest carries. */
export const certHash = (pem) => `sha256-${createHash("sha256").update(new X509Certificate(pem).raw).digest("base64url")}`;

export async function webTransportAvailable() {
  try {
    await import("reflect-metadata");
    await import("@fails-components/webtransport");
    return true;
  } catch {
    return false;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Read the first line (at most MAX_REQUEST bytes) of a stream, leaving the rest unread. */
async function readRequestLine(reader) {
  let buf = "";
  const end = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < end) {
    const { value, done } = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), Math.max(1, end - Date.now())).unref?.())]);
    if (done) throw new Error("closed before a request");
    buf += dec.decode(value, { stream: true });
    const nl = buf.indexOf("\n");
    if (nl >= 0) return buf.slice(0, nl);
    if (buf.length > MAX_REQUEST) throw new Error("request too large");
  }
  throw new Error("timed out");
}

/**
 * @param opts.topics  the hub from createTopics
 * @param opts.cert,key  PEM for a real deployment; omit in development to get a throwaway one
 * @returns null when WebTransport is unavailable, else { url, certHash, close() }; certHash is set only for a throwaway
 *          certificate (a client may pin it in development).
 */
export async function startWebTransport({ topics, host = "127.0.0.1", port = 0, publicHost, cert, key, dev = false, log = console.error }) {
  if (!(await webTransportAvailable())) return null;
  if (!cert && !dev) throw new Error("WebTransport needs a certificate (--wt-cert and --wt-key); a throwaway one is only for --dev");
  const { Http3Server, quicheLoaded } = await import("@fails-components/webtransport");
  await quicheLoaded;
  const pinned = !cert ? await devCertificate({ hosts: ["localhost", "127.0.0.1", host, publicHost].filter(Boolean) }) : null;
  const pem = cert ?? pinned.cert;
  const privKey = key ?? pinned.key;

  const server = new Http3Server({ port, host, secret: webcrypto.getRandomValues(new Uint8Array(16)).join(""), cert: pem, privKey });
  server.startServer();
  await server.ready;
  const bound = server.address();
  let sessions = 0;
  let stopped = false;

  async function serveStream(stream) {
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    let pending = 0;
    let closed = false;
    const closers = [];
    const finish = () => {
      if (closed) return;
      closed = true;
      closers.forEach((f) => f());
    };
    const sink = {
      write(s) {
        if (closed) return;
        const bytes = enc.encode(s);
        pending += bytes.length;
        writer.write(bytes).then(() => (pending -= bytes.length), finish);
      },
      queued: () => pending,
      destroy() {
        finish();
        writer.abort().catch(() => {});
        reader.cancel().catch(() => {});
      },
      onClose: (fn) => closers.push(fn),
    };
    writer.closed.then(finish, finish);
    reader.closed.then(finish, finish); // the client closed or reset its side
    try {
      let req;
      try {
        req = JSON.parse(await readRequestLine(reader));
      } catch (e) {
        throw new ApiError("invalid_request", `bad subscription request: ${e.message}`);
      }
      if (!req || typeof req !== "object" || typeof req.topic !== "string") throw new ApiError("invalid_request", "bad subscription request");
      await topics.open(req.topic, { api: req.api, session: req.session }, sink);
    } catch (e) {
      if (!(e instanceof ApiError)) log(`webtransport: ${e.stack ?? e}`);
      const err = e instanceof ApiError ? { code: e.code, message: e.message } : { code: "internal", message: "internal error" };
      try {
        await writer.write(enc.encode(`${JSON.stringify({ error: err })}\n`));
        await writer.close();
      } catch { /* the client is gone */ }
      finish();
    }
  }

  async function serveSession(session) {
    if (sessions >= MAX_SESSIONS) return void session.close?.({ closeCode: 1, reason: "too many sessions" });
    sessions++;
    let streams = 0;
    try {
      await session.ready;
      session.closed.finally(() => sessions--).catch(() => {});
      const incoming = session.incomingBidirectionalStreams.getReader();
      for (;;) {
        const { value: stream, done } = await incoming.read();
        if (done) break;
        if (streams >= MAX_STREAMS_PER_SESSION) {
          stream.writable.getWriter().abort().catch(() => {});
          continue;
        }
        streams++;
        serveStream(stream).finally(() => streams--);
      }
    } catch {
      /* the session ended */
    }
  }

  (async () => {
    const reader = (await server.sessionStream("/stream")).getReader();
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      serveSession(value);
    }
  })().catch((e) => !stopped && log(`webtransport: ${e.message}`));

  return {
    url: `https://${publicHost ?? host}:${bound.port}/stream`,
    port: bound.port,
    certHash: pinned?.hash ?? null,
    close() {
      if (stopped) return; // stopping the native server twice crashes the process
      stopped = true;
      server.stopServer();
    },
  };
}

export const loadCertFiles = (certFile, keyFile) => ({ cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") });
