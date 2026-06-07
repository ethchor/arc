import { describe, expect, it } from "vitest";
import { effectiveAllows, intersectScopes, scope, scopeAllows } from "../src/index";
import type { Capability, Scope } from "../src/index";

const ALL: Capability[] = ["create", "read", "update", "delete", "list", "sudo"];
const PATHS = [
  "secret/data/app/db",
  "secret/data/app/api",
  "secret/data/other",
  "transit/encrypt/k",
  "pki/issue/role",
];

describe("effectiveAllows — delegation can only narrow", () => {
  it("requires every scope set to allow (conjunction)", () => {
    const delegated = [scope("secret/data/app", ["read", "update"])];
    const delegatorCeiling = [scope("secret/", ["read", "update", "create"])];
    const agentCeiling = [scope("secret/data/app", ["read"])];

    // read is in all three → allowed
    expect(effectiveAllows("secret/data/app/db", "read", delegated, delegatorCeiling, agentCeiling)).toBe(true);
    // update is delegated + within delegator, but NOT in the agent's own ceiling → denied
    expect(effectiveAllows("secret/data/app/db", "update", delegated, delegatorCeiling, agentCeiling)).toBe(false);
  });

  it("a delegator cannot lend authority they lack (no escalation)", () => {
    const delegated = [scope("secret/", ["read", "delete"])]; // over-broad delegation
    const delegatorCeiling = [scope("secret/data/app", ["read"])]; // delegator only has read on app
    // delete is "delegated" but the delegator never had it → denied
    expect(effectiveAllows("secret/data/app/db", "delete", delegated, delegatorCeiling)).toBe(false);
    // even read is denied outside the delegator's own prefix
    expect(effectiveAllows("secret/data/other", "read", delegated, delegatorCeiling)).toBe(false);
    // read inside the delegator's prefix is fine
    expect(effectiveAllows("secret/data/app/db", "read", delegated, delegatorCeiling)).toBe(true);
  });

  it("an agent cannot exceed its own policy even if over-delegated (no accumulation)", () => {
    const delegated = [scope("", ["sudo"])]; // delegated everything
    const delegatorCeiling = [scope("", ["sudo"])]; // delegator is root
    const agentCeiling = [scope("secret/data/app", ["read"])]; // agent itself is tightly scoped
    expect(effectiveAllows("secret/data/app/db", "read", delegated, delegatorCeiling, agentCeiling)).toBe(true);
    expect(effectiveAllows("secret/data/app/db", "delete", delegated, delegatorCeiling, agentCeiling)).toBe(false);
    expect(effectiveAllows("transit/encrypt/k", "read", delegated, delegatorCeiling, agentCeiling)).toBe(false);
  });

  it("sudo on one ceiling still requires the others to allow", () => {
    const sudo = [scope("", ["sudo"])];
    const narrow = [scope("secret/data/app", ["read"])];
    expect(effectiveAllows("secret/data/app/db", "read", sudo, narrow)).toBe(true);
    expect(effectiveAllows("secret/data/app/db", "delete", sudo, narrow)).toBe(false);
  });

  it("empty inputs are deny", () => {
    expect(effectiveAllows("secret/data/app/db", "read")).toBe(false);
    expect(effectiveAllows("secret/data/app/db", "read", [])).toBe(false);
    expect(effectiveAllows("secret/data/app/db", "read", [scope("secret/", ["read"])], [])).toBe(false);
  });
});

describe("intersectScopes — materialised meet agrees with effectiveAllows", () => {
  // A battery of scope-set pairs; for each we assert the materialised intersection grants
  // exactly the (path, cap) probes that the conjunction of the two inputs grants.
  const pairs: Array<[Scope[], Scope[]]> = [
    [[scope("secret/data/app", ["read", "update"])], [scope("secret/", ["read"])]],
    [[scope("secret/", ["sudo"])], [scope("secret/data/app", ["read", "delete"])]],
    [[scope("secret/data/app", ["read"])], [scope("secret/data/other", ["read"])]], // disjoint prefixes
    [[scope("", ["sudo"])], [scope("transit/", ["read", "create"])]],
    [[scope("secret/data", ["read", "list"])], [scope("secret/data/app", ["read", "list", "update"])]],
    [[scope("pki/", ["create"])], [scope("pki/issue", ["read"])]], // overlap but no common cap
  ];

  it("intersection ⟺ both inputs allow, over every path × capability", () => {
    for (const [a, b] of pairs) {
      const meet = intersectScopes(a, b);
      for (const path of PATHS) {
        for (const cap of ALL) {
          const viaMeet = scopeAllows(meet, path, cap);
          const viaBoth = scopeAllows(a, path, cap) && scopeAllows(b, path, cap);
          expect(
            viaMeet,
            `meet vs both disagree on ${cap} @ ${path} for ${JSON.stringify(a)} ∩ ${JSON.stringify(b)}`,
          ).toBe(viaBoth);
        }
      }
    }
  });

  it("intersection is never broader than either input", () => {
    for (const [a, b] of pairs) {
      const meet = intersectScopes(a, b);
      for (const path of PATHS) {
        for (const cap of ALL) {
          if (scopeAllows(meet, path, cap)) {
            expect(scopeAllows(a, path, cap)).toBe(true);
            expect(scopeAllows(b, path, cap)).toBe(true);
          }
        }
      }
    }
  });

  it("disjoint prefixes intersect to nothing", () => {
    const meet = intersectScopes(
      [scope("secret/data/app", ["read"])],
      [scope("secret/data/other", ["read"])],
    );
    expect(meet).toEqual([]);
  });
});
