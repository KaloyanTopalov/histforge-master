# Troubleshooting Templates

Formats to use when you hit one of the explicit pause points the skill defines. In both cases, stop and wait for the user — don't try to fix or guess.

## Broken Existing Tests

When existing tests break after implementing a task:

```
Existing tests broke after implementing Phase {N}, Task {M}:

FAILED: {test name}
  Expected: {what it expected}
  Got: {what happened}

This likely means: {your analysis}

Options:
1. {option}
2. {option}

How should I proceed?
```

Do not auto-fix broken existing tests. Wait for the user.

## Plan Doesn't Match Reality

When what the plan describes doesn't match what's actually in the code:

```
Issue in Phase {N}, Task {M}:
Expected: {what the plan says}
Found: {what's actually there}

How should I proceed?
```

Wait for the user. Don't guess.
