import { describe, expect, it } from "vitest";
import { projectFields, renderTemplate } from "../src/templating";

describe("renderTemplate", () => {
  it('substitutes top-level {{ .field }} refs', () => {
    expect(renderTemplate("{{ .a }}-{{ .b }}", { a: "x", b: "y" }, "ctx")).toBe("x-y");
  });

  it("tolerates whitespace around the dot-name", () => {
    expect(renderTemplate("{{.a}}-{{ .b }}-{{   .c   }}", { a: "1", b: "2", c: "3" }, "ctx")).toBe("1-2-3");
  });

  it("throws on a missing field rather than silently producing an empty string", () => {
    expect(() => renderTemplate("{{ .missing }}", { a: "1" }, "ctx")).toThrow(/missing/);
  });

  it("renders null/undefined fields as empty (present-but-empty is intentional)", () => {
    expect(renderTemplate("[{{ .a }}]", { a: null }, "ctx")).toBe("[]");
    expect(renderTemplate("[{{ .a }}]", { a: undefined }, "ctx")).toBe("[]");
  });
});

describe("projectFields", () => {
  it("copies fields verbatim when no template map is provided", () => {
    expect(projectFields(undefined, { a: 1, b: "x", c: null }, "ctx")).toEqual({ a: "1", b: "x", c: "" });
  });

  it("applies the template map and propagates per-field errors with the field name", () => {
    expect(() =>
      projectFields({ X: "{{ .ghost }}" }, { a: 1 }, "ns/cr"),
    ).toThrow(/ns\/cr\.X.*ghost/);
  });
});
