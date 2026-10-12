# Changelog

## [0.1.0] - 2026-10-12

### Added

- Write gate: `retain`, `learn`, and `memory_edit` calls are blocked when any string in their input reads like an instruction, including `retain`'s `items[].context` and `learn`'s managed-skill body; the reason does not name the matched pattern; `forget` and `invalidate` pass.
- Handoff documents: a `handoff-*.md` file is written only to `$TMPDIR` and outside the workspace, with private keys, provider tokens, JWTs, bearer tokens, password- and key-named values, email addresses, phone numbers, and instruction-like lines removed from the input omp approves and runs; `edit` on a handoff file is blocked.
- Exit gate: instruction-like lines inside `<memories>`, `<mental_models>`, `Memory summary:`, `Learned lessons`, and configured blocks of the system prompt are replaced; a closing tag stored inside a memory does not end the block early.
- Query-result gate: results of `recall`, `reflect`, and `read` of handoff files and `memory://` paths are scrubbed, stripped of marker-shaped tags, and wrapped in tags with a fresh 16-hex nonce; a replaced recall line keeps its id; a result that cannot be checked is withheld.
- Startup check: a warning when `mnemopi.autoRecall` or `mnemopi.autoRetain` is on, `mnemopi.scoping` is not `per-project`, the `local` backend is in use, or the guard is not loaded last.
- `createMemoryGuard({ extraBlockHeaders, extraPatterns, entry })` for other extensions' memory blocks and extra patterns.
- `examples/memory-guard.yml`, a settings overlay that turns automatic recall and retention off and keeps memory per project.
- Tests through omp's own loader, runner, and settings, and opt-in live tests that run real omp with a scripted test-only model provider, without network.
