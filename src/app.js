import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import adminRouter from './routes/admin/index.js';
import authRouter from './routes/auth.routes.js';
import healthRouter from './routes/health.routes.js';

const publicDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public',
);

const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);

app.use(express.static(publicDirectory));

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
