/** Begin code loading at authenticated workspace mount, before initial snapshots. */
export const loadHomeComposer = () => import("../components/chat-ui/ChatInput").then(({ ChatInput }) => ({ default: ChatInput }))
