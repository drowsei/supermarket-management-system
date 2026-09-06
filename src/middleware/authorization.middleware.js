import {
  userHasBranchPermission,
  userHasGlobalPermission,
  validatePermissionCode,
} from '../services/authorization.service.js';
import HttpError from '../utils/httpError.js';

const AUTHENTICATION_MESSAGE = 'Authentication required';
const AUTHORIZATION_MESSAGE = 'Insufficient permission';

function requireAuthenticatedContext(request, next) {
  if (!request.auth?.user?.userId) {
    next(new HttpError(401, AUTHENTICATION_MESSAGE));
    return false;
  }

  return true;
}

function requirePermission(permissionCode) {
  const configuredPermissionCode = validatePermissionCode(permissionCode);

  return async function permissionMiddleware(request, response, next) {
    if (!requireAuthenticatedContext(request, next)) {
      return;
    }

    try {
      const allowed = await userHasGlobalPermission(
        request.auth.user.userId,
        configuredPermissionCode,
      );

      if (!allowed) {
        next(new HttpError(403, AUTHORIZATION_MESSAGE));
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireBranchPermission(
  permissionCode,
  resolveBranchId = (request) => request.params.branchId,
) {
  const configuredPermissionCode = validatePermissionCode(permissionCode);

  if (typeof resolveBranchId !== 'function') {
    throw new TypeError('The branch ID resolver must be a function.');
  }

  return async function branchPermissionMiddleware(request, response, next) {
    if (!requireAuthenticatedContext(request, next)) {
      return;
    }

    try {
      const branchId = await resolveBranchId(request);
      const allowed = await userHasBranchPermission(
        request.auth.user.userId,
        branchId,
        configuredPermissionCode,
      );

      if (!allowed) {
        next(new HttpError(403, AUTHORIZATION_MESSAGE));
        return;
      }

      request.auth.branchId = String(branchId);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requirePasswordChangeCompleted(request, response, next) {
  if (!requireAuthenticatedContext(request, next)) {
    return;
  }

  if (request.auth.user.mustChangePassword) {
    next(new HttpError(403, 'Password change required'));
    return;
  }

  next();
}

export {
  requireBranchPermission,
  requirePasswordChangeCompleted,
  requirePermission,
};
