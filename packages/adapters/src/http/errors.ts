/**
 * Thrown by HTTP source adapters when a downstream call fails in a way the pipeline turns into a gap.
 * Schema / contract failures use `source_error`; transport and HTTP failures use the section's
 * `*_unavailable` code (or leave `gapCode` unset for the pipeline default).
 */
export class SourceAdapterError extends Error {
  readonly gapCode: string;
  readonly causeStatus?: number;

  constructor(gapCode: string, message: string, options?: { cause?: unknown; causeStatus?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SourceAdapterError';
    this.gapCode = gapCode;
    if (options?.causeStatus !== undefined) this.causeStatus = options.causeStatus;
  }
}

/** Host is not in `allowedDownstreamHosts`. */
export class DownstreamHostRefusedError extends Error {
  constructor(host: string) {
    super(`Downstream host "${host}" is not on the allow-list.`);
    this.name = 'DownstreamHostRefusedError';
  }
}

/** Circuit breaker is open for a downstream. */
export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker for "${name}" is open.`);
    this.name = 'CircuitOpenError';
  }
}
