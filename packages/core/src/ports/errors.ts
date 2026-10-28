/** Credentials are missing, malformed, expired or not accepted in this environment. Maps to HTTP 401. */
export class IdentityRejectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IdentityRejectedError';
    this.code = code;
  }
}
