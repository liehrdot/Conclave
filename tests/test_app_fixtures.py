"""docs/app-api/ops.json: the cases the phone apps test their instant (optimistic) apply against stay in step with appops."""

import importlib.util
from pathlib import Path

from mtgdeck.sync import appops

_spec = importlib.util.spec_from_file_location("app_fixtures", Path(__file__).resolve().parent.parent / "scripts" / "app_fixtures.py")
fixtures = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fixtures)


def test_the_file_is_current():
    assert fixtures.OUT.read_text(encoding="utf-8") == fixtures.text(), "run: uv run python scripts/app_fixtures.py"


def test_every_operation_has_a_case():
    assert {t for _, _, t, _ in fixtures.CASES} >= set(appops.TYPES)
