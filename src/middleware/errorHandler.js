function notFoundHandler(request, response) {
  response.status(404).json({
    success: false,
    message: 'Route not found',
  });
}

function errorHandler(error, request, response, next) {
  if (response.headersSent) {
    next(error);
    return;
  }

  const providedStatusCode = error.statusCode ?? error.status;
  const statusCode =
    Number.isInteger(providedStatusCode) &&
    providedStatusCode >= 400 &&
    providedStatusCode <= 599
      ? providedStatusCode
      : 500;
  const diagnosticError = error.cause ?? error;
  const isInvalidJson = error.type === 'entity.parse.failed';
  const diagnosticMessage = isInvalidJson
    ? 'Invalid JSON request body'
    : diagnosticError.message;

  console.error(`${request.method} ${request.originalUrl} failed`, {
    statusCode,
    code: diagnosticError.code,
    message: diagnosticMessage,
  });

  if (
    process.env.NODE_ENV === 'development' &&
    !error.isOperational &&
    !isInvalidJson
  ) {
    console.error(diagnosticError.stack);
  }

  let clientMessage = error.publicMessage;

  if (isInvalidJson) {
    clientMessage = 'Invalid JSON request body';
  } else if (!clientMessage) {
    clientMessage = statusCode >= 500 ? 'Internal server error' : 'Request failed';
  }

  response.status(statusCode).json({
    success: false,
    message: clientMessage,
  });
}

export { errorHandler, notFoundHandler };
