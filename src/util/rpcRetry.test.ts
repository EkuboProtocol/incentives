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

const noSleep = async (_ms: number): Promise<void> => {};

describe(withEndpointFailover, () => {
  it("fails over to the next endpoint", async () => {
    const seen: string[] = [];
    const result = await withEndpointFailover(
      ["a", "b"],
      async (url) => {
        seen.push(url);
        if (url === "a") throw transientError();
        return "ok";
      },
      { sleep: noSleep },
    );
    expect(result).toBe("ok");
    expect(seen).toEqual(["a", "b"]);
  });

  it("makes several passes when every endpoint is transiently limited", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await expect(
      withEndpointFailover(
        ["a", "b"],
        async () => {
          calls += 1;
          throw transientError();
        },
        {
          rounds: 3,
          baseDelayMs: 1000,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow("Too Many Requests");
    // 2 endpoints x 3 passes, with a wait between passes.
    expect(calls).toBe(6);
    expect(sleeps).toHaveLength(2);
  });

  it("stops after one pass when no error is transient", async () => {
    let calls = 0;
    await expect(
      withEndpointFailover(
        ["a", "b"],
        async () => {
          calls += 1;
          throw specError();
        },
        { rounds: 3, sleep: noSleep },
      ),
    ).rejects.toThrow("specification version");
    expect(calls).toBe(2);
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
