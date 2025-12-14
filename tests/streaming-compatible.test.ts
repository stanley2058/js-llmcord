import { describe, expect, it } from "bun:test";
import {
  maybeYieldBoundarySeparator,
  shouldInsertBoundarySeparator,
} from "../src/streaming-compatible";

describe("streaming-compatible", () => {
  it("shouldInsertBoundarySeparator triggers for merged markdown delimiters", () => {
    expect(shouldInsertBoundarySeparator("*", "*")).toBe(true);
    expect(shouldInsertBoundarySeparator("_", "_")).toBe(true);
    expect(shouldInsertBoundarySeparator("`", "`")).toBe(true);
    expect(shouldInsertBoundarySeparator("~", "~")).toBe(true);
    expect(shouldInsertBoundarySeparator("$", "$")).toBe(true);

    expect(shouldInsertBoundarySeparator("*", "a")).toBe(false);
    expect(shouldInsertBoundarySeparator(".", "*")).toBe(false);
    expect(shouldInsertBoundarySeparator("*", " ")).toBe(false);
  });

  it("maybeYieldBoundarySeparator inserts single space by default", () => {
    expect(maybeYieldBoundarySeparator("*", "*hi")).toBe(" ");
    expect(maybeYieldBoundarySeparator("a", "b")).toBe("");
  });
});
