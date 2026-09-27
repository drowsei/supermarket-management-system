import {
  createPaymentMethod,
  getPaymentMethod,
  listPaymentMethods,
  updatePaymentMethod,
} from '../services/paymentMethod.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateCreatePaymentMethod,
  validatePaymentMethodId,
  validatePaymentMethodListQuery,
  validateUpdatePaymentMethod,
} from '../validators/payments/paymentMethod.validator.js';
import {
  validateNoQuery,
} from '../validators/payments/common.validator.js';

async function listPaymentMethodRecords(request, response) {
  const filters = validatePaymentMethodListQuery(request.query);
  const result = await listPaymentMethods(filters);

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

async function getPaymentMethodRecord(request, response) {
  validateNoQuery(request.query);
  const paymentMethod = await getPaymentMethod(
    validatePaymentMethodId(request.params.paymentMethodId),
  );

  response.status(200).json({ success: true, data: { paymentMethod } });
}

async function createPaymentMethodRecord(request, response) {
  validateNoQuery(request.query);
  const paymentMethod = await createPaymentMethod(
    validateCreatePaymentMethod(request.body),
    getAuditContext(request),
  );

  response.status(201).json({ success: true, data: { paymentMethod } });
}

async function updatePaymentMethodRecord(request, response) {
  validateNoQuery(request.query);
  const paymentMethod = await updatePaymentMethod(
    validatePaymentMethodId(request.params.paymentMethodId),
    validateUpdatePaymentMethod(request.body),
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { paymentMethod } });
}

export {
  createPaymentMethodRecord,
  getPaymentMethodRecord,
  listPaymentMethodRecords,
  updatePaymentMethodRecord,
};
