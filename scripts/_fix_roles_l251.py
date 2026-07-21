"""Fix TS1002 syntax error at roles.ts L251.

Root cause: the schema string contains literal `<true ...>` tokens.
TypeScript's lexer (in .ts files) interprets the first `<` as a JSX tag
start, then never recovers when it sees the second `<` on the next
schema line. Result: TS1002 Unterminated string literal at L251 + cascade
TS1005 at L252.

Fix: replace the four `<...>` schema tokens with a non-JSX-friendly form.
We use 「...」 brackets (semantically equivalent, no `<` characters, no
loss of meaning). The replacement is purely textual inside the JSON
schema that the Planner LLM sees — it does not affect parsing.

This script writes the file back as UTF-8 WITHOUT BOM (CLAUDE.md §3).
"""
from pathlib import Path

ROLES = Path(r"D:\BaiduYunDrive\OneDrive\github仓库\vscode-moa\src\moaCore\roles.ts")
text = ROLES.read_text(encoding="utf-8")

# Four schema lines containing <...> tokens (L251, L254, L255, L256 per
# the tsc error and the read_file excerpt). The replacements preserve
# the exact same words inside the angle brackets, just swap to 「」.
REPLACEMENTS = [
    (
        '"needs_iteration": <true 表示需要 MoA 多轮; false 表示单次完成>,',
        '"needs_iteration": 「true 表示需要 MoA 多轮; false 表示单次完成」,',
    ),
    (
        '"plan_coverage": <0-1, 默认 0.9 收敛,本次规划完整度的自评>,',
        '"plan_coverage": 「0-1, 默认 0.9 收敛,本次规划完整度的自评」,',
    ),
    (
        '"needs_replan": <true 表示需要再迭代; false 表示已收敛。**默认 true**>,',
        '"needs_replan": 「true 表示需要再迭代; false 表示已收敛。**默认 true**」,',
    ),
    (
        '"ask_user": <true 表示需要用户澄清; false 表示不需要。**默认 false**>,',
        '"ask_user": 「true 表示需要用户澄清; false 表示不需要。**默认 false**」,',
    ),
]

total = 0
for old, new in REPLACEMENTS:
    if old not in text:
        print(f"NOT FOUND: {old[:60]}...")
        continue
    text = text.replace(old, new)
    total += 1
    print(f"OK: replaced {old[:60]}...")

# Verify no <...> schema tokens remain (excluding legitimate XML/HTML in
# comments — we only care about the four schema lines).
import re
remaining = re.findall(r'"[a-z_]+": <[^>]+>,', text)
print(f"\nRemaining <...> schema tokens: {len(remaining)}")
for r in remaining:
    print(f"  {r}")

ROLES.write_bytes(text.encode("utf-8"))  # no BOM
print(f"\nWrote {ROLES} ({total} replacements applied).")
