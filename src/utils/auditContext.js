function truncateOptional(value, maximumLength) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  return value.slice(0, maximumLength);
}

function getAuditContext(request) {
  return {
    actorUserId: request.auth?.user?.userId ?? null,
    actorEmployeeId: request.auth?.user?.employeeId ?? null,
    ipAddress: truncateOptional(request.ip, 45),
    userAgent: truncateOptional(request.get('user-agent'), 1000),
    requestId: truncateOptional(request.get('x-request-id'), 100),
  };
}

export { getAuditContext };
