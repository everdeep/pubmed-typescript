export type PubMedErrorCode =
  | "VALIDATION_ERROR"
  | "HTTP_ERROR"
  | "RATE_LIMIT_ERROR"
  | "TIMEOUT_ERROR"
  | "NETWORK_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "QUEUE_FULL"
  | "PARSE_ERROR"
  | "INVALID_RESPONSE"
  | "CURSOR_EXPIRED"
  | "CURSOR_INVALID"
  | "ABORTED"
  | "SEARCH_LIMIT";

export class PubMedError extends Error {
  public readonly code: PubMedErrorCode;
  public readonly retryable: boolean;

  public constructor(message: string, code: PubMedErrorCode, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "PubMedError";
    this.code = code;
    this.retryable = retryable;
  }

  public toJSON(): Readonly<{ name: string; message: string; code: PubMedErrorCode; retryable: boolean }> {
    return { name: this.name, message: this.message, code: this.code, retryable: this.retryable };
  }
}

export class ValidationError extends PubMedError {
  public constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class HttpError extends PubMedError {
  public readonly status: number;

  public constructor(status: number, retryable: boolean) {
    super(`PubMed request failed with HTTP status ${status}`, "HTTP_ERROR", retryable);
    this.name = "HttpError";
    this.status = status;
  }
}

export class RateLimitError extends PubMedError {
  public readonly status = 429;

  public constructor() {
    super("PubMed rate limit was exceeded", "RATE_LIMIT_ERROR", true);
    this.name = "RateLimitError";
  }
}

export class TimeoutError extends PubMedError {
  public constructor(options?: ErrorOptions) {
    super("PubMed request timed out", "TIMEOUT_ERROR", true, options);
    this.name = "TimeoutError";
  }
}

export class NetworkError extends PubMedError {
  public constructor(options?: ErrorOptions) {
    super("PubMed network request failed", "NETWORK_ERROR", true, options);
    this.name = "NetworkError";
  }
}

export class ResponseTooLargeError extends PubMedError {
  public readonly limitBytes: number;

  public constructor(limitBytes: number) {
    super(`PubMed response exceeded the configured ${limitBytes} byte limit`, "RESPONSE_TOO_LARGE");
    this.name = "ResponseTooLargeError";
    this.limitBytes = limitBytes;
  }
}

export class QueueFullError extends PubMedError {
  public constructor() {
    super("PubMed rate-limit queue is full", "QUEUE_FULL");
    this.name = "QueueFullError";
  }
}

export class ParseError extends PubMedError {
  public constructor(message = "PubMed returned malformed XML", options?: ErrorOptions) {
    super(message, "PARSE_ERROR", false, options);
    this.name = "ParseError";
  }
}

export class InvalidResponseError extends PubMedError {
  public constructor(message = "PubMed returned an invalid response", options?: ErrorOptions) {
    super(message, "INVALID_RESPONSE", false, options);
    this.name = "InvalidResponseError";
  }
}

export class CursorExpiredError extends PubMedError {
  public constructor() {
    super("The PubMed search cursor has expired", "CURSOR_EXPIRED");
    this.name = "CursorExpiredError";
  }
}

export class CursorInvalidError extends PubMedError {
  public constructor() {
    super("The PubMed search cursor is invalid", "CURSOR_INVALID");
    this.name = "CursorInvalidError";
  }
}

export class AbortedError extends PubMedError {
  public constructor(options?: ErrorOptions) {
    super("PubMed request was aborted", "ABORTED", false, options);
    this.name = "AbortedError";
  }
}

export class SearchLimitError extends PubMedError {
  public readonly limit: number;

  public constructor(limit = 10_000) {
    super(`PubMed searches cannot retrieve results beyond the ${limit} record window`, "SEARCH_LIMIT");
    this.name = "SearchLimitError";
    this.limit = limit;
  }
}
