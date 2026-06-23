import { describe, expect, it, vi } from "vitest";
import { OpenBaoClient, OpenBaoPkiEngine, PkiProtocolError } from "../src/index";
import type { FetchInit } from "../src/index";

function fakeFetch(
  handler: (url: string, init: FetchInit) => { status: number; body?: unknown },
) {
  return vi.fn(async (url: string, init?: FetchInit) => {
    const { status, body } = handler(url, init ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    };
  });
}

describe("OpenBaoPkiEngine", () => {
  it("issues a certificate against `pki/issue/<role>` and maps the response", async () => {
    let seenBody: string | undefined;
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/pki/issue/server");
      expect(init.method).toBe("POST");
      seenBody = init.body;
      return {
        status: 200,
        body: {
          data: {
            certificate: "-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----",
            issuing_ca: "-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----",
            ca_chain: [
              "-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----",
              "-----BEGIN CERTIFICATE-----\nroot\n-----END CERTIFICATE-----",
            ],
            private_key: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----",
            private_key_type: "rsa",
            serial_number: "11:22:33",
            expiration: 1820000000,
          },
        },
      };
    });
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }));
    const cert = await pki.issueCertificate("server", {
      commonName: "service.arc.test",
      ttlSeconds: 3600,
      altNames: ["alt.arc.test"],
      ipSans: ["10.0.0.1"],
    });
    expect(cert.serialNumber).toBe("11:22:33");
    expect(cert.expiration).toBe(1820000000);
    expect(cert.caChain).toHaveLength(2);
    expect(cert.privateKeyType).toBe("rsa");
    expect(JSON.parse(seenBody!)).toEqual({
      common_name: "service.arc.test",
      ttl: "3600s",
      alt_names: "alt.arc.test",
      ip_sans: "10.0.0.1",
    });
  });

  it("signs a CSR via `pki/sign/<role>`", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/pki/sign/client");
      const body = JSON.parse(init.body!) as Record<string, unknown>;
      expect(body.csr).toContain("CERTIFICATE REQUEST");
      expect(body.common_name).toBe("override.arc.test");
      return {
        status: 200,
        body: {
          data: {
            certificate: "leaf",
            issuing_ca: "issuer",
            ca_chain: ["issuer"],
            serial_number: "ab:cd",
            expiration: 42,
          },
        },
      };
    });
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }));
    const signed = await pki.signCsr("client", {
      csr: "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----",
      commonName: "override.arc.test",
    });
    expect(signed.serialNumber).toBe("ab:cd");
    expect(signed.expiration).toBe(42);
  });

  it("revokes by serial via `pki/revoke`", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/pki/revoke");
      expect(JSON.parse(init.body!)).toEqual({ serial_number: "11:22:33" });
      return { status: 200, body: { data: { revocation_time: 1717000000 } } };
    });
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }));
    const r = await pki.revokeCertificate("11:22:33");
    expect(r.revocationTime).toBe(1717000000);
  });

  it("reads a certificate by serial and includes revocationTime when present", async () => {
    const fetchFn = fakeFetch((url) => {
      expect(url).toBe("http://bao:8200/v1/pki/cert/aa:bb");
      return { status: 200, body: { data: { certificate: "PEM", revocation_time: 12345 } } };
    });
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }));
    const cert = await pki.readCertificate("aa:bb");
    expect(cert.certificate).toBe("PEM");
    expect(cert.revocationTime).toBe(12345);
  });

  it("omits revocationTime when the backend reports 0 (active cert)", async () => {
    const fetchFn = fakeFetch(() => ({
      status: 200,
      body: { data: { certificate: "PEM", revocation_time: 0 } },
    }));
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }));
    const cert = await pki.readCertificate("aa:bb");
    expect(cert.revocationTime).toBeUndefined();
  });

  it("lists serials via `pki/certs`", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/pki/certs");
      expect(init.method).toBe("LIST");
      return { status: 200, body: { data: { keys: ["11:22:33", "ab:cd"] } } };
    });
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }));
    expect(await pki.listCertificates()).toEqual(["11:22:33", "ab:cd"]);
  });

  it("reads CA PEM from `pki/ca/pem`", async () => {
    const fetchFn = fakeFetch((url) => {
      expect(url).toBe("http://bao:8200/v1/pki/ca/pem");
      return { status: 200, body: { data: { certificate: "ROOT-PEM" } } };
    });
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }));
    expect(await pki.readCaCertificate()).toBe("ROOT-PEM");
  });

  it("flattens ca_chain array into newline-joined PEM bundle", async () => {
    const fetchFn = fakeFetch((url) => {
      expect(url).toBe("http://bao:8200/v1/pki/ca_chain");
      return { status: 200, body: { data: { ca_chain: ["A", "B"] } } };
    });
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }));
    expect(await pki.readCaChain()).toBe("A\nB");
  });

  it("throws PkiProtocolError when ca_chain is missing entirely", async () => {
    const fetchFn = fakeFetch(() => ({ status: 200, body: { data: {} } }));
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }));
    await expect(pki.readCaChain()).rejects.toThrow(PkiProtocolError);
  });

  it("respects a custom mount path", async () => {
    const fetchFn = fakeFetch((url) => {
      expect(url).toBe("http://bao:8200/v1/pki-int/issue/web");
      return {
        status: 200,
        body: {
          data: {
            certificate: "c",
            issuing_ca: "i",
            ca_chain: [],
            private_key: "k",
            private_key_type: "ec",
            serial_number: "1",
            expiration: 0,
          },
        },
      };
    });
    const pki = new OpenBaoPkiEngine(
      new OpenBaoClient({ addr: "http://bao:8200", fetchFn }),
      "pki-int",
    );
    expect(pki.mount).toBe("pki-int/");
    await pki.issueCertificate("web", { commonName: "x" });
  });

  it("listRoles LISTs <mount>/roles and folds 404 (empty mount) into []", async () => {
    const ok = fakeFetch((url, init) => {
      expect(init.method).toBe("LIST");
      expect(url).toBe("http://bao:8200/v1/pki/roles");
      return { status: 200, body: { data: { keys: ["server", "client"] } } };
    });
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", token: "t", fetchFn: ok }));
    expect(await pki.listRoles()).toEqual(["server", "client"]);

    const empty = fakeFetch(() => ({ status: 404, body: { errors: [] } }));
    const pki2 = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", token: "t", fetchFn: empty }));
    expect(await pki2.listRoles()).toEqual([]);
  });

  it("listCertificates also folds 404 (no certs yet) into []", async () => {
    const empty = fakeFetch(() => ({ status: 404, body: { errors: [] } }));
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", token: "t", fetchFn: empty }));
    expect(await pki.listCertificates()).toEqual([]);
  });

  it("readRole normalises the documented role fields + collects unknowns into extra", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/pki/roles/server");
      expect(init.method).toBe("GET");
      return {
        status: 200,
        body: {
          data: {
            name: "server",
            ttl: 3600,
            max_ttl: "72h",
            allow_any_name: false,
            allow_subdomains: true,
            allow_bare_domains: true,
            allowed_domains: "arc.test,foo.bar",
            key_type: "rsa",
            key_bits: 2048,
            // Backend-specific extras we don't model directly:
            signature_bits: 256,
            key_usage: ["DigitalSignature", "KeyEncipherment"],
          },
        },
      };
    });
    const pki = new OpenBaoPkiEngine(new OpenBaoClient({ addr: "http://bao:8200", token: "t", fetchFn }));
    const role = await pki.readRole("server");
    expect(role.name).toBe("server");
    expect(role.ttlSeconds).toBe(3600);
    expect(role.maxTtlSeconds).toBe(72 * 3600); // "72h" → seconds
    expect(role.allowAnyName).toBe(false);
    expect(role.allowSubdomains).toBe(true);
    expect(role.allowBareDomains).toBe(true);
    expect(role.allowedDomains).toEqual(["arc.test", "foo.bar"]);
    expect(role.keyType).toBe("rsa");
    expect(role.keyBits).toBe(2048);
    expect(role.extra?.signature_bits).toBe(256);
    expect(role.extra?.key_usage).toEqual(["DigitalSignature", "KeyEncipherment"]);
  });
});
