import { Router } from 'express';

import {
  changeUserPassword,
  getMe,
  loginUser,
} from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { loginRateLimiter } from '../middleware/loginRateLimiter.js';

const router = Router();

router.post('/login', loginRateLimiter, loginUser);
router.get('/me', authenticate, getMe);
router.post('/change-password', authenticate, changeUserPassword);

export default router;
