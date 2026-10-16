export const CONNECT_OTP_SECONDS = 10 * 60
export const CONNECT_RESEND_SECONDS = 60
export const CONNECT_SESSION_SECONDS = 30 * 24 * 60 * 60

export interface ConnectSession {
  user: { id: string; email: string }
  expiresAt: string
}

export interface ConnectError {
  error: string
  retryAfterSeconds?: number
}
