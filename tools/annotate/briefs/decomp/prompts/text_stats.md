### Problem Decomposition: Text Statistics

**Problem.** Given a sentence (words separated by spaces), determine three statistics about it:

- How many words are in the sentence
- The average word length, rounded to 1 decimal
- The longest word (first one wins ties)

Print all three on a single line, like this: `4 words, avg length 4.0, longest: quick`

**Deliverable.** Before writing any code, plan how you would break this into smaller steps. Create a visual diagram where each box includes: Step Name, Inputs, Outputs, and a brief Description. Consider: is there a shared setup step that all three computations depend on? Could any steps run independently of each other?

**Example input and output**

| Input Text | Printed Output |
| --- | --- |
| "the quick brown fox" | 4 words, avg length 4.0, longest: quick |
| "hello" | 1 words, avg length 5.0, longest: hello |
| "a bb ccc" | 3 words, avg length 2.0, longest: ccc |

**Example decomposition diagram shown to students** (a straight sequence)

```
Step 1: Choose Destination   In: Preferences, constraints   Out: Selected location   Decide where to visit
Step 2: Research Options     In: Selected location          Out: Activity list       Find things to do
Step 3: Set Budget           In: Activity options           Out: Spending plan       Plan costs
Step 4: Book Travel          In: Budget, activities         Out: Confirmations       Reserve transport & lodging
```

**Reflection questions**

1. Describe your decomposition approach and strategy. Explain how you broke down the problem into steps. What strategy did you use? What were your key decisions?
2. What did you find easy or difficult? Reflect on challenges you encountered and what aspects came naturally. What would you do differently?
