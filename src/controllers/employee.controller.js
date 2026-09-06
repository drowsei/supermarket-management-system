import {
  createEmployee as createEmployeeService,
  createEmployeeAssignment as createEmployeeAssignmentService,
  endEmployeeAssignment as endEmployeeAssignmentService,
  getEmployee as getEmployeeService,
  listEmployees as listEmployeesService,
  makeEmployeeAssignmentPrimary as makeEmployeeAssignmentPrimaryService,
  terminateEmployee as terminateEmployeeService,
  updateEmployee as updateEmployeeService,
} from '../services/employee.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import {
  validateCreateAssignmentInput,
  validateCreateEmployeeInput,
  validateEmployeeId,
  validateEmployeeListQuery,
  validateEmptyInput,
  validateEndAssignmentInput,
  validateTerminateEmployeeInput,
  validateUpdateEmployeeInput,
} from '../validators/admin/employee.validator.js';

async function listEmployees(request, response) {
  const query = validateEmployeeListQuery(request.query);
  const result = await listEmployeesService(query);

  response.status(200).json({ success: true, data: result });
}

async function getEmployeeById(request, response) {
  const employeeId = validateEmployeeId(request.params.employeeId);
  const employee = await getEmployeeService(employeeId);

  response.status(200).json({ success: true, data: { employee } });
}

async function createEmployee(request, response) {
  const input = validateCreateEmployeeInput(request.body);
  const employee = await createEmployeeService(
    input,
    getAuditContext(request),
  );

  response.status(201).json({ success: true, data: { employee } });
}

async function updateEmployee(request, response) {
  const employeeId = validateEmployeeId(request.params.employeeId);
  const input = validateUpdateEmployeeInput(request.body);
  const employee = await updateEmployeeService(
    employeeId,
    input,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { employee } });
}

async function terminateEmployee(request, response) {
  const employeeId = validateEmployeeId(request.params.employeeId);
  const { terminationDate } = validateTerminateEmployeeInput(request.body);
  const result = await terminateEmployeeService(
    employeeId,
    terminationDate,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    message: result.alreadyTerminated
      ? 'Employee was already terminated'
      : 'Employee terminated successfully',
    data: result,
  });
}

async function createEmployeeAssignment(request, response) {
  const employeeId = validateEmployeeId(request.params.employeeId);
  const input = validateCreateAssignmentInput(request.body);
  const assignment = await createEmployeeAssignmentService(
    employeeId,
    input,
    getAuditContext(request),
  );

  response.status(201).json({ success: true, data: { assignment } });
}

async function endEmployeeAssignment(request, response) {
  const employeeId = validateEmployeeId(request.params.employeeId);
  const assignmentId = validateEmployeeId(
    request.params.assignmentId,
    'assignmentId',
  );
  const { endedOn } = validateEndAssignmentInput(request.body);
  const result = await endEmployeeAssignmentService(
    employeeId,
    assignmentId,
    endedOn,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    message: result.alreadyEnded
      ? 'Employee branch assignment was already ended'
      : 'Employee branch assignment ended successfully',
    data: result,
  });
}

async function makeEmployeeAssignmentPrimary(request, response) {
  const employeeId = validateEmployeeId(request.params.employeeId);
  const assignmentId = validateEmployeeId(
    request.params.assignmentId,
    'assignmentId',
  );
  validateEmptyInput(request.body ?? {});
  const result = await makeEmployeeAssignmentPrimaryService(
    employeeId,
    assignmentId,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    message: result.alreadyPrimary
      ? 'Employee branch assignment is already primary'
      : 'Primary employee branch changed successfully',
    data: result,
  });
}

export {
  createEmployee,
  createEmployeeAssignment,
  endEmployeeAssignment,
  getEmployeeById,
  listEmployees,
  makeEmployeeAssignmentPrimary,
  terminateEmployee,
  updateEmployee,
};
