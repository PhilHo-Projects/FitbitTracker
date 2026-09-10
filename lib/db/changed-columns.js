// Identifiers come only from internal schema constants. This null-safe predicate
// works in both PostgreSQL and the fixture database, including JSONB comparisons.
// A repeated provider page must not generate new row versions just to set updated_at.
export function changedColumns(table, columns) {
  return columns.map(column => `(${table}.${column} <> EXCLUDED.${column}
    OR (${table}.${column} IS NULL) <> (EXCLUDED.${column} IS NULL))`).join(' OR ');
}
