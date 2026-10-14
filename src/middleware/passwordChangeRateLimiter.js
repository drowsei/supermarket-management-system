import { rateLimit } from 'express-rate-limit';

const PASSWORD_CHANGE_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_CHANGE_ATTEMPT_LIMIT = 10;

// Mount after authenticate: rotating IP addresses must not reset a user's budget.
const passwordChangeRateLimiter = rateLimit({
  windowMs: PASSWORD_CHANGE_WINDOW_MS,
  limit: PASSWORD_CHANGE_ATTEMPT_LIMIT,
  keyGenerator: (request) => request.auth.user.userId,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler(request, response) {
    response.status(429).json({
      success: false,
      message: 'Too many password change attempts. Please try again later.',
    });
  },
});

export {
  PASSWORD_CHANGE_ATTEMPT_LIMIT,
  PASSWORD_CHANGE_WINDOW_MS,
  passwordChangeRateLimiter,
};
