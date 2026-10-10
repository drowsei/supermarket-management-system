export function createActionWorkflow(values, pathOnly = []) {
  const pathValues = { ...values };
  const requestBody = { ...values };
  for (const field of pathOnly) delete requestBody[field];
  let status = 'pending';

  return {
    pathValues,
    requestBody,
    get status() { return status; },
    cancel() {
      if (status !== 'pending') return false;
      status = 'cancelled';
      return { confirmed: false, submitted: false, values: pathValues };
    },
    async confirm(execute) {
      if (status !== 'pending') return { confirmed: status === 'submitted', submitted: false, values: pathValues };
      status = 'submitting';
      try {
        const result = await execute(requestBody, pathValues);
        status = 'submitted';
        return { confirmed: true, submitted: true, values: pathValues, result };
      } catch (error) {
        status = 'pending';
        throw error;
      }
    },
  };
}
