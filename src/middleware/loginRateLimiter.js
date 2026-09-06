import { rateLimit } from 'express-rate-limit';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;

function createLoginRateLimiter(options = {}) {
  return rateLimit({
    windowMs: options.windowMs ?? LOGIN_WINDOW_MS,
    limit: options.limit ?? LOGIN_ATTEMPT_LIMIT,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler(request, response) {
      response.status(429).json({
        success: false,
        message: 'Too many login attempts. Please try again later.',
      });
    },
  });
}

const loginRateLimiter = createLoginRateLimiter();

export {
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_WINDOW_MS,
  createLoginRateLimiter,
  loginRateLimiter,
};
