import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolves the public Starknet RPC endpoints used by the `*.integration`
 * suites without committing their URLs to the repository.
 *
 * Resolution order for each endpoint:
 *   1. Environment variables (see `ENV_KEYS`).
 *   2. An untracked `live-endpoints.local.json` next to this file.
 *   3. Unset — the corresponding integration suite is skipped.
 *
 * The local file is git-ignored (see the repository `.gitignore`) so private
 * endpoints stay on the machine running the tests. Its shape is:
 *
 *   {
 *     "integration": { "httpUrl": "http://…/rpc/v0_10", "wsUrl": "ws://…" },
 *     "testnet":     { "httpUrl": "http://…/rpc/v0_9" }
 *   }
 */
export type LiveEndpoint = {
  httpUrl: string;
  wsUrl?: string;
};

export type LiveEndpointName = "integration" | "testnet";

const ENV_KEYS: Record<LiveEndpointName, { http: string; ws: string }> = {
  integration: {
    http: "TEST_STARKNET_RPC_V010_HTTP_URL",
    ws: "TEST_STARKNET_RPC_V010_WS_URL",
  },
  testnet: {
    http: "TEST_STARKNET_RPC_V09_HTTP_URL",
    ws: "TEST_STARKNET_RPC_V09_WS_URL",
  },
};

const LOCAL_FILE = fileURLToPath(
  new URL("./live-endpoints.local.json", import.meta.url),
);

type LocalConfig = Partial<Record<LiveEndpointName, LiveEndpoint>> & {
  /** JSON-RPC URL of a locally-run starknet-devnet, for the reorg suite. */
  devnet?: string;
};

let localCache: LocalConfig | undefined;

function readLocalFile(): LocalConfig {
  if (localCache) return localCache;
  try {
    localCache = existsSync(LOCAL_FILE)
      ? (JSON.parse(readFileSync(LOCAL_FILE, "utf8")) as LocalConfig)
      : {};
  } catch (error) {
    throw new Error(
      `Failed to parse ${LOCAL_FILE}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return localCache;
}

/** Trims a value and returns undefined for missing/blank strings. */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Returns the resolved endpoint, or `undefined` when it is not configured. */
export function getLiveEndpoint(
  name: LiveEndpointName,
): LiveEndpoint | undefined {
  const keys = ENV_KEYS[name];
  const local = readLocalFile()[name];
  // Env wins over the local file, but a blank env var (e.g. an unset GitHub
  // Actions secret expands to "") must not shadow a configured local value.
  const httpUrl = clean(process.env[keys.http]) ?? clean(local?.httpUrl);
  if (!httpUrl) return undefined;
  const wsUrl = clean(process.env[keys.ws]) ?? clean(local?.wsUrl);
  return { httpUrl, wsUrl };
}

/**
 * JSON-RPC URL of a locally-run starknet-devnet for the reorg suite, or
 * `undefined` when not configured. Set via the `TEST_STARKNET_DEVNET_URL`
 * env var (the CI job provides it) or a `devnet` entry in the local file.
 */
export function getDevnetUrl(): string | undefined {
  return (
    clean(process.env.TEST_STARKNET_DEVNET_URL) ?? clean(readLocalFile().devnet)
  );
}
