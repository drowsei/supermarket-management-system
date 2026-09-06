import dotenv from 'dotenv';

dotenv.config({ quiet: true });

let httpServer;
let databasePool;
let isShuttingDown = false;

function parsePort(variableName) {
  const rawValue = process.env[variableName];
  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${variableName} must be an integer between 1 and 65535.`);
  }

  return value;
}

function validateAccessTokenLifetime() {
  const rawLifetime = process.env.JWT_EXPIRES_IN;
  const match = /^([1-9]\d*)(s|m|h)$/.exec(rawLifetime ?? '');

  if (!match) {
    throw new Error(
      'JWT_EXPIRES_IN must use an explicit s, m, or h unit, such as 15m.',
    );
  }

  const unitSeconds = { s: 1, m: 60, h: 3600 };
  const seconds = Number(match[1]) * unitSeconds[match[2]];

  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 3600) {
    throw new Error('JWT_EXPIRES_IN must be between 60 seconds and 1 hour.');
  }
}

function validateEnvironment() {
  const requiredVariables = [
    'NODE_ENV',
    'PORT',
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'JWT_SECRET',
    'JWT_EXPIRES_IN',
    'JWT_ISSUER',
    'JWT_AUDIENCE',
    'BCRYPT_ROUNDS',
  ];
  const missingVariables = requiredVariables.filter((variableName) => {
    if (variableName === 'DB_PASSWORD') {
      return !Object.hasOwn(process.env, variableName);
    }

    return !process.env[variableName]?.trim();
  });

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVariables.join(', ')}.`,
    );
  }

  if (!['development', 'test', 'production'].includes(process.env.NODE_ENV)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }

  const port = parsePort('PORT');
  parsePort('DB_PORT');
  validateAccessTokenLifetime();

  const jwtSecret = process.env.JWT_SECRET;

  if (
    Buffer.byteLength(jwtSecret, 'utf8') < 48 ||
    /^replace[_-]?with/i.test(jwtSecret)
  ) {
    throw new Error(
      'JWT_SECRET must be a private random value of at least 48 UTF-8 bytes.',
    );
  }

  const bcryptRounds = process.env.BCRYPT_ROUNDS;

  if (!/^\d+$/.test(bcryptRounds)) {
    throw new Error('BCRYPT_ROUNDS must be an integer between 10 and 14.');
  }

  const parsedBcryptRounds = Number(bcryptRounds);

  if (parsedBcryptRounds < 10 || parsedBcryptRounds > 14) {
    throw new Error('BCRYPT_ROUNDS must be an integer between 10 and 14.');
  }

  const connectionLimit = Number(
    process.env.DB_CONNECTION_LIMIT ?? '10',
  );

  if (!Number.isInteger(connectionLimit) || connectionLimit < 1) {
    throw new Error('DB_CONNECTION_LIMIT must be a positive integer.');
  }

  return { port };
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);

    httpServer = server;

    server.once('listening', resolve);
    server.once('error', (error) => {
      httpServer = undefined;
      reject(error);
    });
  });
}

async function startServer() {
  const { port } = validateEnvironment();
  const database = await import('./config/database.js');

  databasePool = database.pool;

  const connection = await database.testDatabaseConnection();

  if (!connection.connected) {
    throw new Error('The database connectivity query returned an invalid result.');
  }

  if (connection.databaseName !== process.env.DB_NAME) {
    throw new Error(
      `Connected to an unexpected database: ${connection.databaseName ?? 'none'}.`,
    );
  }

  console.log('Database connection successful.');
  console.log(`Connected database: ${connection.databaseName}`);

  const { default: app } = await import('./app.js');

  if (isShuttingDown) {
    return;
  }

  await listen(app, port);

  console.log(`Server running on port ${port}`);
}

async function closeHttpServer() {
  if (!httpServer) {
    return;
  }

  await new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`${signal} received. Shutting down gracefully...`);

  try {
    await closeHttpServer();
    await databasePool?.end();
    console.log('HTTP server and MySQL pool closed.');
    process.exitCode = 0;
  } catch (error) {
    console.error('Graceful shutdown failed:', error.message);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

startServer().catch(async (error) => {
  if (isShuttingDown) {
    return;
  }

  console.error('Server startup failed:', error.message);

  try {
    await databasePool?.end();
  } catch (poolError) {
    console.error('Failed to close the MySQL pool:', poolError.message);
  }

  process.exitCode = 1;
});
