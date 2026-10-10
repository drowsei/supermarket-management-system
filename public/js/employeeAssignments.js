const NO_ACTIVE_ASSIGNMENT_MESSAGE = 'This employee has no active assignment to end.';
const NO_PRIMARY_CANDIDATE_MESSAGE = 'This employee has no active assignment to make primary.';
const ALREADY_PRIMARY_MESSAGE = "This employee's active assignment is already primary.";

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function employeeDisplayName(employee) {
  return [cleanText(employee?.firstName), cleanText(employee?.lastName)]
    .filter(Boolean)
    .join(' ');
}

export function assignmentBranchLabel(assignment) {
  const name = cleanText(assignment?.branchName);
  const code = cleanText(assignment?.branchCode);
  if (name && code) return `${name} — ${code}`;
  return name || code;
}

export function activeEmployeeAssignments(employee) {
  if (!Array.isArray(employee?.assignments)) return [];
  return employee.assignments.filter((assignment) => (
    assignment?.endedOn === null
    && typeof assignment.assignmentId === 'string'
    && assignment.assignmentId.length > 0
  ));
}

function resolveActiveAssignment(employee, unavailableMessage) {
  const assignments = activeEmployeeAssignments(employee);
  return {
    employee,
    assignments,
    selectedAssignment: assignments.length === 1 ? assignments[0] : null,
    requiresSelection: assignments.length > 1,
    unavailableMessage: assignments.length === 0 ? unavailableMessage : null,
  };
}

export function resolveEndAssignment(employee) {
  return resolveActiveAssignment(employee, NO_ACTIVE_ASSIGNMENT_MESSAGE);
}

export function resolveMakePrimaryAssignment(employee) {
  const resolution = resolveActiveAssignment(employee, NO_PRIMARY_CANDIDATE_MESSAGE);
  if (resolution.assignments.length === 1 && resolution.selectedAssignment.isPrimary) {
    return {
      ...resolution,
      selectedAssignment: null,
      unavailableMessage: ALREADY_PRIMARY_MESSAGE,
    };
  }
  return resolution;
}

export function assignmentOption(assignment) {
  const parts = [];
  const branch = assignmentBranchLabel(assignment);
  if (branch) parts.push(branch);
  if (assignment?.startedOn) parts.push(`Started ${assignment.startedOn}`);
  parts.push(`Primary: ${assignment?.isPrimary ? 'Yes' : 'No'}`);
  return { value: String(assignment.assignmentId), label: parts.join(' · ') };
}

function selectedAssignmentPathValues(resolution) {
  const assignmentId = resolution?.selectedAssignment?.assignmentId;
  return assignmentId ? { employeeBranchAssignmentId: String(assignmentId) } : {};
}

export function endAssignmentPathValues(resolution) {
  return selectedAssignmentPathValues(resolution);
}

export function makePrimaryPathValues(resolution) {
  return selectedAssignmentPathValues(resolution);
}

function assignmentSummary(resolution) {
  const employee = resolution?.employee ?? {};
  const assignment = resolution?.selectedAssignment;
  const rows = [
    { label: 'Employee', value: employeeDisplayName(employee) },
    { label: 'Employee no.', value: cleanText(employee.employeeNumber) },
  ];

  if (assignment) {
    rows.push(
      { label: 'Branch', value: assignmentBranchLabel(assignment) },
      { label: 'Started on', value: assignment.startedOn ?? '' },
      { label: 'Primary', value: assignment.isPrimary ? 'Yes' : 'No' },
    );
  } else if (resolution?.requiresSelection) {
    rows.push({ label: 'Active assignments', value: `${resolution.assignments.length}; choose one below.` });
  }

  return rows.filter((row) => row.value !== '');
}

export function endAssignmentSummary(resolution) {
  return assignmentSummary(resolution);
}

export function makePrimarySummary(resolution) {
  return assignmentSummary(resolution);
}

export function validateMakePrimarySelection(assignmentId, resolution) {
  if (typeof assignmentId !== 'string' || assignmentId.length === 0) {
    throw new Error('Select an active assignment.');
  }
  const assignment = resolution?.assignments?.find((entry) => entry.assignmentId === assignmentId);
  if (!assignment) {
    throw new Error('The selected active assignment could not be resolved. Please refresh and try again.');
  }
  if (assignment.isPrimary) throw new Error(ALREADY_PRIMARY_MESSAGE);
  return assignmentId;
}

export {
  ALREADY_PRIMARY_MESSAGE,
  NO_ACTIVE_ASSIGNMENT_MESSAGE,
  NO_PRIMARY_CANDIDATE_MESSAGE,
};
