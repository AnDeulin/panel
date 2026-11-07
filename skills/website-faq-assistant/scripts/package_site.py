"""Package a static FAQ widget; optionally patch one explicitly supplied page."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
from pathlib import Path

START = "<!-- bounded-faq:start -->"
END = "<!-- bounded-faq:end -->"
ASSETS = ("faq-core.js", "faq-widget.js", "faq-widget.css")


def component_default() -> Path:
    base = Path(__file__).resolve().parents[1]
    plain = base / "component"
    return plain if plain.is_dir() else base / "assets" / "component"


def public_knowledge(raw: dict) -> dict:
    result = dict(raw)
    result["cards"] = [dict(card) for card in raw.get("cards", []) if card.get("approved") is True]
    if not result["cards"]:
        raise ValueError("No approved FAQ cards")
    for card in result["cards"]:
        card.pop("source", None)
    ids = [card.get("id") for card in result["cards"]]
    if not all(isinstance(i, str) and re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", i) for i in ids):
        raise ValueError("Invalid FAQ identifiers")
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate FAQ identifiers")
    return result


def snippet(prefix: str, endpoint: str = "") -> str:
    if not re.fullmatch(r"(?:\./|/)?[a-zA-Z0-9_./-]+", prefix) or ".." in prefix:
        raise ValueError("Asset prefix must be a safe local URL path")
    if endpoint and (not endpoint.startswith("/") or endpoint.startswith("//") or any(c in endpoint for c in '\"<>\r\n')):
        raise ValueError("Endpoint must be an explicitly configured same-origin absolute path")
    p = html.escape(prefix.rstrip("/"), quote=True)
    mode = "remote" if endpoint else "local"
    return "\n".join([
        START,
        f'<link rel="stylesheet" href="{p}/faq-widget.css">',
        f'<script src="{p}/faq-core.js" defer></script>',
        f'<script src="{p}/faq-widget.js" data-knowledge="{p}/knowledge.json" '
        f'data-mode="{mode}" data-endpoint="{html.escape(endpoint, quote=True)}" defer></script>',
        END,
    ])


def inject_page(page: str, fragment: str) -> str:
    starts, ends = page.count(START), page.count(END)
    if starts or ends:
        if starts != 1 or ends != 1 or page.index(START) > page.index(END):
            raise ValueError("Ambiguous existing widget block; inspect the page before updating")
        return re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _: fragment, page, count=1, flags=re.S)
    matches = list(re.finditer(r"</body\s*>", page, re.I))
    if len(matches) != 1:
        raise ValueError("Expected exactly one closing body tag")
    pos = matches[0].start()
    return page[:pos] + fragment + "\n" + page[pos:]


def make_package(knowledge_path: Path, output: Path, component: Path,
                 page_path: Path | None = None, prefix: str = "./faq", endpoint: str = "") -> dict:
    knowledge = public_knowledge(json.loads(knowledge_path.read_text(encoding="utf-8-sig")))
    fragment = snippet(prefix, endpoint)
    payload: dict[str, bytes] = {}
    for name in ASSETS:
        payload["faq/" + name] = (component / name).read_bytes()
    payload["faq/knowledge.json"] = (json.dumps(knowledge, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    payload["integration-snippet.txt"] = (fragment + "\n").encode("utf-8")
    if page_path:
        payload["index.html"] = inject_page(page_path.read_text(encoding="utf-8-sig"), fragment).encode("utf-8")
    output = output.resolve()
    if page_path and output == page_path.resolve().parent:
        raise ValueError("Output must differ from the original page directory")
    old_manifest_path = output / "package-manifest.json"
    old = json.loads(old_manifest_path.read_text(encoding="utf-8")) if old_manifest_path.exists() else None
    for rel, data in payload.items():
        target = output / rel
        if target.exists() and target.read_bytes() != data:
            expected = old and old.get("files", {}).get(rel)
            if expected != hashlib.sha256(target.read_bytes()).hexdigest():
                raise ValueError(f"Refusing to overwrite an unmanaged or edited file: {rel}")
    for rel, data in payload.items():
        target = output / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    manifest = {
        "format": 1, "mode": "remote" if endpoint else "local", "knowledgeVersion": knowledge.get("version"),
        "approvedCards": len(knowledge["cards"]),
        "files": {rel: hashlib.sha256(data).hexdigest() for rel, data in payload.items()},
        "siteChanged": False,
        "note": "Local package only. Verify current site, backup and access before upload. No secrets included.",
    }
    old_manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--knowledge", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--component", type=Path, default=component_default())
    parser.add_argument("--page", type=Path)
    parser.add_argument("--asset-prefix", default="./faq")
    parser.add_argument("--endpoint", default="")
    args = parser.parse_args()
    result = make_package(args.knowledge, args.output, args.component, args.page, args.asset_prefix, args.endpoint)
    print(json.dumps({"cards": result["approvedCards"], "mode": result["mode"], "files": len(result["files"]), "siteChanged": False}))


if __name__ == "__main__":
    main()
