import type { Database, SQLQueryBindings } from "bun:sqlite"
import { SqliteDialect } from "kysely"

// Better Auth 1.7.10's Bun driver leaves prepare() statements to GC. That keeps
// SQLite's connection/WAL handles alive after close(), notably on Windows.
// Kysely executes each prepared statement once; finalize in every exit path.
export function connectSqliteDialect(db: Database) {
  return new SqliteDialect({ database: {
    close() { db.close(true) },
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        reader: statement.columnNames.length > 0,
        all(parameters) {
          try { return statement.all(...parameters as SQLQueryBindings[]) }
          finally { statement.finalize() }
        },
        run(parameters) {
          try { return statement.run(...parameters as SQLQueryBindings[]) }
          finally { statement.finalize() }
        },
        *iterate(parameters) {
          try { yield* statement.iterate(...parameters as SQLQueryBindings[]) }
          finally { statement.finalize() }
        },
      }
    },
  } })
}
