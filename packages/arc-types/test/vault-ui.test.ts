import { describe, expect, it } from "vitest";
import {
  isVaultColor,
  isVaultIcon,
  VAULT_COLORS,
  VAULT_ICONS,
  type NoteItem,
} from "../src";

describe("vault-ui allowlists", () => {
  it("isVaultIcon accepts every member of VAULT_ICONS", () => {
    for (const ic of VAULT_ICONS) {
      expect(isVaultIcon(ic)).toBe(true);
    }
  });

  it("isVaultIcon rejects strings not in the allowlist", () => {
    expect(isVaultIcon("not-a-real-icon")).toBe(false);
    expect(isVaultIcon("<script>alert(1)</script>")).toBe(false);
    expect(isVaultIcon("")).toBe(false);
  });

  it("isVaultIcon rejects non-strings", () => {
    expect(isVaultIcon(42)).toBe(false);
    expect(isVaultIcon(null)).toBe(false);
    expect(isVaultIcon(undefined)).toBe(false);
    expect(isVaultIcon({ icon: "vault" })).toBe(false);
  });

  it("isVaultColor accepts every member of VAULT_COLORS", () => {
    for (const c of VAULT_COLORS) {
      expect(isVaultColor(c)).toBe(true);
    }
  });

  it("isVaultColor rejects arbitrary hex / strings", () => {
    // Out of palette — real colours we just didn't bless.
    expect(isVaultColor("#ABCDEF")).toBe(false);
    expect(isVaultColor("#000000")).toBe(false);
    // Hostile values that the server must never echo back to a renderer.
    expect(isVaultColor("javascript:void(0)")).toBe(false);
    expect(isVaultColor("rgb(255, 0, 0)")).toBe(false);
    expect(isVaultColor("")).toBe(false);
  });

  it("VAULT_ICONS / VAULT_COLORS are frozen tuples (intent: closed sets)", () => {
    // `as const` doesn't actually freeze the array at runtime, but the TS layer treats it
    // as a readonly tuple. This test just pins the values so a refactor that accidentally
    // empties the lists trips a regression.
    expect(VAULT_ICONS.length).toBeGreaterThan(0);
    expect(VAULT_COLORS.length).toBeGreaterThan(0);
    // Every colour is a #RRGGBB literal — keeps the wire shape predictable for the UI.
    for (const c of VAULT_COLORS) {
      expect(c).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

describe("NoteItem format", () => {
  it("compiles without format (back-compat: missing ≡ plaintext)", () => {
    const note: NoteItem = { type: "note", title: "T", body: "B" };
    expect(note.format).toBeUndefined();
  });

  it("accepts plaintext and markdown", () => {
    const plain: NoteItem = { type: "note", title: "T", body: "B", format: "plaintext" };
    const md: NoteItem = { type: "note", title: "T", body: "# H", format: "markdown" };
    expect(plain.format).toBe("plaintext");
    expect(md.format).toBe("markdown");
  });
});
