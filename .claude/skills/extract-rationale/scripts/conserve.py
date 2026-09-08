"""Conservation check for a rationale move (CONTRIBUTING.md § Where rationale goes).

    conserve.py ORIGINAL RETAINED MOVED [MOVED ...]

Compares the word-token multiset (and, separately, the punctuation multiset) of ORIGINAL
against RETAINED plus every MOVED file. A clean move prints `none` for both gained and
lost; anything else is either a seam you declared (sentence-case, a terminator, a resolved
pronoun) or a reword that should not be in this commit.
"""
import collections
import re
import sys
from pathlib import Path

if len(sys.argv) < 4:
    sys.exit(__doc__)

WORD = re.compile(r"\w+", re.U)


def words(text: str) -> collections.Counter:
    return collections.Counter(WORD.findall(text))


def punctuation(text: str) -> collections.Counter:
    return collections.Counter(
        ch for ch in text if not ch.isalnum() and not ch.isspace() and ch != "_"
    )


original = Path(sys.argv[1]).read_text()
after = "".join(Path(p).read_text() for p in sys.argv[2:])

for name, fn in (("word tokens", words), ("punctuation", punctuation)):
    gained = fn(after) - fn(original)
    lost = fn(original) - fn(after)
    print(f"{name} gained: {dict(gained) or 'none'}")
    print(f"{name} lost:   {dict(lost) or 'none'}")
