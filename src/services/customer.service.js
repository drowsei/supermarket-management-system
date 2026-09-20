import { randomUUID } from 'node:crypto';

import {
  applyCustomerUpdate,
  classifyCustomerDuplicate,
  findCustomerById,
  insertCustomer,
  insertCustomerAudit,
  listCustomers as listCustomerRecords,
  lockCustomerById,
  withCustomerTransaction,
} from '../repositories/customer.repository.js';
import HttpError from '../utils/httpError.js';
import { validateCustomerState } from '../validators/customer/customer.validator.js';

const CUSTOMER_NUMBER_ATTEMPTS = 4;

function generateCustomerNumber() {
  return `CUS_${randomUUID().replaceAll('-', '').slice(0, 28).toUpperCase()}`;
}

async function listCustomers(filters) {
  return listCustomerRecords(filters);
}

async function getCustomer(customerId) {
  const customer = await findCustomerById(customerId);

  if (!customer) {
    throw new HttpError(404, 'Customer not found');
  }

  return customer;
}

async function createCustomer(values, auditContext) {
  for (let attempt = 1; attempt <= CUSTOMER_NUMBER_ATTEMPTS; attempt += 1) {
    try {
      return await withCustomerTransaction(async (connection) => {
        validateCustomerState(values);
        const customer = await insertCustomer(connection, {
          ...values,
          customerNumber: generateCustomerNumber(),
        });

        await insertCustomerAudit(connection, {
          auditContext,
          actionType: 'CUSTOMER_CREATED',
          beforeCustomer: null,
          afterCustomer: customer,
        });

        return customer;
      });
    } catch (error) {
      const duplicate = classifyCustomerDuplicate(error);

      if (duplicate === 'customer_number' && attempt < CUSTOMER_NUMBER_ATTEMPTS) {
        continue;
      }

      if (duplicate === 'loyalty_number') {
        throw new HttpError(409, 'Loyalty number already exists');
      }

      if (duplicate !== null) {
        throw new HttpError(
          409,
          duplicate === 'customer_number'
            ? 'A unique customer number could not be generated; please retry'
            : 'Customer unique data conflicts with an existing record',
        );
      }

      throw error;
    }
  }

  throw new Error('Customer-number retry loop ended unexpectedly.');
}

async function updateCustomer(customerId, changes, auditContext) {
  try {
    return await withCustomerTransaction(async (connection) => {
      const current = await lockCustomerById(connection, customerId);

      if (!current) {
        throw new HttpError(404, 'Customer not found');
      }

      const resultingCustomer = { ...current, ...changes };
      validateCustomerState(resultingCustomer);
      const changedEntries = Object.entries(changes).filter(
        ([field, value]) => current[field] !== value,
      );

      if (changedEntries.length === 0) {
        return current;
      }

      const customer = await applyCustomerUpdate(
        connection,
        customerId,
        changedEntries,
      );

      await insertCustomerAudit(connection, {
        auditContext,
        actionType: 'CUSTOMER_UPDATED',
        beforeCustomer: current,
        afterCustomer: customer,
      });

      return customer;
    });
  } catch (error) {
    const duplicate = classifyCustomerDuplicate(error);

    if (duplicate === 'loyalty_number') {
      throw new HttpError(409, 'Loyalty number already exists');
    }

    if (duplicate !== null) {
      throw new HttpError(
        409,
        'Customer unique data conflicts with an existing record',
      );
    }

    throw error;
  }
}

export { createCustomer, getCustomer, listCustomers, updateCustomer };
