import { Router } from 'express';

import { authenticate } from '../../middleware/auth.middleware.js';
import { requirePasswordChangeCompleted } from '../../middleware/authorization.middleware.js';
import branchRouter from './branch.routes.js';
import employeeRouter from './employee.routes.js';
import roleRouter, { permissionRouter } from './role.routes.js';
import userRouter from './user.routes.js';

const router = Router();

router.use(authenticate);
router.use(requirePasswordChangeCompleted);

router.use('/branches', branchRouter);
router.use('/employees', employeeRouter);
router.use('/users', userRouter);
router.use('/roles', roleRouter);
router.use('/permissions', permissionRouter);

export default router;
