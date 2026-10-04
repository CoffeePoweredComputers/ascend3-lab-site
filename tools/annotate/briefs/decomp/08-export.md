One zip of CSVs for the whole study. It contains the hashed student ids, so do not share it with coders who are still coding.

## Files

| File | One row per | Notes |
| --- | --- | --- |
| `items.csv` | submission | Whether it has a diagram, triage status, flags and notes. |
| `codes.csv` | code applied | Closed batches only. `coder` is a coder code or `CONSENSUS`. |
| `assignments.csv` | item given to a coder | A done assignment with no `codes.csv` rows for a multi-label dimension was coded "none". |
| `memos.csv` | memo | Jottings, memos and questions. |
| `questions.csv` | wording of a research question | Every wording, oldest first. `current` is 1 on the one that stands; `set_aside` is 1 when it is out of the set. |
| `personal_codes.csv` | person's own code | From open coding, with what the merge made of it in `became`. |
| `personal_code_cards.csv` | card a personal code is on | Joins to `personal_codes.csv` on `code_id`. |
| `agreement.csv` | dimension or code, per round | As frozen at close. |
| `codebook.csv` | code, per version | With each version's note. |
| `final_codes.csv` | code on a submission | From the final pass. `source` is `single`, `agreed` or `consensus`. A row with no code means nothing applied. |
| `themes.csv` | code in a theme | The team's themes with their statements. |

Every file identifies a submission by `token`, `hash`, `homework` and `project`. `hash` is the student. `part` says whether a code is about the diagram or the reflection.

## Using it

- Compare what a student drew with what they wrote by splitting codes on `part`.
- Follow one student by grouping on `hash` and ordering by `homework`.
- For calibration rounds, analyse the `CONSENSUS` rows.
- Check `codebook.csv` before mixing coding from different versions.
- Keep the export you analysed.

Cells starting with `=`, `+`, `-` or `@` have a leading apostrophe so spreadsheets do not run them.
