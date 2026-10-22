/**
 * @param {unknown} error
 * @param {string} code
 */
export function hasErrorCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
