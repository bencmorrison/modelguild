---
name: extract-rationale
description: Move rationale, probe transcripts and correction history out of AGENTS.md, CONTRACT.md or a docs page into the module header or the issue, under CONTRIBUTING.md's "Where rationale goes", with the conservation check that makes the move reviewable by token multiset instead of by re-reading prose. Use when check-agents-size.sh fails, a doc item has grown past what every session needs, or a review asks for a bullet to be cut.
---

# Extracting rationale

The rule is [CONTRIBUTING.md § Where rationale goes](../../../CONTRIBUTING.md#where-rationale-goes); this is the working method used on issues #127, #136 and #222.

1. **Sort every sentence** of the item into normative (stays), guard (stays as one imperative sentence that cites a lint or an issue), or category 3: provenance, probe transcripts, correction history, rejected alternatives (moves).
2. **Find the destination before writing.** Most category-3 sentences are already in the module's header comment in the module's own words; `grep -F` for the distinctive tokens (issue numbers, dates, identifiers, code points). Present ⇒ drop the sentence and cite the header lines in the PR. Absent ⇒ append the sentence **verbatim** to the header, or to the issue if it is cross-cutting.
3. **Split, do not reword.** Remove whole spans; the one sanctioned edit is resolving a pronoun the split orphaned, plus sentence-case and a terminator at a seam. Declare each one.
4. **Check conservation** with `scripts/conserve.py`: the word-token multiset of the original must equal retained plus moved, and the punctuation multiset must match. Every gained or lost token is either a declared seam or a defect.
5. **Run the lints** that read the file (`check-claude-md.sh`, `check-docs.sh`, `check-contract-counts.sh`, `check-agents-size.sh`) and `npx tsc --noEmit` if a header changed.
6. **Contested ⇒ it stays.** If the maintainer has ever defended a sentence, leave it and say so.

```bash
python3 .claude/skills/extract-rationale/scripts/conserve.py ORIGINAL.txt RETAINED.txt MOVED1.txt [MOVED2.txt …]
```

The script prints the tokens gained and lost. A clean move prints `none` twice, or exactly the seams you declared.
