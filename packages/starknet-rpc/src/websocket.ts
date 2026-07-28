import { sleep } from "@apibara/protocol/rpc";

type SignalKind = "accepted" | "pending";

/**
 * A small notification gate. HTTP remains the source of truth; WebSocket
 * notifications only wake the stream so provider-specific payload differences
 * cannot corrupt canonical tracking.
 */
export class StarknetWebSocketSignal {
  private socket?: WebSocket;
  private readonly pendingSignals = { accepted: false, pending: false };
  private readonly waiters = {
    accepted: new Set<() => void>(),
    pending: new Set<() => void>(),
  };
  private readonly subscriptions = new Map<string, SignalKind>();
  private readonly requestKinds = new Map<number, SignalKind>();
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly timeout: number,
  ) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Starknet WebSocket connection timed out")),
        this.timeout,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Starknet WebSocket connection failed"));
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("close", () => {
      this.socket = undefined;
      this.notify("accepted");
      this.notify("pending");
    });
    this.subscribe("starknet_subscribeNewHeads", "accepted");
    this.subscribe("starknet_subscribeNewTransactions", "pending");
    this.subscribe("starknet_subscribeEvents", "pending");
  }

  async wait(kind: SignalKind, timeoutMs: number): Promise<void> {
    if (this.pendingSignals[kind]) {
      this.pendingSignals[kind] = false;
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      try {
        await this.connect();
      } catch {
        await sleep(timeoutMs);
        return;
      }
    }
    if (this.pendingSignals[kind]) {
      this.pendingSignals[kind] = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        this.waiters[kind].delete(done);
        resolve();
      };
      const timeout = setTimeout(done, timeoutMs);
      this.waiters[kind].add(done);
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  private subscribe(method: string, kind: SignalKind): void {
    if (!this.socket) return;
    const id = this.nextId++;
    this.requestKinds.set(id, kind);
    this.socket.send(
      JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
    );
  }

  private onMessage(event: MessageEvent): void {
    let message: {
      id?: number;
      result?: unknown;
      params?: { subscription?: unknown };
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const kind = this.requestKinds.get(message.id);
      if (kind && message.result !== undefined) {
        this.subscriptions.set(String(message.result), kind);
      }
      this.requestKinds.delete(message.id);
      return;
    }
    const subscription = message.params?.subscription;
    const kind =
      subscription === undefined
        ? undefined
        : this.subscriptions.get(String(subscription));
    if (kind) this.notify(kind);
  }

  private notify(kind: SignalKind): void {
    if (this.waiters[kind].size === 0) {
      this.pendingSignals[kind] = true;
    } else {
      for (const resolve of this.waiters[kind]) resolve();
      this.waiters[kind].clear();
    }
    // An accepted head also replaces the current pre-confirmed snapshot.
    if (kind === "accepted") {
      if (this.waiters.pending.size === 0) {
        this.pendingSignals.pending = true;
      } else {
        for (const resolve of this.waiters.pending) resolve();
        this.waiters.pending.clear();
      }
    }
  }
}
