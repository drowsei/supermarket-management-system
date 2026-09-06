import HttpError from './httpError.js';

function isDuplicateEntryError(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

function rethrowDuplicateAsConflict(error, message) {
  if (isDuplicateEntryError(error)) {
    throw new HttpError(409, message, { cause: error });
  }

  throw error;
}

export { isDuplicateEntryError, rethrowDuplicateAsConflict };
