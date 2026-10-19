### Problem Decomposition: Shopping Receipt

**Problem.** A store has a price list (dictionary mapping item names to unit prices) and a shopping cart (dictionary mapping item names to quantities purchased). Write a function that produces a receipt containing: each item's line subtotal, the total cost, the number of distinct items purchased, the name of the item that cost the most overall, and the average cost per item purchased.

**Deliverable.** Create a visual diagram showing how you would decompose this problem into clear steps. Each box should include: Function/Step Name, Inputs, Outputs, and a brief Description.

**Example inputs and outputs**

| Prices | Cart | Receipt |
| --- | --- | --- |
| {"milk": 4, "bread": 3, "eggs": 5} | {"milk": 2, "bread": 1, "eggs": 3} | {"subtotals": {"milk": 8, "bread": 3, "eggs": 15}, "total": 26, "num_items": 3, "biggest_expense": "eggs", "average_cost": 8.67} |
| {"pen": 2, "notebook": 5} | {"pen": 10, "notebook": 2} | {"subtotals": {"pen": 20, "notebook": 10}, "total": 30, "num_items": 2, "biggest_expense": "pen", "average_cost": 15.0} |

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
