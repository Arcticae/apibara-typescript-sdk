export class StarknetRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "StarknetRpcError";
  }
}

export class UnsupportedStarknetRpcVersionError extends Error {
  constructor(readonly specVersion: string) {
    super(
      `Unsupported Starknet RPC specification ${specVersion}. ` +
        "This package requires RPC v0.9.x or exact v0.10.2.",
    );
    this.name = "UnsupportedStarknetRpcVersionError";
  }
}

export class StarknetRpcCapabilityError extends Error {
  constructor(
    readonly capability: string,
    detail?: string,
  ) {
    super(
      `Starknet RPC capability '${capability}' is required` +
        (detail ? `: ${detail}` : "."),
    );
    this.name = "StarknetRpcCapabilityError";
  }
}
