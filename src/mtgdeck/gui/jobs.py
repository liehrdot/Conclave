"""Background jobs (printing, MPC Autofill, card database): their events stream to the browser, and every job
ends with a ``done`` event whatever happens."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from collections.abc import Awaitable
from typing import Any

from ..jsonstore import StoreError
from ..http import HttpError
from . import sync as gui_sync

log = logging.getLogger(__name__)

def error_text(exc: BaseException) -> str:
    """A message for the user: friendly for known failures, the exception type for real bugs."""
    if isinstance(exc, HttpError):
        return exc.friendly
    if isinstance(exc, (StoreError, LookupError, ValueError)) and not isinstance(exc, (KeyError, IndexError)):
        return str(exc)
    return f"{type(exc).__name__}: {exc}"






@dataclass
class Job:
    id: str
    started: float = field(default_factory=time.time)
    events: list[dict[str, Any]] = field(default_factory=list)
    done: bool = False
    task: asyncio.Task | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    proc: Any = None  # terminal.Terminal of the MPC Autofill job
    loop: asyncio.AbstractEventLoop | None = None
    ended: float | None = None

    def emit(self, **event: Any) -> None:
        self.events.append(event)
        self.changed.set()

    def emit_threadsafe(self, **event: Any) -> None:
        assert self.loop is not None
        self.loop.call_soon_threadsafe(lambda: self.emit(**event))

    def close(self) -> None:
        """End the job. One that never said ``done`` (e.g. a crash in its last step) says it now, so the browser
        never waits forever."""
        if not any(e.get("type") == "done" for e in self.events):
            self.emit(type="done", ok=False)
        self.done = True
        self.ended = time.time()
        self.changed.set()
        gui_sync.mark_dirty()  # a job may have saved something: sync soon


JOBS: dict[str, Job] = {}
JOB_KEEP_SECONDS = 3600  # finished jobs stay replayable this long (page reload, reconnect)


def register(job: Job, work: Awaitable[None]) -> dict[str, str]:
    """Run ``work`` for ``job`` in the background; whatever happens, the job ends with a ``done`` event."""
    now = time.time()
    for old in [j for j in JOBS.values() if j.done and now - (j.ended or now) > JOB_KEEP_SECONDS]:
        JOBS.pop(old.id, None)
    JOBS[job.id] = job

    async def supervised() -> None:
        try:
            await work
        except asyncio.CancelledError:
            job.emit(type="error", text="Abgebrochen.")
            raise
        except Exception as exc:
            log.exception("Job %s failed", job.id)
            job.emit(type="error", text=error_text(exc))
        finally:
            job.close()

    job.task = asyncio.create_task(supervised())
    return {"job": job.id}


def start_runner(runner: Any) -> dict[str, str]:
    """Run ``runner(job)`` as a background job whose events stream to the browser."""
    job = Job(id=uuid.uuid4().hex[:12], loop=asyncio.get_running_loop())
    return register(job, runner(job))
