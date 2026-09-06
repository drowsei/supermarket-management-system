import { Router } from 'express';

import {
  createEmployee,
  createEmployeeAssignment,
  endEmployeeAssignment,
  getEmployeeById,
  listEmployees,
  makeEmployeeAssignmentPrimary,
  terminateEmployee,
  updateEmployee,
} from '../../controllers/employee.controller.js';
import { requirePermission } from '../../middleware/authorization.middleware.js';

const router = Router();

router.get('/', requirePermission('employees.read'), listEmployees);
router.post('/', requirePermission('employees.manage'), createEmployee);
router.get('/:employeeId', requirePermission('employees.read'), getEmployeeById);
router.patch(
  '/:employeeId',
  requirePermission('employees.manage'),
  updateEmployee,
);
router.post(
  '/:employeeId/terminate',
  requirePermission('employees.manage'),
  terminateEmployee,
);
router.post(
  '/:employeeId/assignments',
  requirePermission('employees.manage'),
  createEmployeeAssignment,
);
router.post(
  '/:employeeId/assignments/:assignmentId/end',
  requirePermission('employees.manage'),
  endEmployeeAssignment,
);
router.post(
  '/:employeeId/assignments/:assignmentId/make-primary',
  requirePermission('employees.manage'),
  makeEmployeeAssignmentPrimary,
);

export default router;
