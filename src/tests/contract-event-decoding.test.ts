import { describe, expect, it } from "vitest";
import {
  decodeContractEvent,
} from "../soroban/decodeContractEvent";

describe("contract event decoders", () => {
  it("decodes factory pair creation", () => {
    const result = decodeContractEvent({
      contractId: "CFACTORY",
      name: "pair_created",
      value: ["TOKEN_A", "TOKEN_B", "CPAIR"],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data).toMatchObject({
      contractId: "CFACTORY",
      name: "pair_created",
      value: ["TOKEN_A", "TOKEN_B", "CPAIR"],
      type: "unknown",
    });
  });

  it("decodes router swaps", () => {
    const result = decodeContractEvent({
      contractId: "CROUTER",
      topics: ["router", "swap"],
      value: ["GSENDER", ["A", "B", "C"], 100n, 95n],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data).toMatchObject({
      contractId: "CROUTER",
      topics: ["router", "swap"],
      value: ["GSENDER", ["A", "B", "C"], 100n, 95n],
      type: "unknown",
    });
  });

  it("returns a structured validation error for malformed input", () => {
    const result = decodeContractEvent(null);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("CONTRACT_READ_FAILED");
    }
  });
});
