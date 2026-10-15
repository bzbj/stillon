import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Kysely, sql } from "kysely"
import { connectSqliteDialect } from "./sqlite"

test("auth SQL releases handles after results, constraint failures and rolled-back transactions", async () => {
  const raw = new Database(":memory:", { strict: true })
  const db = new Kysely({ dialect: connectSqliteDialect(raw) })
  try {
    await sql`CREATE TABLE sample (id INTEGER PRIMARY KEY, content BLOB)`.execute(db)
    const content = new Uint8Array([0, 42, 255])
    expect((await sql`INSERT INTO sample VALUES (1, ${content}) RETURNING id`.execute(db)).rows).toEqual([{ id: 1 }])
    await expect(sql`INSERT INTO sample VALUES (1, ${content})`.execute(db)).rejects.toThrow()
    await expect(db.transaction().execute(async transaction => {
      await sql`INSERT INTO sample VALUES (2, ${content})`.execute(transaction)
      throw new Error("rollback")
    })).rejects.toThrow("rollback")
    expect((await sql`SELECT * FROM sample`.execute(db)).rows).toEqual([{ id: 1, content }])
    // Unlike close(false), this fails on Bun 1.3.14 if prepare() handles remain.
    expect(() => raw.close(true)).not.toThrow()
  } finally { await db.destroy() }
})

test("cancelling a streamed SQL result releases the statement", async () => {
  const raw = new Database(":memory:")
  const db = new Kysely<{ sample: { id: number } }>({ dialect: connectSqliteDialect(raw) })
  try {
    await sql`CREATE TABLE sample (id INTEGER)`.execute(db)
    await sql`INSERT INTO sample VALUES (1), (2)`.execute(db)
    for await (const row of db.selectFrom("sample").selectAll().stream()) {
      expect(row.id).toBe(1)
      break
    }
    expect(() => raw.close(true)).not.toThrow()
  } finally { await db.destroy() }
})
