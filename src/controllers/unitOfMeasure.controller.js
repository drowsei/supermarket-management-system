import {
  createUnitOfMeasure,
  getUnitOfMeasure,
  listUnitOfMeasures,
  updateUnitOfMeasure,
} from '../services/unitOfMeasure.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateCreateUnitOfMeasure,
  validateUnitOfMeasureId,
  validateUnitOfMeasureListQuery,
  validateUpdateUnitOfMeasure,
} from '../validators/catalog/unitOfMeasure.validator.js';

async function listUnitOfMeasureRecords(request, response) {
  const filters = validateUnitOfMeasureListQuery(request.query);
  const result = await listUnitOfMeasures(filters);

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

async function getUnitOfMeasureRecord(request, response) {
  const unitOfMeasureId = validateUnitOfMeasureId(
    request.params.unitOfMeasureId,
  );
  const unit = await getUnitOfMeasure(unitOfMeasureId);

  response.status(200).json({ success: true, data: { unit } });
}

async function createUnitOfMeasureRecord(request, response) {
  const values = validateCreateUnitOfMeasure(request.body);
  const unit = await createUnitOfMeasure(values, getAuditContext(request));

  response.status(201).json({ success: true, data: { unit } });
}

async function updateUnitOfMeasureRecord(request, response) {
  const unitOfMeasureId = validateUnitOfMeasureId(
    request.params.unitOfMeasureId,
  );
  const changes = validateUpdateUnitOfMeasure(request.body);
  const unit = await updateUnitOfMeasure(
    unitOfMeasureId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { unit } });
}

export {
  createUnitOfMeasureRecord,
  getUnitOfMeasureRecord,
  listUnitOfMeasureRecords,
  updateUnitOfMeasureRecord,
};
