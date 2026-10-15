import { expect, test } from "bun:test"
import { connectPeerKey } from "./server"

test("IP budgets group IPv6 privacy addresses by subnet and normalize mapped IPv4", () => {
  expect(connectPeerKey("::ffff:192.0.2.10")).toBe("192.0.2.10")
  expect(connectPeerKey("2001:db8:1234:5678::1")).toBe(connectPeerKey("2001:0db8:1234:5678:1111:2222:3333:4444"))
  expect(connectPeerKey("2001:db8::1")).not.toBe(connectPeerKey("2001:db8:1::1"))
})
