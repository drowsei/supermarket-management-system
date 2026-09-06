import HttpError from '../utils/httpError.js';
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_CHARACTERS,
} from '../utils/password.js';

function passwordByteLength(password) {
  return Buffer.byteLength(password, 'utf8');
}

function validateLoginInput(body) {
  const identifier =
    typeof body?.identifier === 'string' ? body.identifier.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!identifier) {
    throw new HttpError(400, 'Identifier is required');
  }

  if (identifier.length > 254) {
    throw new HttpError(400, 'Identifier is too long');
  }

  if (!password) {
    throw new HttpError(400, 'Password is required');
  }

  if (passwordByteLength(password) > MAX_PASSWORD_BYTES) {
    throw new HttpError(
      400,
      `Password must not exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
    );
  }

  return { identifier, password };
}

function validateChangePasswordInput(body) {
  const currentPassword =
    typeof body?.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword =
    typeof body?.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword) {
    throw new HttpError(400, 'Current password is required');
  }

  if (!newPassword) {
    throw new HttpError(400, 'New password is required');
  }

  if (passwordByteLength(currentPassword) > MAX_PASSWORD_BYTES) {
    throw new HttpError(
      400,
      `Current password must not exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
    );
  }

  if ([...newPassword].length < MIN_PASSWORD_CHARACTERS) {
    throw new HttpError(
      400,
      `New password must contain at least ${MIN_PASSWORD_CHARACTERS} characters`,
    );
  }

  if (passwordByteLength(newPassword) > MAX_PASSWORD_BYTES) {
    throw new HttpError(
      400,
      `New password must not exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
    );
  }

  return { currentPassword, newPassword };
}

export { validateChangePasswordInput, validateLoginInput };
