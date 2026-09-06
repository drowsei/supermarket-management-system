import { Router } from 'express';

import { testDatabaseConnection } from '../config/database.js';

const router = Router();

router.get('/', (request, response) => {
  response.status(200).json({
    success: true,
    message: 'Supermarket Management System API is running',
  });
});

router.get('/database', async (request, response, next) => {
  try {
    const connection = await testDatabaseConnection();

    if (!connection.connected || connection.databaseName !== process.env.DB_NAME) {
      throw new Error('The configured database did not pass its health check.');
    }

    response.status(200).json({
      success: true,
      database: 'connected',
    });
  } catch (error) {
    const healthError = new Error('Database connection is unavailable.');
    healthError.statusCode = 503;
    healthError.publicMessage = 'Database connection is unavailable.';
    healthError.cause = error;
    next(healthError);
  }
});

export default router;
