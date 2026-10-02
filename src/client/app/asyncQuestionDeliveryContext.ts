import { createContext } from "react"
import type { AsyncQuestionDelivery } from "./asyncQuestionDelivery"
export const AsyncQuestionDeliveryContext = createContext<{ chatId: string; delivery: AsyncQuestionDelivery } | null>(null)
