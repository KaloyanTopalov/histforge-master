# Phase Boundaries

After the last task in a phase, **do not start the next phase in the same response**. Run the cross-task scan, emit the pause block, then end your turn.

## Cross-Task Scan

Review code written across all tasks in the phase. Look for:

- Duplication across tasks that could be extracted
- Patterns that emerged and should be consolidated
- Inconsistencies in naming or structure

### Mock Audit

Re-run the import-path test across the phase's test files; remove any internal mocks and replace with package-level mocks, running tests after each fix. Report briefly: `Mock audit: {N} internal mocks found and fixed in {files}` (omit if none).

If improvements are found, apply them and commit separately:

```bash
git add {specific files}
git commit -m "$(cat <<'EOF'
refactor({scope}): cross-task cleanup phase {N}
EOF
)"
```

## Pause

This is a hard stop. After the cross-task scan, mock audit, and any cleanup commit, emit:

```
Phase {N} complete.

Summary:
- {brief: what this phase delivered, in 1–3 bullets}
- {tests added / files touched, at a glance}

{Anything the user should know before deciding — surprises, deviations from the plan, judgment calls you made, questions that came up.}

Ready for Phase {N+1}? (Or stop here, revise the plan, etc.)
```

Then **end your turn**. Do not call further tools. Do not start the next phase in the same response, even if the next phase looks small or obvious.

The user will explicitly tell you to proceed. "Continue," "go," a new `/implement-plan-tdd` invocation, or equivalent all count. Silence or an unrelated message does not.
