# Rating a finished challenge

Run it first. A score without running the code is a guess.

## Score out of 100

| Part | Points | Full marks when |
|---|---|---|
| Works | 40 | Does everything the brief asked; the sample run matches; no crash on the listed edge cases |
| Readable | 20 | Clear names (`guess`, not `x`), short functions, no dead code, comments only where the why is not obvious |
| Structure | 15 | The file layout from the brief, imports at the top, `if __name__ == "__main__":`, one job per function |
| Pythonic | 15 | Uses the right tool: f-strings, `for` over items not indexes, dict lookups instead of if-chains, `with open(...)`, `Counter` |
| Robust | 10 | Bad input handled with a friendly message (try/except on the specific error), files closed, no bare `except:` |

Take off for what you can point at. Partial credit is fine. Hints do not cost points (learning is the point);
"show me the answer" caps the score at 60 and says so kindly.

Stars: 90+ = 5, 80-89 = 4, 65-79 = 3, 50-64 = 2, below 50 = 1.

## How to say it

```
Score: 84/100  ★★★★☆
Works 40/40 · Readable 16/20 · Structure 12/15 · Pythonic 9/15 · Robust 7/10

Nice:
- line 12: the while loop ends exactly when it should - clean.
- you handled letters with try/except ValueError. That is the right error to catch.

Level up:
- lines 20-31: the 3 if/elif checks for who wins can be one dict lookup -> https://realpython.com/python-dicts/
- move the game into def play(): and call it under if __name__ == "__main__": -> https://realpython.com/if-name-main-python/

Stretch goal: keep a best score in best.json between runs.
```

Rules: point at real line numbers, every improvement has a link, never more than two improvements (the most
valuable ones), and always one stretch goal. If it does not run, the score says so, and the first improvement is
the fix explained (not written for them).
