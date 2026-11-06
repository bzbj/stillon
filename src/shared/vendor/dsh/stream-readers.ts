// Copyright (c) DeepSeek. MIT license; see LICENSE.
// DSH 0.2.2-rc.1. Mechanical TypeScript annotations/import adaptation only.
export function isTokenDelta(chunk: any) {
    switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta':
            return chunk.text !== '';
        case 'tool-call-delta':
            return chunk.argumentsDelta !== '' || chunk.name !== undefined;
        default:
            return false;
    }
}

function firstRunMemberTime(run: any, predicate: (text: string) => boolean) {
    const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts;
    let time = run.time0;
    for (let index = 0; index < fragments.length; index += 1) {
        if (index > 0)
            time += run.dt[index - 1];
        if (predicate(fragments[index]))
            return time;
    }
    return undefined;
}

export function runFirstTokenTime(run: any) {
    if (run.type === 'tool-call-chunks' && run.name !== undefined)
        return run.time0;
    return firstRunMemberTime(run, fragment => fragment !== '');
}

export function assistantStreamFirstTokenTime(stream: any[]) {
    for (const record of stream) {
        const time = record.type === 'chunk'
            ? (isTokenDelta(record.chunk) ? record.time : undefined)
            : runFirstTokenTime(record);
        if (time !== undefined)
            return time;
    }
    return undefined;
}

export function lastAssistantStreamChunk(stream: any[], type: string) {
    for (let index = stream.length - 1; index >= 0; index -= 1) {
        const record = stream[index];
        if (record.type === 'chunk' && record.chunk.type === type)
            return record.chunk;
    }
    return undefined;
}
