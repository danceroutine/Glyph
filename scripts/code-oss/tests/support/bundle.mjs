/**
 * @template {object} T
 * @param {unknown} value
 * @param {readonly (keyof T & string)[]} names
 * @returns {value is T}
 */
function hasExports(value, names) {
  return typeof value === 'object' && value !== null && names.every(name => name in value);
}

/**
 * @template {object} T
 * @param {string} code
 * @param {readonly (keyof T & string)[]} names
 * @returns {Promise<T>}
 */
export async function importBundle(code, names) {
  /** @type {unknown} */
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  if (!hasExports(module, names)) throw new Error(`Bundle is missing one of: ${names.join(', ')}`);
  return module;
}
