import jwt from 'jsonwebtoken';

const JWT_ALGORITHM = 'HS256';
const MAX_UNSIGNED_BIGINT = 18446744073709551615n;

function isUnsignedBigIntId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) {
    return false;
  }

  try {
    return BigInt(value) <= MAX_UNSIGNED_BIGINT;
  } catch {
    return false;
  }
}

function getJwtConfiguration() {
  return {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN,
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
  };
}

function signAccessToken(userId) {
  const subject = String(userId);

  if (!isUnsignedBigIntId(subject)) {
    throw new Error('Cannot issue an access token with an invalid user ID.');
  }

  const { secret, expiresIn, issuer, audience } = getJwtConfiguration();
  const accessToken = jwt.sign({}, secret, {
    algorithm: JWT_ALGORITHM,
    audience,
    expiresIn,
    issuer,
    subject,
  });

  return {
    accessToken,
    expiresIn,
  };
}

function verifyAccessToken(accessToken) {
  const { secret, issuer, audience } = getJwtConfiguration();
  const payload = jwt.verify(accessToken, secret, {
    algorithms: [JWT_ALGORITHM],
    audience,
    issuer,
  });

  if (
    typeof payload !== 'object' ||
    payload === null ||
    !isUnsignedBigIntId(payload.sub)
  ) {
    throw new Error('The access token subject is invalid.');
  }

  return { userId: payload.sub };
}

export {
  JWT_ALGORITHM,
  isUnsignedBigIntId,
  signAccessToken,
  verifyAccessToken,
};
