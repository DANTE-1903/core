import { beforeEach, describe, expect, it, vi } from "vitest";
import { StellarToml } from "@stellar/stellar-sdk";
import { clearAnchorCache, getAnchorInfo } from "./anchors";
import { fetchStellarToml } from "./sep1Toml";

describe("getAnchorInfo", () => {
  beforeEach(() => clearAnchorCache());

  it("reuses cached anchor information for the same domain", async () => {
    const resolve = vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      TRANSFER_SERVER: "https://anchor.example.com/sep6",
    } as never);

    const first = await getAnchorInfo("example.com");
    const second = await getAnchorInfo("example.com");

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("fetches anchor information again after the configured TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
        TRANSFER_SERVER: "https://anchor.example.com/sep6",
      } as never);

      await getAnchorInfo("example.com", { ttlMs: 100 });
      await vi.advanceTimersByTimeAsync(101);
      await getAnchorInfo("example.com", { ttlMs: 100 });

      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates cached anchor information", async () => {
    const resolve = vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      TRANSFER_SERVER: "https://anchor.example.com/sep6",
    } as never);

    await getAnchorInfo("example.com");
    clearAnchorCache();
    await getAnchorInfo("example.com");

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("shares normalized TOML entries with the SEP-1 cache", async () => {
    const resolve = vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
      TRANSFER_SERVER: "https://anchor.example.com/sep6",
    } as never);
    const fetcher = vi.fn();

    await getAnchorInfo("example.com");
    const result = await fetchStellarToml("example.com", { fetch: fetcher });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.transfer_server).toBe("https://anchor.example.com/sep6");
    }
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
