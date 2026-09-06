class HttpError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.publicMessage = message;
    this.isOperational = true;
  }
}

export default HttpError;
