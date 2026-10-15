import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { LoginGuard } from "./login-guard"

describe("Connect rolling send budgets", () => {
  test("retains global and source limits while individual account keys change", () => {
    const db = new Database(":memory:")
    try {
      let now = 100_000
      const guard = new LoginGuard(db, "test-secret", () => now)
      const budgets = (email: string) => [{ key: `email:${email}`, max: 1, windowSeconds: 60 }, { key: "global", max: 2, windowSeconds: 60 }]
      expect(guard.consume(budgets("a"))).toBeNull()
      now += 1_000
      expect(guard.consume(budgets("b"))).toBeNull()
      expect(guard.consume(budgets("c"))).toBe(59)
      now += 59_001
      expect(guard.consume(budgets("c"))).toBeNull()
    } finally { db.close() }
  })

  test("a blocked budget does not partially consume the other budgets", () => {
    const db = new Database(":memory:")
    try {
      const guard = new LoginGuard(db, "test-secret", () => 100_000)
      expect(guard.consume([{ key: "email", max: 1, windowSeconds: 60 }])).toBeNull()
      expect(guard.consume([{ key: "email", max: 1, windowSeconds: 60 }, { key: "global", max: 1, windowSeconds: 60 }])).toBe(60)
      expect(guard.consume([{ key: "global", max: 1, windowSeconds: 60 }])).toBeNull()
    } finally { db.close() }
  })
})
