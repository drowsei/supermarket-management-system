import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number.parseInt(process.env.DB_PORT ?? '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number.parseInt(
    process.env.DB_CONNECTION_LIMIT ?? '10',
    10,
  ),
  queueLimit: 0,
  supportBigNumbers: true,
  bigNumberStrings: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

async function testDatabaseConnection() {
  let connection;

  try {
    connection = await pool.getConnection();

    const [connectionRows] = await connection.execute(
      'SELECT 1 AS connected',
    );
    const [databaseRows] = await connection.execute(
      'SELECT DATABASE() AS database_name, VERSION() AS server_version',
    );

    const connectedValue = connectionRows[0]?.connected;

    return {
      connected: connectedValue === 1 || connectedValue === '1',
      databaseName: databaseRows[0]?.database_name ?? null,
      serverVersion: databaseRows[0]?.server_version ?? null,
    };
  } finally {
    connection?.release();
  }
}

export { pool, testDatabaseConnection };
export default pool;
