import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite"
import { SqliteDialect } from "kysely"

// Bun 1.3.14 caches only its first 20 query() statements. Later queries are
// unowned prepare() handles. The registry has more than 20 fixed SQL strings;
// keep a bounded per-instance cache and finalize both evictions and shutdown.
// Registry callers execute queries synchronously and do not retain statements.
export class ConnectRegistryDatabase extends Database {
  private readonly statements = new Map<string, Statement>()
  override query<Result, Parameters extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) {
      if (this.statements.size >= 128) {
        const first = this.statements.keys().next().value!
        this.statements.get(first)!.finalize()
        this.statements.delete(first)
      }
      statement = this.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement as Statement<Result, Parameters extends any[] ? Parameters : [Parameters]>
  }
  override close(throwOnError = true) {
    for (const statement of this.statements.values()) statement.finalize()
    this.statements.clear()
    super.close(throwOnError)
  }
}

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
