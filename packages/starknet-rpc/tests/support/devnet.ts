/**
 * Minimal control client for a locally-run starknet-devnet, used by the reorg
 * suite to drive deterministic block production and abortion (reorgs).
 *
 * See https://github.com/starknet-io/starknet-devnet — requires the node to be
 * started with `--state-archive-capacity full` for block abortion to work.
 */
export class DevnetControl {
  #id = 1;

  constructor(private readonly url: string) {}

  private async call<T>(method: string, params: unknown = {}): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.#id++, method, params }),
    });
    const payload = (await response.json()) as {
      result?: T;
      error?: { message: string };
    };
    if (payload.error) {
      throw new Error(`${method}: ${payload.error.message}`);
    }
    return payload.result as T;
  }

  /** Reset devnet to genesis for test isolation. */
  restart(): Promise<void> {
    return this.call("devnet_restart");
  }

  /** Mine one block on demand; returns the new block hash. */
  async createBlock(): Promise<string> {
    const { block_hash } = await this.call<{ block_hash: string }>(
      "devnet_createBlock",
    );
    return block_hash;
  }

  /** Mark blocks up to `blockNumber` as accepted on L1 (i.e. finalized). */
  acceptOnL1(blockNumber: number): Promise<{ accepted: string[] }> {
    return this.call("devnet_acceptOnL1", {
      starting_block_id: { block_number: blockNumber },
    });
  }

  /** Abort `blockNumber` and everything after it (the reorg trigger). */
  abortBlocks(blockNumber: number): Promise<{ aborted: string[] }> {
    return this.call("devnet_abortBlocks", {
      starting_block_id: { block_number: blockNumber },
    });
  }

  /**
   * Mint tokens to an address, producing a transaction. Used to force a
   * divergent block hash on the reorged branch (empty devnet blocks are hashed
   * by height and would otherwise collide with the aborted block).
   */
  mint(address: string, amount: number): Promise<unknown> {
    return this.call("devnet_mint", { address, amount });
  }

  async blockNumber(): Promise<number> {
    return this.call<number>("starknet_blockNumber");
  }
}
