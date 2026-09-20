import {
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from '../services/customer.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateCreateCustomer,
  validateCustomerId,
  validateCustomerListQuery,
  validateNoCustomerQuery,
  validateUpdateCustomer,
} from '../validators/customer/customer.validator.js';

async function listCustomerRecords(request, response) {
  const filters = validateCustomerListQuery(request.query);
  const result = await listCustomers(filters);

  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(
        filters.page,
        filters.limit,
        result.totalItems,
      ),
    },
  });
}

async function getCustomerRecord(request, response) {
  validateNoCustomerQuery(request.query);
  const customerId = validateCustomerId(request.params.customerId);
  const customer = await getCustomer(customerId);

  response.status(200).json({ success: true, data: { customer } });
}

async function createCustomerRecord(request, response) {
  validateNoCustomerQuery(request.query);
  const values = validateCreateCustomer(request.body);
  const customer = await createCustomer(values, getAuditContext(request));

  response.status(201).json({ success: true, data: { customer } });
}

async function updateCustomerRecord(request, response) {
  validateNoCustomerQuery(request.query);
  const customerId = validateCustomerId(request.params.customerId);
  const changes = validateUpdateCustomer(request.body);
  const customer = await updateCustomer(
    customerId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { customer } });
}

export {
  createCustomerRecord,
  getCustomerRecord,
  listCustomerRecords,
  updateCustomerRecord,
};
