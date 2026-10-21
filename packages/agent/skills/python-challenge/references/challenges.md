# Challenge ladder

Each challenge: slug, what to build, concepts, steps (the walk-through order), edge cases to test when rating.
Level 1-2 use only the standard library. Level 3+ may need one `pip install`.

## Level 1 - first programs (one file: `main.py`)

### 01-guess-the-number
Build: the computer picks 1-100, the player guesses, the program says higher/lower, counts tries, says "Got it in N".
Concepts: `random.randint`, `input`, `int()`, `while` loop, `if/elif/else`, f-strings.
Steps: 1 pick and print the secret (debug) - 2 read one guess and compare - 3 loop until correct - 4 count tries -
5 remove the debug print, handle non-numbers with `try/except ValueError`.
Edge cases: letters typed, numbers outside 1-100, guessing right first try ("1 try" not "1 tries").

### 02-tip-calculator
Build: ask bill amount, tip percent, number of people; print each person's share to 2 decimals.
Concepts: `float()`, arithmetic, rounding and formatting `f"{x:.2f}"`, functions with return values.
Steps: 1 read the three inputs - 2 compute the total with tip - 3 split and format - 4 move the math into
`def split_bill(bill, tip_pct, people):` - 5 reject people <= 0.
Edge cases: 0 people, negative bill, tip of 0, "$12.50" typed with a dollar sign.

### 03-word-counter
Build: read a sentence (or a .txt file), print word count, character count, and the 3 most common words.
Concepts: `str.split`, `str.lower`, stripping punctuation, `dict` counting, sorting by value; then `collections.Counter`.
Steps: 1 count words - 2 count characters with and without spaces - 3 count each word in a dict - 4 top 3 sorted -
5 rewrite step 3-4 with `Counter.most_common`.
Edge cases: empty input, "Hello hello HELLO", punctuation stuck to words.

### 04-temperature-converter
Build: a menu (C->F, F->C, quit) that loops until quit.
Concepts: functions, menus with `while True` and `break`, input validation.
Steps: 1 write `c_to_f` and `f_to_c` - 2 the menu once - 3 loop the menu - 4 validate choices and numbers.
Edge cases: -40 (same in both), invalid menu choice, decimals.

## Level 2 - files, data and structure

### 05-todo-cli
Build: a to-do list in the terminal: add, list, done, delete; saved to `todos.json` so it survives restarts.
Concepts: lists of dicts, `json.load/json.dump`, `pathlib.Path`, functions per command, `if __name__ == "__main__":`.
Files: `todo/main.py`, `todo/storage.py` (load/save), `todo/todos.json` (created by the program).
Steps: 1 in-memory add/list - 2 done and delete by number - 3 save/load JSON in `storage.py` and import it -
4 handle a missing or broken JSON file - 5 nice numbered output.
Edge cases: deleting a number that does not exist, empty list, file deleted between runs.

### 06-password-generator
Build: `py main.py --length 16 --no-symbols` prints a strong password.
Concepts: `secrets.choice` (not `random` - explain why), `string.ascii_letters/digits/punctuation`, `argparse`.
Steps: 1 fixed-length password from letters - 2 add digits and symbols - 3 `argparse` options - 4 guarantee at
least one of each chosen kind - 5 `--count N` prints N passwords.
Edge cases: length smaller than the number of required kinds, length 0.

### 07-dice-stats
Build: roll N dice M times, print how often each total came up as a text bar chart.
Concepts: `random`, `collections.Counter`, loops, string multiplication for bars, functions.
Steps: 1 roll two dice once - 2 roll M times and collect totals - 3 count - 4 print sorted bars - 5 make N and M inputs.
Edge cases: 1 die, 0 rolls, very large M (should still be fast).

### 08-rock-paper-scissors
Build: best-of-5 against the computer with a running score and a final winner.
Concepts: dict of what beats what, loops, functions, input normalising (`r`, `rock`, `ROCK`).
Steps: 1 one round - 2 decide the winner with a dict, not 9 ifs - 3 score and best-of-5 - 4 play again prompt.
Edge cases: ties, typos, quitting mid-game.

## Level 3 - real-world programs (may need pip)

### 09-expense-tracker
Build: log expenses to `expenses.csv` (date, category, amount) and print a monthly summary per category.
Concepts: `csv` module, `datetime.date`, splitting code into modules, summing by key.
Files: `expenses/main.py`, `expenses/tracker.py`, `expenses/report.py`, `expenses/expenses.csv`.
Steps: 1 add one expense to CSV - 2 read all back - 3 totals by category - 4 filter by month - 5 menu tying it together.
Edge cases: empty CSV, bad amount, a month with no data.

### 10-hangman
Build: classic hangman with a word list file, ASCII drawing, and letters guessed shown.
Concepts: sets, string building, reading a file, game loop, functions per piece.
Steps: 1 pick a word from `words.txt` - 2 show `_ _ _` with found letters - 3 lives and losing - 4 ASCII stages - 5 replay.
Edge cases: guessing the same letter twice, uppercase, non-letters.

### 11-quote-fetcher (pip: requests)
Build: fetch a random quote or the weather from a free public API and print it nicely; cache the last result to a file.
Concepts: `requests.get`, JSON responses, status codes, `try/except requests.RequestException`, timeouts.
Steps: 1 venv + `py -m pip install requests` - 2 one GET and print the raw JSON - 3 pull out the fields -
4 timeout and error message when offline - 5 cache to `last.json` and show it when offline.
Edge cases: no internet, API returns an error status, slow response.

### 12-folder-organizer
Build: sort files in a TEST folder into subfolders by type (Images, Docs, Code...). Dry-run mode prints what it
would do. ONLY ever run it on a folder created for the challenge, never on Downloads or Desktop.
Concepts: `pathlib` (iterdir, suffix, mkdir), `shutil.move`, a dict mapping extensions to folders, `argparse --dry-run`.
Steps: 1 make `sandbox/` with sample files - 2 list files and their types - 3 dry run - 4 real move - 5 handle name clashes.
Edge cases: file already in the right folder, no extension, same name in target.

## Level 4 - projects

### 13-tested-package
Build: turn an earlier challenge into a proper package with tests.
Concepts: package layout (`src/`, `__init__.py`), relative vs absolute imports, `pytest`, `requirements.txt`.
Files: see the "package" layout in `structure.md`.
Steps: 1 layout - 2 move functions into the package - 3 import them from `main.py` - 4 three pytest tests - 5 README with how to run.

### 14-snake (pip: pygame)
Build: snake with growing tail, food, score and game over.
Concepts: game loop, events, `pygame.Rect`, lists as a queue, frame rate with `Clock.tick`.
Steps: 1 window and a moving square - 2 arrow keys - 3 food and growing - 4 walls and self-collision - 5 score and restart.

### 15-flask-notes (pip: flask)
Build: a tiny web app to add and list notes in the browser, saved to JSON.
Concepts: routes, templates, forms (`request.form`), `redirect`, project layout with `templates/`.
Steps: 1 hello world route - 2 list page from a Python list - 3 add form - 4 save to JSON - 5 delete button.
