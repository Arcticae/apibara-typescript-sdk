const RANGE_ERRORS = [
  "block range",
  "range is too",
  "too many results",
  "result limit",
  "query returned more than",
];

export class EventRangeOracle {
  private size: bigint;
  private lowVolumeSuccesses = 0;

  constructor(
    initialSize = 1_000n,
    private readonly maximumSize = 10_000n,
  ) {
    if (initialSize < 1n || maximumSize < initialSize) {
      throw new Error("Invalid getEvents range size");
    }
    this.size = initialSize;
  }

  currentSize(): bigint {
    return this.size;
  }

  clamp(start: bigint, maximum: bigint): bigint {
    const end = start + this.size - 1n;
    return end < maximum ? end : maximum;
  }

  success(resultCount: number): void {
    if (resultCount <= 100) {
      this.lowVolumeSuccesses++;
      if (this.lowVolumeSuccesses >= 4) {
        this.size =
          this.size * 2n > this.maximumSize ? this.maximumSize : this.size * 2n;
        this.lowVolumeSuccesses = 0;
      }
    } else {
      this.lowVolumeSuccesses = 0;
    }
  }

  error(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);
    if (!RANGE_ERRORS.some((pattern) => message.includes(pattern))) {
      return false;
    }
    if (this.size === 1n) return false;
    this.size = this.size / 2n;
    this.lowVolumeSuccesses = 0;
    return true;
  }
}
