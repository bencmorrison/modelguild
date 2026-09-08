---
name: guild-delegate
description: Delegate an authorized coding task through ModelGuild and review its captured changes.
---
Read [shared ModelGuild guidance](../modelguild-common.md), then use this workflow.

Call guild_delegate with task describing the authorized outcome, constraints, relevant
files, and useful validation. Honor the user's model and worktree choices. Let the
worker choose its implementation within the task; do not add a second list of tool
restrictions in the prompt.

Read the returned report and recorded patch, inspect the actual changed files, and run
appropriate validation. Check captureComplete and capture/scaffolding warnings before
claiming the patch covers everything. Keep your follow-up edits distinguishable from
the worker's. If capture is incomplete or the call fails, inspect the tree before any
retry: real changes can exist despite a missing report. Report the actual edited root
and material limitations. Follow the user's commit/publication instructions.
