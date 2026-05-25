# Splitting a Skill That Grew Past the Cap

If your anchor block has more than ~30 names — or has more than ~6 semantic groups, or its `## Architecture` section needs subsections that explain unrelated concerns — the area is two skills wearing one hat. Split it.

## How to split

1. **Cluster the existing anchors by developer activity.** Not by file path, not by directory, not by HTTP method. By "what a developer is *doing* when these names matter." E.g., the dashboard's anchors split naturally into pause-control, settings, and queue-pickup clusters because those are three workflows even though they touch overlapping files.
2. **Each cluster becomes a candidate sub-skill.** Name it after the activity, the same way the parent was named (`domain-X-pause`, not `domain-X-routes`).
3. **Move the relevant prose with the anchors.** The "why" sections, pitfalls, and workflow descriptions follow their cluster. If a piece of prose explains *how two clusters interact*, that's a cross-skill reference — name the sibling explicitly in both skills, like `domain-pipeline` does with `domain-workflows`.
4. **Re-apply the grep test in each new skill.** Names whose only callers were the *other* cluster's code now fail the contract test in this skill — drop them. The cap-violation usually came partly from anchors that were really only relevant to the cluster you're now spinning out.
5. **Update CLAUDE.md's project-skills catalogue** by running `/claude-md` after the split, so the registry and any troubleshooting nudges name the new skills.

A good split shrinks the *total* anchor count: names that were duplicated across both concerns disappear from one side, and names that didn't really belong to either get dropped during the re-grep. If the split *grew* the total anchor count, you split along the wrong axis — try clustering by activity again.

Don't split prophylactically. ~25 anchors is a soft cap, not a hard one. A genuinely-coherent area with 28 grep-worthy names is fine. The cap exists to push back against the "let's index every public symbol" failure mode, not to legislate a fixed shape.
