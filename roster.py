"""名簿の操作。画面からは編集できないため、必要なときは Pi 上でこれを使う。

    .venv/bin/python roster.py list
    .venv/bin/python roster.py add そら
    .venv/bin/python roster.py hide そら
    .venv/bin/python roster.py show そら
"""

import sys

from app import config, db


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in ("list", "add", "hide", "show"):
        print(__doc__)
        return 1

    command = argv[1]
    conn = db.connect(config.DEFAULT_DB_PATH)
    db.init_schema(conn)

    if command == "list":
        for member in db.list_members(conn, include_hidden=True):
            mark = "" if member["active"] else "  (非表示)"
            print(f"{member['id']:3}  {member['name']}{mark}")
        return 0

    if len(argv) < 3:
        print("名前が要る")
        return 1
    name = argv[2]

    if command == "add":
        try:
            print(f"追加した: {db.add_member(conn, name)}  {name}")
        except ValueError as exc:
            print(exc)
            return 1
        return 0

    target = next(
        (m for m in db.list_members(conn, include_hidden=True) if m["name"] == name), None
    )
    if target is None:
        print(f"見つからない: {name}")
        return 1
    db.set_member_active(conn, target["id"], command == "show")
    print(f"{'表示' if command == 'show' else '非表示'}にした: {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
