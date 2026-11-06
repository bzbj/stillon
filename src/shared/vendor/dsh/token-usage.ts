// Copyright (c) DeepSeek. MIT license; see LICENSE.
// DSH 0.2.2-rc.1. Mechanical TypeScript annotations/import adaptation only.
import { z } from "zod";
import { lastAssistantStreamChunk } from "./stream-readers";
import type { DshEvent } from "./types";
const zeroBuckets = () => ({
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
});
const bucketsFrom = (usage: any) => ({
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
});
const bucketsEqual = (left: TokenBuckets, right: TokenBuckets) => left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens;
const addReplacing = (totals: TokenBuckets, previous: TokenBuckets | undefined, next: TokenBuckets) => ({
    uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
    outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
});
const projectionSchema = z.object({
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
}).strict();
/**
 * The token-usage unit's state schema — the one definition of the state
 * shape; the state type is inferred from it.
 */
const tokenUsageStateSchema = z.object({
    totals: projectionSchema,
    last: z.object({
        turn: z.number().int().nonnegative(),
        step: z.number().int().nonnegative(),
        buckets: projectionSchema,
    }).nullable(),
}).strict();
/** The usage one durable Assistant settlement reports for its attempt, if any. */
function usageOf(event: DshEvent) {
    if (event.type === 'assistant/message' && event.data.usage !== undefined)
        return event.data.usage;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt')
        return undefined;
    return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage;
}
/**
 * Token-meter's session projection unit.
 *
 * Each v2 Assistant settlement contributes the last usage sample embedded in
 * its stream. `llm/retry-started` closes the replacement slot so the retried
 * attempt adds to the total.
 */
export const tokenUsageProjectionDefinition = {
    key: 'tokenUsage',
    stateVersion: 2,
    stateSchema: tokenUsageStateSchema,
    init: (): TokenUsageState => ({ totals: zeroBuckets(), last: null }),
    apply: (state: TokenUsageState, event: DshEvent) => {
        if (event.type === 'llm/retry-started') {
            return state.last?.turn === event.data.turn && state.last!.step === event.data.step
                ? { ...state, last: null }
                : state;
        }
        if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') {
            return state;
        }
        const sample = usageOf(event);
        if (sample === undefined)
            return state;
        const { turn, step } = event.data;
        const usage = sample;
        const buckets = bucketsFrom(usage);
        const previous = state.last !== null
            && state.last.turn === turn
            && state.last!.step === step
            ? state.last.buckets
            : undefined;
        if (previous !== undefined && bucketsEqual(previous, buckets))
            return state;
        return {
            totals: addReplacing(state.totals, previous, buckets),
            last: { turn, step, buckets },
        };
    },
    wire: { viewSchema: projectionSchema, view: (state: TokenUsageState) => state.totals },
};

export type TokenBuckets = z.infer<typeof projectionSchema>;
export type TokenUsageState = z.infer<typeof tokenUsageStateSchema>;
