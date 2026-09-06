import {
  changePassword,
  getCurrentUser,
  login,
} from '../services/auth.service.js';
import {
  validateChangePasswordInput,
  validateLoginInput,
} from '../validators/auth.validator.js';

function truncateOptional(value, maximumLength) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  return value.slice(0, maximumLength);
}

function getAuditContext(request) {
  return {
    ipAddress: truncateOptional(request.ip, 45),
    userAgent: truncateOptional(request.get('user-agent'), 1000),
    requestId: truncateOptional(request.get('x-request-id'), 100),
  };
}

async function loginUser(request, response) {
  const { identifier, password } = validateLoginInput(request.body);
  const result = await login(identifier, password);

  response.set('Cache-Control', 'no-store');
  response.status(200).json({
    success: true,
    data: {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.expiresIn,
      user: result.user,
    },
  });
}

async function getMe(request, response) {
  const result = await getCurrentUser(request.auth.user.userId);

  response.status(200).json({
    success: true,
    data: result,
  });
}

async function changeUserPassword(request, response) {
  const { currentPassword, newPassword } = validateChangePasswordInput(
    request.body,
  );

  await changePassword({
    userId: request.auth.user.userId,
    currentPassword,
    newPassword,
    auditContext: getAuditContext(request),
  });

  response.set('Cache-Control', 'no-store');
  response.status(200).json({
    success: true,
    message: 'Password changed successfully',
  });
}

export { changeUserPassword, getMe, loginUser };
