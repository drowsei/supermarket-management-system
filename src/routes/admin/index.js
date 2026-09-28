import { Router } from 'express';

import { authenticate } from '../../middleware/auth.middleware.js';
import { requirePasswordChangeCompleted } from '../../middleware/authorization.middleware.js';
import branchRouter from './branch.routes.js';
import catalogRouter from './catalog/index.js';
import customerRouter from './customer.routes.js';
import employeeRouter from './employee.routes.js';
import paymentMethodRouter from './paymentMethod.routes.js';
import reportRouter from './report.routes.js';
import roleRouter, { permissionRouter } from './role.routes.js';
import supplierRouter from './suppliers/index.js';
import userRouter from './user.routes.js';

const router = Router();

router.use(authenticate);
router.use(requirePasswordChangeCompleted);

router.use('/branches', branchRouter);
router.use('/employees', employeeRouter);
router.use('/users', userRouter);
router.use('/roles', roleRouter);
router.use('/permissions', permissionRouter);
router.use('/catalog', catalogRouter);
router.use('/suppliers', supplierRouter);
router.use('/customers', customerRouter);
router.use('/payment-methods', paymentMethodRouter);
router.use('/reports', reportRouter);

export default router;
