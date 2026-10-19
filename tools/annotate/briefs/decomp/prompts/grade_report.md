### Problem Decomposition: Class Performance Report

**Problem.** A teacher stores test scores as a dictionary mapping each student's name to a list of their scores. Write a function that produces a complete class performance report containing: each student's average, each student's letter grade (A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60), the overall class average, the name of the top-performing student, and a grade distribution showing how many students earned each letter grade.

**Deliverable.** Create a visual diagram showing how you would decompose this problem into clear steps. Each box should include: Function/Step Name, Inputs, Outputs, and a brief Description.

**Example inputs and outputs**

| Student Scores | Report |
| --- | --- |
| {"Alice": [80, 90, 95], "Bob": [70, 80, 75], "Carol": [60, 55, 58]} | {"averages": {"Alice": 88.33, "Bob": 75.0, "Carol": 57.67}, "grades": {"Alice": "B", "Bob": "C", "Carol": "F"}, "class_average": 73.67, "top_student": "Alice", "distribution": {"A": 0, "B": 1, "C": 1, "D": 0, "F": 1}} |
| {"Eve": [60, 85, 95], "Frank": [90, 88, 92]} | {"averages": {"Eve": 80.0, "Frank": 90.0}, "grades": {"Eve": "B", "Frank": "A"}, "class_average": 85.0, "top_student": "Frank", "distribution": {"A": 1, "B": 1, "C": 0, "D": 0, "F": 0}} |

**Example decomposition diagram shown to students** (a sequence with a loop and a decision)

```
Step 1: Choose Destination   In: Preferences, constraints   Out: Selected location   Decide where to visit
Step 2: Loop Over Days       In: Activity list              For each day...
Step 3: Check Weather        Decision: Sunny? Rainy? Snowy?   → Sunny | Rainy | Snowy
Step 4: Return Itinerary
```

**Reflection questions**

1. Describe your decomposition approach and strategy. Explain how you broke down the problem into steps. What strategy did you use? What were your key decisions?
2. What did you find easy or difficult? Reflect on challenges you encountered and what aspects came naturally. What would you do differently?
