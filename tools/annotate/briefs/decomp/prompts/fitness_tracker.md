### Problem Decomposition: Fitness Tracker Summary

**Problem.** You are given a pandas DataFrame of workout logs from a fitness tracker. Some rows may have missing values (NaN) in the calories or heart_rate columns. Construct a program that takes this DataFrame and produces a fitness summary dictionary containing:

- "calories_by_activity": the total calories burned for each activity type (after removing rows with any missing values)
- "longest_avg_activity": the name of the activity with the longest average duration
- "peak_calorie_date": the date with the highest total calories burned
- "valid_workouts": the total number of workouts after removing rows with missing values

**Deliverable.** Create a visual diagram showing how you would decompose this problem into clear steps. Each box should include: Function/Step Name, Inputs, Outputs, and a brief Description.

**Sample DataFrame**

| date | activity | duration_min | calories | heart_rate |
| --- | --- | --- | --- | --- |
| 2026-03-01 | Running | 30 | 320 | 155 |
| 2026-03-01 | Cycling | 45 | 280 | NaN |
| 2026-03-02 | Running | 25 | 275 | 160 |
| 2026-03-02 | Swimming | 40 | 350 | 140 |
| 2026-03-03 | Cycling | 50 | 310 | 130 |
| 2026-03-03 | Running | 35 | 340 | 150 |
| 2026-03-03 | Swimming | 30 | NaN | 135 |

**Example decomposition diagram shown to students** (a sequence with a parallel branch)

```
Step 1:  Choose Destination   In: Preferences, constraints   Out: Selected location   Decide where to visit
Step 2a: Research Options     In: Selected location          Out: Activity list       Find things to do
Step 2b: Set Budget           In: Selected location          Out: Spending plan       Plan costs
Step 3:  Book Travel          In: Budget, activities         Out: Confirmations       Reserve transport & lodging
```

**Reflection questions**

1. Describe your decomposition approach and strategy. Explain how you broke down the problem into steps. What strategy did you use? What were your key decisions?
2. What did you find easy or difficult? Reflect on challenges you encountered and what aspects came naturally. What would you do differently?
