"""Read-only document snapshot check. This does not validate product behavior."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys


def verify(root: Path) -> int:
    try:
        root = root.resolve(strict=True)
        lock = json.loads((root / "baseline.lock.json").read_text(encoding="utf-8"))
        project = json.loads((root / "project.json").read_text(encoding="utf-8"))
        if lock["schema"] != "personal-meeting-assistant-baseline-lock@1":
            raise ValueError("Unknown baseline lock schema")
        if lock["version"] != project["documentation_baseline"]["version"]:
            raise ValueError("Baseline version differs from project.json")
        entries = lock["files"]
        if not isinstance(entries, dict) or not entries:
            raise ValueError("Missing document inventory")
        required = {"project.json", "docs/PRODUCT_BASELINE.md", "docs/DECISION_LOG.md"}
        if not required.issubset(entries):
            raise ValueError("Required baseline documents missing from inventory")
        errors = []
        for name, expected in sorted(entries.items()):
            relative = PurePosixPath(name)
            if (relative.is_absolute() or ".." in relative.parts or "\\" in name
                    or ":" in name or name == "baseline.lock.json"):
                raise ValueError(f"Invalid snapshot path: {name}")
            path = (root / name).resolve()
            if not path.is_relative_to(root):
                raise ValueError(f"Snapshot path escapes root: {name}")
            if not isinstance(expected, str) or len(expected) != 64:
                raise ValueError(f"Invalid SHA-256: {name}")
            if not path.is_file():
                errors.append(f"MISSING {name}")
            elif hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                errors.append(f"CHANGED {name}")
        if errors:
            print("Baseline verification FAILED:", file=sys.stderr)
            print("\n".join(errors), file=sys.stderr)
            return 1
        print(f"PASS: baseline {lock['version']}, {len(entries)} files match SHA-256.")
        print("Document integrity only; no runtime, host integration or Human UAT claim.")
        return 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"Baseline verification FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    arguments = parser.parse_args()
    sys.exit(verify(arguments.root))
