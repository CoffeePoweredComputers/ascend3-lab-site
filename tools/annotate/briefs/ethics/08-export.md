One zip of CSVs for the whole study.

## Files

| File | One row per | Notes |
| --- | --- | --- |
| `items.csv` | response | Triage status, flags and notes. |
| `texts.csv` | written part | Topic, question and the student's **lens**. `hidden` is 1 for the lens. |
| `codes.csv` | code applied | Closed decks only. `coder` is a coder code or `CONSENSUS`. |
| `assignments.csv` | card dealt to a coder | A done card with no `codes.csv` rows for a multi-label dimension was coded "none". |
| `memos.csv` | memo | Jottings, memos and questions. |
| `questions.csv` | wording of a research question | Every wording, oldest first. `current` is 1 on the one that stands; `set_aside` is 1 when it is out of the set. |
| `personal_codes.csv` | person's own code | From open coding, with what the merge made of it in `became`. |
| `personal_code_cards.csv` | card a personal code is on | Joins to `personal_codes.csv` on `code_id`. |
| `agreement.csv` | dimension or code, per round | As frozen at close. |
| `codebook.csv` | code, per version | With each version's note. |
| `final_codes.csv` | code on a response | From the final pass. `source` is `single`, `agreed` or `consensus`. A row with no code means nothing applied. |
| `themes.csv` | code in a theme | The team's themes with their statements. |

Every file identifies a response by `token`. In this study `hash` is a response id, not a student: one student, one response, and nothing links them. `homework` is the week and `project` is always `ethics_questions`.

## Using it

- For the topic map, count rows per code in `final_codes.csv`.
- To compare a coded lens with the one the student ticked, join `codes.csv` to the `lens` rows of `texts.csv` on `token`. The lens cell lists every option ticked, separated by commas.
- Keep the export you analysed.

Cells starting with `=`, `+`, `-` or `@` have a leading apostrophe so spreadsheets do not run them.
