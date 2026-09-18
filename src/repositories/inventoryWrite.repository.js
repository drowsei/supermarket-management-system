import pool from '../config/database.js';
import { insertAuditLog } from './audit.repository.js';
import { withCatalogTransaction } from './productCatalog.repository.js';
import { lockOperationalContext } from './purchasing.repository.js';
import { selectInventory, selectLot } from './inventoryRead.repository.js';

async function preReadVariant(variantId) {
  const [rows] = await pool.execute(
    `SELECT CAST(product_id AS CHAR) AS productId
     FROM product_variants WHERE product_variant_id = ? LIMIT 1`,
    [variantId],
  );
  return rows[0] ?? null;
}

async function lockVariant(connection, productId, variantId) {
  const [products] = await connection.execute(
    `SELECT product_id FROM products WHERE product_id = ? FOR UPDATE`,
    [productId],
  );
  if (!products.length) return null;
  const [variants] = await connection.execute(
    `SELECT CAST(product_id AS CHAR) AS productId, is_fractional AS isFractional
     FROM product_variants WHERE product_variant_id = ? FOR UPDATE`,
    [variantId],
  );
  return variants[0]?.productId === productId ? variants[0] : null;
}

async function putInventorySettings(branchId, variantId, values, auditContext) {
  const preRead = await preReadVariant(variantId);
  if (!preRead) return { outcome: 'variant_not_found' };

  return withCatalogTransaction(async (connection) => {
    const actor = await lockOperationalContext(
      connection, branchId, auditContext.actorEmployeeId,
    );
    if (actor.outcome !== 'valid') return actor;

    const variant = await lockVariant(connection, preRead.productId, variantId);
    if (!variant) return { outcome: 'concurrent_change' };
    if (!variant.isFractional &&
        (!values.reorderLevel.endsWith('.000') ||
         !values.reorderQuantity.endsWith('.000'))) {
      return { outcome: 'fractional_quantity' };
    }

    const [rows] = await connection.execute(
      `SELECT quantity_on_hand AS quantityOnHand,
         reorder_level AS reorderLevel, reorder_quantity AS reorderQuantity,
         version_number AS versionNumber
       FROM branch_inventory
       WHERE branch_id = ? AND product_variant_id = ? FOR UPDATE`,
      [branchId, variantId],
    );
    const before = rows[0] ?? null;
    if (before?.reorderLevel === values.reorderLevel &&
        before?.reorderQuantity === values.reorderQuantity) {
      return {
        outcome: 'unchanged',
        branchInventory: await selectInventory(connection, branchId, variantId),
      };
    }

    if (!before) {
      await connection.execute(
        `INSERT INTO branch_inventory (
           branch_id, product_variant_id, quantity_on_hand,
           reorder_level, reorder_quantity, version_number
         ) VALUES (?, ?, 0.000, ?, ?, 0)`,
        [branchId, variantId, values.reorderLevel, values.reorderQuantity],
      );
    } else {
      await connection.execute(
        `UPDATE branch_inventory
         SET reorder_level = ?, reorder_quantity = ?,
           version_number = version_number + 1
         WHERE branch_id = ? AND product_variant_id = ?`,
        [values.reorderLevel, values.reorderQuantity, branchId, variantId],
      );
    }

    const branchInventory = await selectInventory(connection, branchId, variantId);
    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: before
        ? 'BRANCH_INVENTORY_SETTINGS_UPDATED'
        : 'BRANCH_INVENTORY_SETTINGS_CREATED',
      entityType: 'branch_inventory',
      entityRecordId: `${branchId}:${variantId}`,
      beforeValues: before && {
        branchId, productVariantId: variantId,
        reorderLevel: before.reorderLevel,
        reorderQuantity: before.reorderQuantity,
        versionNumber: before.versionNumber,
      },
      afterValues: {
        branchId, productVariantId: variantId,
        reorderLevel: branchInventory.reorderLevel,
        reorderQuantity: branchInventory.reorderQuantity,
        versionNumber: branchInventory.versionNumber,
      },
    });
    return { outcome: before ? 'updated' : 'created', branchInventory };
  });
}

async function preReadLot(lotId) {
  const [rows] = await pool.execute(
    `SELECT CAST(il.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM inventory_lots il
     INNER JOIN product_variants pv
       ON pv.product_variant_id = il.product_variant_id
     WHERE il.inventory_lot_id = ? LIMIT 1`,
    [lotId],
  );
  return rows[0] ?? null;
}

async function patchBranchLotStatus(branchId, lotId, status, auditContext) {
  const preRead = await preReadLot(lotId);
  if (!preRead) return { outcome: 'lot_not_found' };

  return withCatalogTransaction(async (connection) => {
    const actor = await lockOperationalContext(
      connection, branchId, auditContext.actorEmployeeId,
    );
    if (actor.outcome !== 'valid') return actor;

    const variant = await lockVariant(
      connection, preRead.productId, preRead.productVariantId,
    );
    if (!variant) return { outcome: 'concurrent_change' };

    const [lotRows] = await connection.execute(
      `SELECT CAST(product_variant_id AS CHAR) AS productVariantId, status,
         expires_on < UTC_DATE() AS isExpired
       FROM inventory_lots WHERE inventory_lot_id = ? FOR UPDATE`,
      [lotId],
    );
    const lot = lotRows[0];
    if (!lot || lot.productVariantId !== preRead.productVariantId) {
      return { outcome: 'concurrent_change' };
    }
    const [branchRows] = await connection.execute(
      `SELECT quantity_on_hand AS quantityOnHand, status,
         version_number AS versionNumber
       FROM branch_lot_inventory
       WHERE branch_id = ? AND inventory_lot_id = ? FOR UPDATE`,
      [branchId, lotId],
    );
    const before = branchRows[0];
    if (!before) return { outcome: 'lot_not_found' };

    if (status === 'AVAILABLE' &&
        (lot.status !== 'ACTIVE' || Number(lot.isExpired) === 1 ||
         before.quantityOnHand === '0.000')) {
      return { outcome: 'unsafe_available' };
    }
    if (before.status === status) {
      return { outcome: 'unchanged', branchLot: await selectLot(connection, branchId, lotId) };
    }

    await connection.execute(
      `UPDATE branch_lot_inventory
       SET status = ?, version_number = version_number + 1
       WHERE branch_id = ? AND inventory_lot_id = ?`,
      [status, branchId, lotId],
    );
    const branchLot = await selectLot(connection, branchId, lotId);
    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: 'BRANCH_LOT_STATUS_UPDATED',
      entityType: 'branch_lot_inventory',
      entityRecordId: `${branchId}:${lotId}`,
      beforeValues: {
        branchId, inventoryLotId: lotId, status: before.status,
        versionNumber: before.versionNumber,
      },
      afterValues: {
        branchId, inventoryLotId: lotId, status: branchLot.branchLotStatus,
        versionNumber: branchLot.versionNumber,
      },
    });
    return { outcome: 'updated', branchLot };
  });
}

export { patchBranchLotStatus, putInventorySettings };
