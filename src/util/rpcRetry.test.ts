import { describe, expect, it } from "vitest";
import { withEndpointFailover, withRpcRetry } from "./rpcRetry.js";

function transientError(): Error {
  return Object.assign(
    new Error("RPC: starknet_chainId -32029: Too Many Requests"),
    {
      code: -32029,
    },
  );
}

function specError(): Error {
  return new Error(
    "RPC specification version is not supported by this library",
  );
}

describe(withEndpointFailover, () => {
  it("fails over to the next endpoint", async () => {
    const seen: string[] = [];
    const result = await withEndpointFailover(["a", "b"], async (url) => {
      seen.push(url);
      if (url === "a") throw transientError();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual(["a", "b"]);
  });

  it("throws the last error when every endpoint fails", async () => {
    await expect(
      withEndpointFailover(["a", "b"], async () => {
        throw transientError();
      }),
    ).rejects.toThrow("Too Many Requests");
  });

  it("rethrows non-failover errors without trying further endpoints", async () => {
    let calls = 0;
    await expect(
      withEndpointFailover(["a", "b"], async () => {
        calls += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("fails over on unsupported RPC spec", async () => {
    const seen: string[] = [];
    const result = await withEndpointFailover(["a", "b"], async (url) => {
      seen.push(url);
      if (url === "a") throw specError();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual(["a", "b"]);
  });
});

describe(withRpcRetry, () => {
  it("succeeds after transient failures", async () => {
    let calls = 0;
    const result = await withRpcRetry(async () => {
      calls += 1;
      if (calls < 3) throw transientError();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows non-transient errors immediately", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(async () => {
        calls += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
