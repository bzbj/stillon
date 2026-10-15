export interface LoginEmail {
  email: string
  code: string
  expiresInMinutes: number
}

export interface LoginEmailSender {
  send(message: LoginEmail): Promise<void>
}

/** Delivery is injected so the account service is independent of its mail vendor. */
export function createResendSender(options: {
  apiKey: string
  from: string
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}): LoginEmailSender {
  if (!options.apiKey.trim() || !options.from.trim() || /[\r\n]/.test(options.from)) {
    throw new Error("A Resend API key and verified sender address are required")
  }
  const send = options.fetch ?? fetch
  return {
    async send({ email, code, expiresInMinutes }) {
      // No client-controlled HTML, redirects or arbitrary email bodies.
      if (!/^\d{6}$/.test(code)) throw new Error("Invalid login code")
      const response = await send("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          from: options.from,
          to: [email],
          subject: `${code} 是你的 StillOn 登录验证码`,
          text: `你的 StillOn 登录验证码是：${code}\n\n请回到刚才的登录页面输入。验证码 ${expiresInMinutes} 分钟内有效，只能使用一次。\n\n如果不是你发起的登录，请忽略这封邮件。`,
          html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:32px auto;color:#172033"><h2>登录 StillOn</h2><p>请回到刚才的登录页面输入验证码：</p><p style="font-size:32px;font-weight:600;letter-spacing:8px">${code}</p><p>${expiresInMinutes} 分钟内有效，只能使用一次。</p><p style="color:#64748b">如果不是你发起的登录，请忽略这封邮件。</p></div>`,
        }),
      })
      // Provider error payloads may contain recipient details: never expose/log them.
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error("Verification email could not be submitted")
      }
      const result: unknown = await response.json()
      if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string" || !result.id) {
        throw new Error("Mail provider did not acknowledge the message")
      }
    },
  }
}
