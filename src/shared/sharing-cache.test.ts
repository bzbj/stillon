import { expect, test } from "bun:test"
import { SharingCache, SHARING_REFRESH_MS as TTL } from "./sharing-cache"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

test("readers coalesce, reuse five-minute metadata and explicitly bypass freshness", async () => {
  let clock = 0, calls = 0
  const first = deferred<number>()
  const cache = new SharingCache(async () => ++calls === 1 ? first.promise : calls, () => clock)
  const a = cache.read(), b = cache.read(true)
  expect(a).toBe(b)
  first.resolve(1); expect(await a).toBe(1)
  clock = TTL - 1; expect(await cache.read()).toBe(1); expect(calls).toBe(1)
  expect(await cache.read(true)).toBe(2)
  clock += TTL; expect(await cache.read()).toBe(3)
})

test("a pre-mutation read cannot overwrite the new snapshot", async () => {
  const old = deferred<string>()
  const cache = new SharingCache(() => old.promise)
  const pending = cache.read(); await Promise.resolve()
  cache.set("new")
  old.resolve("old"); expect(await pending).toBe("old")
  expect(await cache.read()).toBe("new")
})

test("failures back off at five, ten and twenty minutes; force and invalidation allow recovery", async () => {
  let clock = 0, calls = 0
  const cache = new SharingCache(async () => { calls++; throw Error("offline") }, () => clock)
  for (const interval of [TTL, TTL * 2, TTL * 4, TTL * 4]) {
    await expect(cache.read()).rejects.toThrow("offline")
    const before = calls
    clock += interval - 1
    await expect(cache.read()).rejects.toThrow("offline"); expect(calls).toBe(before)
    clock++
  }
  await expect(cache.read(true)).rejects.toThrow("offline"); expect(calls).toBe(5)
  cache.invalidate()
  await expect(cache.read()).rejects.toThrow("offline"); expect(calls).toBe(6)
})
