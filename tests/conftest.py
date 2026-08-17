from datetime import datetime

import pytest

from app import clock, config, db, web

TZ = config.TZ


def at(month, day, hour, minute=0):
    return datetime(2026, month, day, hour, minute, tzinfo=TZ)


@pytest.fixture
def conn(tmp_path):
    connection = db.connect(tmp_path / "test.db")
    db.init_schema(connection)
    yield connection
    connection.close()


@pytest.fixture
def alice(conn):
    return db.add_member(conn, "あかり")


@pytest.fixture
def bob(conn):
    return db.add_member(conn, "ゆうと")


@pytest.fixture
def make_app(tmp_path, monkeypatch):
    """現在時刻を固定したアプリを作る。"""

    def factory(now):
        monkeypatch.setattr(clock, "now", lambda: now)
        app = web.create_app(
            config_path=tmp_path / "absent.toml", db_path=tmp_path / "web.db"
        )
        app.config["TESTING"] = True
        return app

    return factory


@pytest.fixture
def signed_in(make_app):
    """名簿に 2 人入れ、1 人目として入った client を返す。"""

    def factory(now):
        app = make_app(now)
        with app.app_context():
            connection = db.connect(app.config["DB_PATH"])
            first = db.add_member(connection, "あかり")
            db.add_member(connection, "ゆうと")
            connection.close()
        client = app.test_client()
        client.set_cookie("member_id", str(first))
        return app, client

    return factory
