// A software WebAuthn authenticator for tests: ES256 credentials, "none" attestation.
// It produces the JSON a browser's credential.toJSON() would, so servers can be tested end to end
// (including bad behaviour: wrong origin, wrong relying party, reused counters) without a browser.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { encode } from "../../shared/cbor.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest();
const b64u = (b) => Buffer.from(b).toString("base64url");

export class FakeAuthenticator {
  /**
   * @param origin   the origin the "browser" reports in clientDataJSON
   * @param rpId     the relying party id the authenticator binds credentials to
   */
  constructor({ origin, rpId }) {
    this.origin = origin;
    this.rpId = rpId;
    this.credentialId = randomBytes(16);
    this.counter = 0;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cose = new Map([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]);
  }

  #clientData(type, challenge, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  }

  /** Answer PublicKeyCredentialCreationOptionsJSON. Overrides let tests misbehave. */
  create(options, { origin, rpId = this.rpId, challenge = options.challenge } = {}) {
    const credId = this.credentialId;
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(credId.length);
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([0x45]), // user present | user verified | attested credential data
      counter,
      Buffer.alloc(16), // aaguid
      credLen,
      credId,
      Buffer.from(encode(this.cose)),
    ]);
    const clientDataJSON = this.#clientData("webauthn.create", challenge, origin);
    return {
      id: b64u(credId),
      rawId: b64u(credId),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(encode({ fmt: "none", attStmt: {}, authData })),
        transports: ["internal"],
      },
    };
  }

  /** Answer PublicKeyCredentialRequestOptionsJSON. */
  get(options, { origin, rpId = this.rpId, challenge = options.challenge, counter, key = this.privateKey, credentialId = this.credentialId } = {}) {
    this.counter = counter ?? this.counter + 1;
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([0x05]), c]); // user present | verified
    const clientDataJSON = this.#clientData("webauthn.get", challenge, origin);
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), { key, dsaEncoding: "der" });
    return {
      id: b64u(credentialId),
      rawId: b64u(credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        authenticatorData: b64u(authenticatorData),
        clientDataJSON: b64u(clientDataJSON),
        signature: b64u(signature),
        userHandle: b64u(randomBytes(16)),
      },
    };
  }
}
