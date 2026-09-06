import {
  createAssignmentRecord,
  createEmployeeRecord,
  endAssignmentRecord,
  findAssignmentsByEmployeeId,
  findEmployeeById,
  listEmployees as listEmployeeRecords,
  makeAssignmentPrimaryRecord,
  terminateEmployeeRecord,
  updateEmployeeRecord,
} from '../repositories/employee.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';

function countAsSafeNumber(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('The employee count query returned an invalid result.');
  }

  const count = BigInt(value);

  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The employee count exceeds the supported API range.');
  }

  return Number(count);
}

async function listEmployees(query) {
  const result = await listEmployeeRecords(query);
  const totalItems = countAsSafeNumber(result.totalItems);

  return {
    items: result.items,
    pagination: paginationMetadata(query.page, query.limit, totalItems),
  };
}

async function getEmployee(employeeId) {
  const employee = await findEmployeeById(employeeId);

  if (!employee) {
    throw new HttpError(404, 'Employee not found');
  }

  const assignments = await findAssignmentsByEmployeeId(employeeId);

  return { ...employee, assignments };
}

async function createEmployee(input, auditContext) {
  try {
    return await createEmployeeRecord(input, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'An employee with that employee number or email already exists',
    );
  }
}

async function updateEmployee(employeeId, update, auditContext) {
  let result;

  try {
    result = await updateEmployeeRecord(employeeId, update, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'An employee with that employee number or email already exists',
    );
  }

  if (result.outcome === 'not_found') {
    throw new HttpError(404, 'Employee not found');
  }

  if (result.outcome === 'terminated') {
    throw new HttpError(409, 'A terminated employee cannot be edited');
  }

  if (result.outcome === 'assignment_date_conflict') {
    throw new HttpError(
      409,
      'hireDate cannot be later than an existing branch assignment start date',
    );
  }

  return result.employee;
}

async function terminateEmployee(employeeId, terminationDate, auditContext) {
  const result = await terminateEmployeeRecord(
    employeeId,
    terminationDate,
    auditContext,
  );

  switch (result.outcome) {
    case 'not_found':
      throw new HttpError(404, 'Employee not found');
    case 'different_termination_date':
      throw new HttpError(
        409,
        'Employee is already terminated with a different termination date',
      );
    case 'before_hire_date':
      throw new HttpError(400, 'terminationDate cannot be before hireDate');
    case 'future_termination_date':
      throw new HttpError(400, 'terminationDate cannot be in the future');
    default:
      return {
        employee: result.employee,
        linkedUserDeactivated: result.linkedUserDeactivated,
        endedAssignmentIds: result.endedAssignmentIds,
        alreadyTerminated: result.outcome === 'unchanged',
      };
  }
}

async function createEmployeeAssignment(employeeId, input, auditContext) {
  let result;

  try {
    result = await createAssignmentRecord(employeeId, input, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'This employee already has the requested assignment or another open primary assignment',
    );
  }

  switch (result.outcome) {
    case 'employee_not_found':
      throw new HttpError(404, 'Employee not found');
    case 'employee_terminated':
      throw new HttpError(409, 'A terminated employee cannot be assigned');
    case 'branch_not_found':
      throw new HttpError(404, 'Branch not found');
    case 'branch_not_active':
      throw new HttpError(409, 'Employees can only be assigned to an active branch');
    case 'before_hire_date':
      throw new HttpError(400, 'startedOn cannot be before the employee hireDate');
    case 'future_primary_assignment':
      throw new HttpError(400, 'A future assignment cannot be made primary yet');
    case 'overlapping_assignment':
      throw new HttpError(
        409,
        'The employee already has an overlapping assignment at this branch',
      );
    default:
      return result.assignment;
  }
}

async function endEmployeeAssignment(
  employeeId,
  assignmentId,
  endedOn,
  auditContext,
) {
  const result = await endAssignmentRecord(
    employeeId,
    assignmentId,
    endedOn,
    auditContext,
  );

  switch (result.outcome) {
    case 'employee_not_found':
      throw new HttpError(404, 'Employee not found');
    case 'assignment_not_found':
      throw new HttpError(404, 'Employee branch assignment not found');
    case 'already_ended':
      throw new HttpError(
        409,
        'Assignment is already ended with a different end date',
      );
    case 'before_start_date':
      throw new HttpError(400, 'endedOn cannot be before startedOn');
    case 'future_end_date':
      throw new HttpError(400, 'endedOn cannot be in the future');
    default:
      return {
        assignment: result.assignment,
        alreadyEnded: result.outcome === 'unchanged',
      };
  }
}

async function makeEmployeeAssignmentPrimary(
  employeeId,
  assignmentId,
  auditContext,
) {
  const result = await makeAssignmentPrimaryRecord(
    employeeId,
    assignmentId,
    auditContext,
  );

  switch (result.outcome) {
    case 'employee_not_found':
      throw new HttpError(404, 'Employee not found');
    case 'employee_terminated':
      throw new HttpError(
        409,
        'A terminated employee cannot have a primary assignment',
      );
    case 'assignment_not_found':
      throw new HttpError(404, 'Employee branch assignment not found');
    case 'assignment_ended':
      throw new HttpError(409, 'An ended assignment cannot be made primary');
    case 'assignment_not_started':
      throw new HttpError(409, 'An assignment cannot be primary before it starts');
    case 'branch_not_active':
      throw new HttpError(409, 'An assignment at an inactive branch cannot be primary');
    default:
      return {
        assignment: result.assignment,
        alreadyPrimary: result.outcome === 'unchanged',
      };
  }
}

export {
  createEmployee,
  createEmployeeAssignment,
  endEmployeeAssignment,
  getEmployee,
  listEmployees,
  makeEmployeeAssignmentPrimary,
  terminateEmployee,
  updateEmployee,
};
