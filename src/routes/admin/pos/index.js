import { Router } from 'express';

import { loadPosBranch } from '../../../middleware/posBranch.middleware.js';
import registerRouter from './register.routes.js';
import tillRouter from './till.routes.js';

const router = Router({ mergeParams: true });

router.use('/pos-registers', loadPosBranch, registerRouter);
router.use('/till-sessions', loadPosBranch, tillRouter);

export default router;
