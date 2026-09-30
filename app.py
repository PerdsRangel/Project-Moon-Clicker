import json
import re
import sqlite3
import time
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request

BASE = Path(__file__).parent
DB_PATH = BASE / "saves.db"
MAX_OFFLINE = 8 * 3600  # máximo de segundos de progresso offline

app = Flask(__name__)


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.execute(
            "CREATE TABLE IF NOT EXISTS saves ("
            "player TEXT PRIMARY KEY, version INTEGER, data TEXT, saved_at REAL)"
        )
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def valid_player(name):
    return re.fullmatch(r"[\w-]{1,20}", name) is not None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/content")
def content():
    # Cada arquivo em content/ é um "pacote" (lobotomy, ruina, limbus...)
    packs = {}
    for f in sorted((BASE / "content").glob("*.json")):
        packs[f.stem] = json.loads(f.read_text(encoding="utf-8"))
    return jsonify(packs)


@app.route("/api/load/<player>")
def load(player):
    if not valid_player(player):
        return jsonify(error="Nome inválido"), 400
    row = get_db().execute(
        "SELECT data, saved_at FROM saves WHERE player = ?", (player,)
    ).fetchone()
    if row is None:
        return jsonify(state=None, offline_seconds=0)
    offline = min(max(time.time() - row[1], 0), MAX_OFFLINE)
    return jsonify(state=json.loads(row[0]), offline_seconds=offline)


@app.route("/api/save/<player>", methods=["POST"])
def save(player):
    if not valid_player(player):
        return jsonify(error="Nome inválido"), 400
    state = (request.get_json(silent=True) or {}).get("state")
    if not isinstance(state, dict):
        return jsonify(error="Save inválido"), 400
    db = get_db()
    db.execute(
        "INSERT INTO saves (player, version, data, saved_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(player) DO UPDATE SET "
        "version = excluded.version, data = excluded.data, saved_at = excluded.saved_at",
        (player, state.get("version", 1), json.dumps(state), time.time()),
    )
    db.commit()
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(debug=False)