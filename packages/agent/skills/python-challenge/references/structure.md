# Laying out a Python project (Windows)

Show the tree that fits the challenge, then the commands. Explain each file in one line.

## Level 1: one script

```
python-challenges\
  01-guess-the-number\
    README.md        <- the brief and steps (Ares writes this)
    main.py          <- YOUR code
```
Run: `py main.py` from inside the folder (`cd python-challenges\01-guess-the-number`).

Every script grows this shape:
```python
import random          # 1. imports at the top, standard library first, then pip packages, then your own files


def play():            # 2. functions: one job each, a clear name
    ...


if __name__ == "__main__":   # 3. only runs when you start THIS file, not when another file imports it
    play()
```

## Level 2: a few files that import each other

```
todo\
  main.py          <- menu and input; imports from storage
  storage.py       <- load_todos() / save_todos()
  todos.json       <- created by the program
```
In `main.py`: `from storage import load_todos, save_todos` (same folder, so the file name without `.py`).
Run from the folder that holds `main.py`, or imports of your own files fail with `ModuleNotFoundError`.

## Level 3: a virtual environment for pip packages

```
quote-fetcher\
  .venv\            <- the project's own Python + packages (never edit, never commit)
  main.py
  requirements.txt  <- one package per line, e.g. requests==2.32.3
```
Commands (PowerShell, inside the folder):
```
py -m venv .venv
.venv\Scripts\Activate.ps1        # prompt shows (.venv); if blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
py -m pip install requests
py -m pip freeze > requirements.txt
py main.py
```
Someone else installs the same packages with `py -m pip install -r requirements.txt`.

## Level 4: a package with tests

```
expenses\
  pyproject.toml        <- optional at first; name, version, dependencies
  requirements.txt
  README.md
  src\
    expenses\
      __init__.py       <- makes the folder a package (can be empty)
      tracker.py
      report.py
  tests\
    test_tracker.py     <- functions named test_..., plain assert
  main.py               <- from expenses.tracker import add_expense
```
Run tests: `py -m pip install pytest` then `py -m pytest` from the project root.
If `src` imports fail, run with `py -m pip install -e .` (needs pyproject.toml) or start from the project root with
`set PYTHONPATH=src` (cmd) / `$env:PYTHONPATH="src"` (PowerShell).

## Common import errors, explained
- `ModuleNotFoundError: No module named 'requests'` -> not installed in THIS Python: activate the venv, then pip install.
- `ModuleNotFoundError: No module named 'storage'` -> you ran from another folder; `cd` to the project first.
- `ImportError: cannot import name 'x' from 'y'` -> the name is misspelled or not defined at the top level of y.py.
- A file named `random.py` or `json.py` in your folder hides the real module: rename it.
