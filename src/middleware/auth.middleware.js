import { findUserById } from '../repositories/auth.repository.js';
import HttpError from '../utils/httpError.js';
import { verifyAccessToken } from '../utils/jwt.js';

const AUTHENTICATION_MESSAGE = 'Authentication required';

async function authenticate(request, response, next) {
  const authorizationHeader = request.get('authorization');
  const bearerMatch =
    typeof authorizationHeader === 'string'
      ? authorizationHeader.match(/^Bearer ([^\s]+)$/i)
      : null;

  if (!bearerMatch) {
    next(new HttpError(401, AUTHENTICATION_MESSAGE));
    return;
  }

  let tokenIdentity;

  try {
    tokenIdentity = verifyAccessToken(bearerMatch[1]);
  } catch {
    next(new HttpError(401, AUTHENTICATION_MESSAGE));
    return;
  }

  try {
    const user = await findUserById(tokenIdentity.userId);

    if (!user?.isActive) {
      next(new HttpError(401, AUTHENTICATION_MESSAGE));
      return;
    }

    request.auth = { user };
    response.set('Cache-Control', 'no-store');
    next();
  } catch (error) {
    next(error);
  }
}

export { authenticate };
