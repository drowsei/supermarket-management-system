import bcrypt from 'bcrypt';

const MIN_PASSWORD_CHARACTERS = 10;
const MAX_PASSWORD_BYTES = 72;

function getBcryptRounds() {
  const rawRounds = process.env.BCRYPT_ROUNDS;

  if (!/^\d+$/.test(rawRounds ?? '')) {
    throw new Error('BCRYPT_ROUNDS must be an integer between 10 and 14.');
  }

  const rounds = Number(rawRounds);

  if (rounds < 10 || rounds > 14) {
    throw new Error('BCRYPT_ROUNDS must be an integer between 10 and 14.');
  }

  return rounds;
}

function hashPassword(password) {
  return bcrypt.hash(password, getBcryptRounds());
}

function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

export {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_CHARACTERS,
  hashPassword,
  verifyPassword,
};
