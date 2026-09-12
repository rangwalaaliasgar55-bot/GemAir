"""SQLite/FTS5 memory backend — zero-dependency default."""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from openjarvis.core.events import EventType, get_event_bus
from openjarvis.core.registry import MemoryRegistry
from openjarvis.tools.storage._stubs import MemoryBackend, RetrievalResult


def _check_fts5(conn: sqlite3.Connection) -> bool:
    """Return True if the SQLite build includes FTS5."""
    try:
        opts = conn.execute("PRAGMA compile_options").fetchall()
        return any("FTS5" in option[0].upper() for option in opts)
    except sqlite3.Error:
        return False


@MemoryRegistry.register("sqlite")
class SQLiteMemory(MemoryBackend):
    """Full-text memory with optional Rust acceleration.

    The pinned OpenJarvis revision normally requires ``openjarvis_rust`` for
    this backend. GemAir keeps installation useful on machines without a Rust
    toolchain by retaining equivalent stdlib SQLite/FTS5 operations. The
    generated capability policy is enforced independently in either mode.
    """

    backend_id: str = "sqlite"

    def __init__(self, db_path: str | Path = "") -> None:
        if not db_path:
            from openjarvis.core.config import DEFAULT_CONFIG_DIR

            db_path = str(DEFAULT_CONFIG_DIR / "memory.db")
        self._db_path = str(db_path)
        self._rust_impl: Any = None
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = threading.RLock()
        try:
            from openjarvis._rust_bridge import get_rust_module

            self._rust_impl = get_rust_module().SQLiteMemory(self._db_path)
        except ImportError:
            if self._db_path != ":memory:":
                Path(self._db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
            self._fts5 = _check_fts5(self._conn)
            self._create_tables()

    def _create_tables(self) -> None:
        assert self._conn is not None
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT '',
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL
            )
        """)
        if self._fts5:
            self._conn.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts
                USING fts5(content, source, tokenize='porter unicode61')
            """)
        self._conn.commit()

    @staticmethod
    def _publish(event_type: EventType, payload: Dict[str, Any]) -> None:
        get_event_bus().publish(event_type, payload)

    def store(
        self,
        content: str,
        *,
        source: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Persist *content* and return a unique document id."""
        meta_json = json.dumps(metadata or {}, ensure_ascii=False)
        if self._rust_impl is not None:
            doc_id = self._rust_impl.store(content, source, meta_json)
        else:
            assert self._conn is not None
            doc_id = str(uuid.uuid4())
            with self._lock, self._conn:
                cursor = self._conn.execute(
                    "INSERT INTO documents(id, content, source, metadata, created_at) VALUES(?,?,?,?,?)",
                    (doc_id, content, source, meta_json, time.time()),
                )
                if self._fts5:
                    self._conn.execute(
                        "INSERT INTO documents_fts(rowid, content, source) VALUES(?,?,?)",
                        (cursor.lastrowid, content, source),
                    )
        self._publish(EventType.MEMORY_STORE, {"backend": self.backend_id, "doc_id": doc_id, "source": source})
        return str(doc_id)

    def replace_source(
        self,
        source: str,
        documents: List[tuple[str, Optional[Dict[str, Any]]]],
    ) -> List[str]:
        """Atomically replace all documents associated with *source*."""
        if self._rust_impl is not None:
            payload = [(content, json.dumps(metadata or {})) for content, metadata in documents]
            doc_ids = list(self._rust_impl.replace_source(source, payload))
        else:
            assert self._conn is not None
            doc_ids = []
            with self._lock, self._conn:
                rows = self._conn.execute("SELECT rowid FROM documents WHERE source=?", (source,)).fetchall()
                if self._fts5:
                    self._conn.executemany("DELETE FROM documents_fts WHERE rowid=?", [(row[0],) for row in rows])
                self._conn.execute("DELETE FROM documents WHERE source=?", (source,))
                for content, metadata in documents:
                    doc_id = str(uuid.uuid4())
                    cursor = self._conn.execute(
                        "INSERT INTO documents(id, content, source, metadata, created_at) VALUES(?,?,?,?,?)",
                        (doc_id, content, source, json.dumps(metadata or {}, ensure_ascii=False), time.time()),
                    )
                    if self._fts5:
                        self._conn.execute(
                            "INSERT INTO documents_fts(rowid, content, source) VALUES(?,?,?)",
                            (cursor.lastrowid, content, source),
                        )
                    doc_ids.append(doc_id)
        for doc_id in doc_ids:
            self._publish(EventType.MEMORY_STORE, {"backend": self.backend_id, "doc_id": doc_id, "source": source})
        return doc_ids

    def retrieve(self, query: str, *, top_k: int = 5, **kwargs: Any) -> List[RetrievalResult]:
        """Search memory using the accelerated backend or bounded local SQL."""
        if not query.strip():
            return []
        if self._rust_impl is not None:
            from openjarvis._rust_bridge import retrieval_results_from_json

            results = retrieval_results_from_json(self._rust_impl.retrieve(query, top_k))
        else:
            assert self._conn is not None
            limit = max(1, min(100, int(top_k)))
            with self._lock:
                tokens = re.findall(r"[\w-]+", query, flags=re.UNICODE)[:24]
                if self._fts5 and tokens:
                    expression = " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens)
                    rows = self._conn.execute(
                        """SELECT d.content, d.source, d.metadata, bm25(documents_fts) AS rank
                           FROM documents_fts JOIN documents d ON d.rowid=documents_fts.rowid
                           WHERE documents_fts MATCH ? ORDER BY rank LIMIT ?""",
                        (expression, limit),
                    ).fetchall()
                    results = [
                        RetrievalResult(
                            content=row["content"],
                            score=1.0 / (1.0 + abs(float(row["rank"] or 0.0))),
                            source=row["source"],
                            metadata=json.loads(row["metadata"] or "{}"),
                        )
                        for row in rows
                    ]
                else:
                    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                    rows = self._conn.execute(
                        """SELECT content, source, metadata FROM documents
                           WHERE content LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\'
                           ORDER BY created_at DESC LIMIT ?""",
                        (f"%{escaped}%", f"%{escaped}%", limit),
                    ).fetchall()
                    results = [
                        RetrievalResult(
                            content=row["content"], score=0.5, source=row["source"],
                            metadata=json.loads(row["metadata"] or "{}"),
                        )
                        for row in rows
                    ]
        self._publish(EventType.MEMORY_RETRIEVE, {"backend": self.backend_id, "query": query, "num_results": len(results)})
        return results

    def delete(self, doc_id: str) -> bool:
        if self._rust_impl is not None:
            return bool(self._rust_impl.delete(doc_id))
        assert self._conn is not None
        with self._lock, self._conn:
            row = self._conn.execute("SELECT rowid FROM documents WHERE id=?", (doc_id,)).fetchone()
            if row is None:
                return False
            if self._fts5:
                self._conn.execute("DELETE FROM documents_fts WHERE rowid=?", (row[0],))
            self._conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
            return True

    def clear(self) -> None:
        if self._rust_impl is not None:
            self._rust_impl.clear()
            return
        assert self._conn is not None
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM documents")
            if self._fts5:
                self._conn.execute("DELETE FROM documents_fts")

    def count(self) -> int:
        if self._rust_impl is not None:
            return int(self._rust_impl.count())
        assert self._conn is not None
        with self._lock:
            return int(self._conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0])

    def close(self) -> None:
        if self._conn is not None:
            with self._lock:
                self._conn.close()
                self._conn = None


__all__ = ["SQLiteMemory"]
