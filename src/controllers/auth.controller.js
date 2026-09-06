import {
  changePassword,
  getCurrentUser,
  login,
} from '../services/auth.service.js';
import {
  validateChangePasswordInput,
  validateLoginInput,
} from '../validators/auth.validator.js';
import { getAuditContext } from '../utils/auditContext.js';

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
