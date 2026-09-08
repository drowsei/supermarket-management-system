import pool from '../config/database.js';
import HttpError from '../utils/httpError.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';

const CATEGORY_HIERARCHY_LOCK_NAME =
  'supermarket_management:category_hierarchy';
const CATEGORY_HIERARCHY_LOCK_TIMEOUT_SECONDS = 10;
const LOCK_QUERY_BATCH_SIZE = 500;

const CATEGORY_COLUMNS = `
  CAST(c.category_id AS CHAR) AS categoryId,
  CAST(c.parent_category_id AS CHAR) AS parentCategoryId,
  c.category_code AS categoryCode,
  c.category_name AS categoryName,
  c.description,
  c.is_active AS isActive,
  c.created_at AS createdAt,
  c.updated_at AS updatedAt
`;

const CATEGORY_UPDATE_COLUMNS = Object.freeze({
  parentCategoryId: 'parent_category_id',
  categoryCode: 'category_code',
  categoryName: 'category_name',
  description: 'description',
  isActive: 'is_active',
});

function countAsSafeNumber(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('The category count query returned an invalid result.');
  }

  const count = BigInt(value);

  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The category count exceeds the supported API range.');
  }

  return Number(count);
}

function normalizeCategory(row) {
  if (!row) {
    return null;
  }

  return {
    categoryId: row.categoryId,
    parentCategoryId: row.parentCategoryId,
    categoryCode: row.categoryCode,
    categoryName: row.categoryName,
    description: row.description,
    isActive: databaseBoolean(row.isActive),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function categoryAuditSnapshot(category) {
  return {
    categoryId: category.categoryId,
    parentCategoryId: category.parentCategoryId,
    categoryCode: category.categoryCode,
    categoryName: category.categoryName,
    description: category.description,
    isActive: category.isActive,
  };
}

async function acquireCategoryHierarchyLock(connection) {
  const [rows] = await connection.execute(
    'SELECT GET_LOCK(?, ?) AS acquired',
    [
      CATEGORY_HIERARCHY_LOCK_NAME,
      CATEGORY_HIERARCHY_LOCK_TIMEOUT_SECONDS,
    ],
  );

  if (!databaseBoolean(rows[0]?.acquired)) {
    throw new HttpError(
      503,
      'Category hierarchy is busy; please try again',
    );
  }
}

async function releaseCategoryHierarchyLock(connection) {
  const [rows] = await connection.execute(
    'SELECT RELEASE_LOCK(?) AS released',
    [CATEGORY_HIERARCHY_LOCK_NAME],
  );

  return databaseBoolean(rows[0]?.released);
}

async function withCategoryMutationTransaction(work) {
  const connection = await pool.getConnection();
  let hierarchyLockAcquired = false;
  let transactionStarted = false;
  let discardConnection = false;

  try {
    // GET_LOCK is connection-scoped, so it must be acquired before BEGIN and
    // explicitly released after COMMIT/ROLLBACK on this same connection.
    await acquireCategoryHierarchyLock(connection);
    hierarchyLockAcquired = true;
    await connection.beginTransaction();
    transactionStarted = true;

    const result = await work(connection);

    await connection.commit();
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
        transactionStarted = false;
      } catch (rollbackError) {
        discardConnection = true;

        try {
          error.rollbackError = rollbackError;
        } catch {
          // Preserve the original failure even if it is not extensible.
        }
      }
    }

    throw error;
  } finally {
    if (hierarchyLockAcquired) {
      try {
        const released = await releaseCategoryHierarchyLock(connection);

        if (!released) {
          discardConnection = true;
        }
      } catch {
        discardConnection = true;
      }
    }

    if (discardConnection) {
      try {
        connection.destroy();
      } catch {
        // A failed/detached connection must never be returned to the pool.
      }
    } else {
      try {
        connection.release();
      } catch {
        try {
          connection.destroy();
        } catch {
          // Cleanup failure must not turn a committed write into a retryable
          // API failure with an ambiguous transaction outcome.
        }
      }
    }
  }
}

async function getLastInsertId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId',
  );

  return rows[0].insertedId;
}

async function selectCategory(
  executor,
  categoryId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${CATEGORY_COLUMNS}
     FROM categories c
     WHERE c.category_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [categoryId],
  );

  return normalizeCategory(rows[0]);
}

async function lockAndInspectParentChain(
  connection,
  parentCategoryId,
  categoryId = null,
) {
  if (parentCategoryId === null) {
    return { outcome: 'valid', parentCategory: null };
  }

  const visitedCategoryIds = new Set();
  let currentCategoryId = parentCategoryId;
  let parentCategory = null;

  while (currentCategoryId !== null) {
    if (
      currentCategoryId === categoryId ||
      visitedCategoryIds.has(currentCategoryId)
    ) {
      return { outcome: 'hierarchy_cycle' };
    }

    visitedCategoryIds.add(currentCategoryId);
    const currentCategory = await selectCategory(
      connection,
      currentCategoryId,
      { forUpdate: true },
    );

    if (!currentCategory) {
      return { outcome: 'parent_not_found' };
    }

    if (parentCategory === null) {
      parentCategory = currentCategory;
    }

    currentCategoryId = currentCategory.parentCategoryId;
  }

  return { outcome: 'valid', parentCategory };
}

async function selectChildCategoriesForUpdate(connection, parentIds) {
  const placeholders = parentIds.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT
       CAST(c.category_id AS CHAR) AS categoryId,
       CAST(c.parent_category_id AS CHAR) AS parentCategoryId,
       c.is_active AS isActive
     FROM categories c
     WHERE c.parent_category_id IN (${placeholders})
     ORDER BY c.category_id
     FOR UPDATE`,
    parentIds,
  );

  return rows.map((row) => ({
    categoryId: row.categoryId,
    parentCategoryId: row.parentCategoryId,
    isActive: databaseBoolean(row.isActive),
  }));
}

async function lockCategorySubtree(connection, rootCategory) {
  const categories = [
    {
      categoryId: rootCategory.categoryId,
      parentCategoryId: rootCategory.parentCategoryId,
      isActive: rootCategory.isActive,
    },
  ];
  const visitedCategoryIds = new Set([rootCategory.categoryId]);
  let frontier = [rootCategory.categoryId];

  while (frontier.length > 0) {
    const nextFrontier = [];

    for (
      let index = 0;
      index < frontier.length;
      index += LOCK_QUERY_BATCH_SIZE
    ) {
      const children = await selectChildCategoriesForUpdate(
        connection,
        frontier.slice(index, index + LOCK_QUERY_BATCH_SIZE),
      );

      for (const child of children) {
        if (visitedCategoryIds.has(child.categoryId)) {
          return { outcome: 'hierarchy_cycle' };
        }

        visitedCategoryIds.add(child.categoryId);
        categories.push(child);
        nextFrontier.push(child.categoryId);
      }
    }

    frontier = nextFrontier;
  }

  return { outcome: 'valid', categories };
}

async function subtreeHasActiveProduct(connection, categoryIds) {
  for (
    let index = 0;
    index < categoryIds.length;
    index += LOCK_QUERY_BATCH_SIZE
  ) {
    const categoryIdBatch = categoryIds.slice(
      index,
      index + LOCK_QUERY_BATCH_SIZE,
    );
    const placeholders = categoryIdBatch.map(() => '?').join(', ');
    const [rows] = await connection.execute(
      `SELECT
         CAST(p.product_id AS CHAR) AS productId,
         p.status
       FROM products p
       WHERE p.category_id IN (${placeholders})
       ORDER BY p.category_id, p.product_id
       FOR UPDATE`,
      categoryIdBatch,
    );

    if (rows.some((row) => row.status === 'ACTIVE')) {
      return true;
    }
  }

  return false;
}

async function listCategories({
  search,
  isActive,
  parentCategoryId,
  limit,
  offset,
}) {
  const predicates = [];
  const parameters = [];

  if (search) {
    predicates.push(`LOCATE(
      ?,
      CONCAT_WS(
        ' ',
        c.category_code,
        c.category_name,
        COALESCE(c.description, '')
      )
    ) > 0`);
    parameters.push(search);
  }

  if (isActive !== null) {
    predicates.push('c.is_active = ?');
    parameters.push(isActive ? 1 : 0);
  }

  if (parentCategoryId !== undefined) {
    if (parentCategoryId === null) {
      predicates.push('c.parent_category_id IS NULL');
    } else {
      predicates.push('c.parent_category_id = ?');
      parameters.push(parentCategoryId);
    }
  }

  const whereClause =
    predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM categories c
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${CATEGORY_COLUMNS}
     FROM categories c
     ${whereClause}
     ORDER BY c.category_name, c.category_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeCategory),
    totalItems: countAsSafeNumber(countRows[0].totalItems),
  };
}

async function findCategoryById(categoryId) {
  return selectCategory(pool, categoryId);
}

async function createCategoryRecord(values, auditContext) {
  return withCategoryMutationTransaction(async (connection) => {
    const parentResult = await lockAndInspectParentChain(
      connection,
      values.parentCategoryId,
    );

    if (parentResult.outcome !== 'valid') {
      return parentResult;
    }

    if (
      values.isActive &&
      parentResult.parentCategory !== null &&
      !parentResult.parentCategory.isActive
    ) {
      return { outcome: 'inactive_parent' };
    }

    await connection.execute(
      `INSERT INTO categories (
         parent_category_id,
         category_code,
         category_name,
         description,
         is_active
       ) VALUES (?, ?, ?, ?, ?)`,
      [
        values.parentCategoryId,
        values.categoryCode,
        values.categoryName,
        values.description,
        values.isActive ? 1 : 0,
      ],
    );
    const categoryId = await getLastInsertId(connection);
    const category = await selectCategory(connection, categoryId);

    await insertAuditLog(connection, {
      auditContext,
      branchId: null,
      actionType: 'CATEGORY_CREATED',
      entityType: 'categories',
      entityRecordId: categoryId,
      beforeValues: null,
      afterValues: categoryAuditSnapshot(category),
      notes: 'Category created through the catalog administration API.',
    });

    return { outcome: 'created', category };
  });
}

async function updateCategoryRecord(categoryId, changes, auditContext) {
  return withCategoryMutationTransaction(async (connection) => {
    const currentCategory = await selectCategory(connection, categoryId, {
      forUpdate: true,
    });

    if (!currentCategory) {
      return { outcome: 'not_found' };
    }

    const resultingParentCategoryId = Object.hasOwn(
      changes,
      'parentCategoryId',
    )
      ? changes.parentCategoryId
      : currentCategory.parentCategoryId;
    const resultingIsActive = Object.hasOwn(changes, 'isActive')
      ? changes.isActive
      : currentCategory.isActive;
    const parentResult = await lockAndInspectParentChain(
      connection,
      resultingParentCategoryId,
      categoryId,
    );

    if (parentResult.outcome !== 'valid') {
      return parentResult;
    }

    if (
      resultingIsActive &&
      parentResult.parentCategory !== null &&
      !parentResult.parentCategory.isActive
    ) {
      return { outcome: 'inactive_parent' };
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => currentCategory[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', category: currentCategory };
    }

    if (currentCategory.isActive && !resultingIsActive) {
      const subtreeResult = await lockCategorySubtree(
        connection,
        currentCategory,
      );

      if (subtreeResult.outcome !== 'valid') {
        return subtreeResult;
      }

      if (
        subtreeResult.categories
          .slice(1)
          .some((category) => category.isActive)
      ) {
        return { outcome: 'active_descendant_dependency' };
      }

      const hasActiveProduct = await subtreeHasActiveProduct(
        connection,
        subtreeResult.categories.map((category) => category.categoryId),
      );

      if (hasActiveProduct) {
        return { outcome: 'active_product_dependency' };
      }
    }

    const assignments = changedEntries.map(
      ([field]) => `${CATEGORY_UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([field, value]) =>
      field === 'isActive' ? (value ? 1 : 0) : value,
    );

    await connection.execute(
      `UPDATE categories
       SET ${assignments.join(', ')}
       WHERE category_id = ?`,
      [...parameters, categoryId],
    );
    const category = await selectCategory(connection, categoryId);

    await insertAuditLog(connection, {
      auditContext,
      branchId: null,
      actionType: 'CATEGORY_UPDATED',
      entityType: 'categories',
      entityRecordId: categoryId,
      beforeValues: categoryAuditSnapshot(currentCategory),
      afterValues: categoryAuditSnapshot(category),
      notes: 'Category updated through the catalog administration API.',
    });

    return { outcome: 'updated', category };
  });
}

export {
  createCategoryRecord,
  findCategoryById,
  listCategories,
  updateCategoryRecord,
};
