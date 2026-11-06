# DeepSeek Harness statistics

These pure folds and stream readers come from DeepSeek Harness **0.2.2-rc.1**.
`provenance.json` records original package paths and SHA-256 hashes. `LICENSE`
retains the upstream MIT notice.

The adaptations are TypeScript annotations, local imports and exported inferred
types. Function bodies retain upstream step counting, attempt replacement, retry
billing, first qualifying text/reasoning/tool delta, packed stream decoding,
overlapping tool timing, zero-duration and short-window behavior. Do not add
smoothing or transport-specific heuristics here.

`fixtures/upstream.json` contains synthetic events and the original modules'
state after **each** event. Regenerate with:

```sh
bun scripts/generate-dsh-statistics-fixtures.ts /path/to/node_modules/@deepseek-ai
```

The generator verifies the source hashes before importing upstream. Parity tests
run without an upstream installation. Provider protocol adaptation lives outside
this directory. Native DSH sessions use their own original projection plugins.
