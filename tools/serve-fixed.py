"""時刻を固定した Flask を立てる。差分比較のためだけに使う。"""

import sys
from datetime import datetime

from app import clock, web

now = datetime.fromisoformat(sys.argv[1])
clock.now = lambda: now
web.create_app(db_path=sys.argv[2]).run(host="127.0.0.1", port=int(sys.argv[3]), threaded=True)
