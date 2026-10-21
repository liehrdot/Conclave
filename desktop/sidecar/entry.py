"""Entry point of the packaged backend (``conclave-backend[.exe]``): the same launcher as ``mtg-gui``.

``conclave-backend --data <folder> --port 0 --token auto`` serves the GUI and prints ``MTGDECK_URL=…``."""

import multiprocessing
import sys

from mtgdeck.launch import main

if __name__ == "__main__":
    multiprocessing.freeze_support()  # a frozen exe that spawns helpers must not re-run the app
    main(sys.argv[1:])
