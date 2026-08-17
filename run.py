"""起動口。systemd からはこれを呼ぶ。"""

from app import config
from app.web import create_app

app = create_app()

if __name__ == "__main__":
    settings = config.load_settings()
    app.run(host=settings.host, port=settings.port, threaded=True)
