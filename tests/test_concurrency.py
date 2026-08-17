"""同じ枠へ同時に押したとき、成立するのは 1 件だけであることを確かめる。"""

import threading

import pytest

from app import db

THREADS = 10


@pytest.mark.parametrize("attempt", range(3))
def test_only_one_reservation_wins(tmp_path, attempt):
    path = tmp_path / f"race-{attempt}.db"
    setup = db.connect(path)
    db.init_schema(setup)
    member_ids = [db.add_member(setup, f"参加者{i}") for i in range(THREADS)]
    setup.close()

    barrier = threading.Barrier(THREADS)
    results: list[str] = []
    lock = threading.Lock()

    def attempt_reserve(member_id: int):
        conn = db.connect(path)
        try:
            barrier.wait()
            outcome = db.reserve(conn, "2026-08-20", "night", "shower", "19:00", member_id)
        finally:
            conn.close()
        with lock:
            results.append(outcome)

    threads = [threading.Thread(target=attempt_reserve, args=(m,)) for m in member_ids]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert len(results) == THREADS
    assert results.count("ok") == 1
    assert results.count("slot_taken") == THREADS - 1

    check = db.connect(path)
    assert len(db.reservations_for_date(check, "2026-08-20")) == 1
    check.close()
