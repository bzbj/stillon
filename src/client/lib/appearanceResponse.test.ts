import { expect, test } from "bun:test"
import { readAppearanceResponse } from "./appearanceResponse"

test("appearance errors preserve HTTP meaning when an ingress returns text or HTML", async () => {
  await expect(readAppearanceResponse(new Response("Forbidden", { status: 403 }))).rejects.toThrow("blocked (HTTP 403)")
  await expect(readAppearanceResponse(new Response("<html>Sign in</html>", { status: 401 }))).rejects.toThrow("session has expired")
  await expect(readAppearanceResponse(new Response("<html>Bad gateway</html>", { status: 502 }))).rejects.toThrow("HTTP 502")
  await expect(readAppearanceResponse(Response.json({ error: "Choose a PNG, JPEG or WebP image." }, { status: 400 }))).rejects.toThrow("Choose a PNG")
})

test("appearance responses reject invalid success payloads without a parser exception", async () => {
  for (const body of ["<html>Sign in</html>", "null", "[]", '"ok"']) {
    await expect(readAppearanceResponse(new Response(body))).rejects.toThrow("invalid appearance response")
  }
  const value = { asset: "example.png" }
  expect(await readAppearanceResponse(Response.json(value))).toEqual(value)
})
