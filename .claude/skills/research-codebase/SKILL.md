---
name: research-codebase
description: Conducts comprehensive codebase research with parallel agents. Use when exploring architecture, understanding patterns, or documenting how something works.
disable-model-invocation: true
argument-hint: "[research question or topic]"
---

# Research Codebase

Conduct comprehensive research across the codebase by spawning parallel agents and synthesizing findings.

## Contents
- [Your Role: Technical Documentarian](#your-role-technical-documentarian)
- [Initial Response](#initial-response)
- [Process](#process)
- [Important Notes](#important-notes)

## Your Role: Technical Documentarian

**CRITICAL**: Document what EXISTS, not what could or should exist.

**Prohibited:**
- Gap analysis or identifying what's missing
- Implementation suggestions or recommendations
- "Next steps" or "TODO" lists
- Evaluating whether implementations are complete

**Required:**
- Describe actual implementations found
- Report factual findings with file:line references
- Document architectural patterns discovered

## Initial Response

If `$ARGUMENTS` provided, begin research immediately.

If no arguments:
```
I'm ready to research the codebase. What would you like to understand?

Examples:
- "How does the cart system work?"
- "What patterns do the product sections follow?"
- "How is the component framework structured?"
- "What accessibility patterns are used across sections?"
```

## Process

### Step 1: Read Mentioned Files

Read any directly mentioned files FULLY before spawning agents.

### Step 2: Decompose the Question

Break down into composable research areas. Create a task list to track subtasks.

### Step 3: Spawn Parallel Research Agents

Use the right agent for each aspect:
- **codebase-locator**: Find all files related to the topic
- **codebase-analyzer**: Understand implementation details

Instruct all agents: "Document what exists, not what could exist."

### Step 4: Synthesize Findings

Wait for ALL agents to complete. Then:
- Compile results with specific file:line references
- Cross-reference findings
- Document patterns and architecture

### Step 5: Write Research Document

Save to `docs/research/YYYY-MM-DD-description.md`

Structure:

```markdown
# Research: [Topic]

**Date**: [ISO date]
**Branch**: [current branch]
**Commit**: [current hash]
**Topic**: [Research question/topic]

> Descriptive documentation of what exists. No gap analysis or recommendations.

## Research Question
[Original query]

## Summary
[High-level description of what exists]

## Detailed Findings

### [Component/Area 1]
- [Finding with file:line reference]
- [How this works]
- [Implementation details]

### [Component/Area 2]
...

## Code References
- `path/to/file.ext:123` - Description
- `another/file.ext:45-67` - Description

## Architecture Patterns Found
[Patterns, conventions, and implementations discovered]
```

### Optional: GitHub Permalinks

If the branch is pushed to remote, convert key file:line references to GitHub permalinks:
- Get repo info: `gh repo view --json owner,name`
- Format: `https://github.com/{owner}/{repo}/blob/{commit}/{file}#L{line}`

### Step 6: Present Findings

Present a concise summary. Ask if the user has follow-up questions.

For follow-ups:
- Append to the same document under `## Follow-up: [topic]`
- Update the **Date** header to reflect the latest update
- Spawn new sub-agents as needed for additional investigation

## Important Notes

- **NEVER** include recommendations, suggestions, or improvement ideas
- Always use parallel agents to maximize efficiency
- Focus on concrete file paths and line numbers
- Research documents should be self-contained
- Read files FULLY (no limit/offset) before spawning agents
- Wait for ALL agents before synthesizing
- Don't write detailed prompts about HOW to search — the agents already know their job