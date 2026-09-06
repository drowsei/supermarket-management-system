import dotenv from 'dotenv';

dotenv.config({ quiet: true });

class CliError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

function parsePositiveInteger(
  variableName,
  { maximum = Number.MAX_SAFE_INTEGER } = {},
) {
  const rawValue = process.env[variableName];

  if (!/^\d+$/.test(rawValue ?? '')) {
    throw new CliError(`${variableName} must be a positive integer.`);
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new CliError(`${variableName} must be a positive integer.`);
  }

  return value;
}

function validateDatabaseEnvironment({ requireBcrypt = false } = {}) {
  const requiredVariables = [
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
  ];
  const missingVariables = requiredVariables.filter((variableName) => {
    if (variableName === 'DB_PASSWORD') {
      return !Object.hasOwn(process.env, variableName);
    }

    return !process.env[variableName]?.trim();
  });

  if (missingVariables.length > 0) {
    throw new CliError(
      `Missing required environment variables: ${missingVariables.join(', ')}.`,
    );
  }

  parsePositiveInteger('DB_PORT', { maximum: 65535 });

  if (process.env.DB_CONNECTION_LIMIT !== undefined) {
    parsePositiveInteger('DB_CONNECTION_LIMIT');
  }

  if (requireBcrypt) {
    const rawBcryptRounds = process.env.BCRYPT_ROUNDS;
    const bcryptRounds = Number(rawBcryptRounds);

    if (
      !/^\d+$/.test(rawBcryptRounds ?? '') ||
      !Number.isSafeInteger(bcryptRounds) ||
      bcryptRounds < 10 ||
      bcryptRounds > 14
    ) {
      throw new CliError(
        'BCRYPT_ROUNDS must be an integer between 10 and 14.',
      );
    }
  }
}

async function loadDatabasePool(options) {
  validateDatabaseEnvironment(options);
  const { default: pool } = await import('../../src/config/database.js');
  return pool;
}

async function verifyExpectedDatabase(connection) {
  const [rows] = await connection.execute(
    'SELECT DATABASE() AS databaseName',
  );

  if (rows[0]?.databaseName !== process.env.DB_NAME) {
    throw new CliError('Connected to an unexpected MySQL database.');
  }
}

function safeCliError(error, fallbackMessage) {
  if (error instanceof CliError || error?.name === 'AccessControlSeedError') {
    return {
      exitCode: error.exitCode ?? 1,
      message: error.message,
    };
  }

  return { exitCode: 1, message: fallbackMessage };
}

export {
  CliError,
  loadDatabasePool,
  safeCliError,
  validateDatabaseEnvironment,
  verifyExpectedDatabase,
};
