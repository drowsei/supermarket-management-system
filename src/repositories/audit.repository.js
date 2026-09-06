async function insertAuditLog(connection, entry) {
  const beforeValues =
    entry.beforeValues === null || entry.beforeValues === undefined
      ? null
      : JSON.stringify(entry.beforeValues);
  const afterValues =
    entry.afterValues === null || entry.afterValues === undefined
      ? null
      : JSON.stringify(entry.afterValues);

  await connection.execute(
    `INSERT INTO audit_logs (
       user_id,
       employee_id,
       branch_id,
       action_type,
       entity_type,
       entity_record_id,
       before_values,
       after_values,
       ip_address,
       user_agent,
       request_id,
       notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.auditContext?.actorUserId ?? null,
      entry.auditContext?.actorEmployeeId ?? null,
      entry.branchId ?? null,
      entry.actionType,
      entry.entityType,
      String(entry.entityRecordId),
      beforeValues,
      afterValues,
      entry.auditContext?.ipAddress ?? null,
      entry.auditContext?.userAgent ?? null,
      entry.auditContext?.requestId ?? null,
      entry.notes ?? null,
    ],
  );
}

export { insertAuditLog };
