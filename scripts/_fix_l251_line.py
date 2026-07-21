"""Rewrite L251 in roles.ts to a clean two-line block.

The previous attempt wrote a literal backslash-n (because of escaped
characters in the prompt string). This script:
  1. Locates the L251 schema field line by scanning.
  2. Removes any trailing junk (literal `\n` chars + dangling `    '',`).
  3. Re-inserts ONE clean L251 followed by the empty `    '',` line.
"""
from pathlib import Path

ROLES = Path(r"D:\BaiduYunDrive\OneDrive\github仓库\vscode-moa\src\moaCore\roles.ts")
text = ROLES.read_text(encoding="utf-8")

# Build the clean L251 line with real LF.
clean_l251 = (
    "    '  \"needs_iteration\": \u300ctrue \u8868\u793a\u9700\u8981 MoA \u591a\u8f6e; "
    "false \u8868\u793a\u5355\u6b21\u5b8c\u6210\u300d," + chr(10)
)

# Replace: any garbage substring between 'needs_iteration" : ... \u300d and the next
# '    \'\','  (empty line) is broken. Just rebuild the L251 + L252 pair.
# Locate L251.
idx = text.find('"needs_iteration"')
if idx < 0:
    raise SystemExit("Cannot find needs_iteration in roles.ts")

# Find the next `'','` after L251 start (this is the empty line).
end_marker = "    '',"
end_idx = text.find(end_marker, idx)
if end_idx < 0:
    raise SystemExit("Cannot find '',' after needs_iteration")

# Extract the broken region (L251 up to and including the empty line end).
# Region shape: L251 (with junk) + LF + '    '','
# Replace with: clean_l251 + '    '',' + LF
broken_region_end = end_idx + len(end_marker)
broken_region = text[idx - 8 : broken_region_end]  # include leading "    '  "
# Compose replacement:
replacement = (
    "    "  # 4-space indent
    + "'  \"needs_iteration\": \u300ctrue \u8868\u793a\u9700\u8981 MoA \u591a\u8f6e; "
    + "false \u8868\u793a\u5355\u6b21\u5b8c\u6210\u300d,"
    + chr(10)
    + "    '',"
    + chr(10)
)

new_text = text[: idx - 8] + replacement + text[broken_region_end:]
ROLES.write_bytes(new_text.encode("utf-8"))
print(f"Rewrote. Was {len(text)} bytes, now {len(new_text)} bytes.")

# Verify
lines = ROLES.read_text(encoding="utf-8").splitlines()
for i, ln in enumerate(lines[247:258], start=248):
    print(f"L{i}: {ln!r}")
