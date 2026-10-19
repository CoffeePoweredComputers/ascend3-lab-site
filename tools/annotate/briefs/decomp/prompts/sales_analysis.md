### Problem Decomposition: Sales Transaction Analysis

**Problem.** You are given a pandas DataFrame of sales transactions from a small store. Construct a program that takes this DataFrame and produces a sales summary dictionary containing:

- "category_revenue": the total revenue for each category (where a transaction's revenue is quantity × unit_price)
- "top_category": the category with the highest total revenue
- "best_seller": the product with the highest total quantity sold
- "avg_transaction_revenue": the average revenue per transaction across all rows

**Deliverable.** Create a visual diagram showing how you would decompose this problem into clear steps. Each box should include: Function/Step Name, Inputs, Outputs, and a brief Description.

**Sample DataFrame**

| date | product | category | quantity | unit_price |
| --- | --- | --- | --- | --- |
| 2026-03-01 | Laptop | Electronics | 2 | 899.99 |
| 2026-03-01 | Headphones | Electronics | 5 | 49.99 |
| 2026-03-02 | Desk Chair | Furniture | 1 | 249.99 |
| 2026-03-02 | Laptop | Electronics | 1 | 899.99 |
| 2026-03-03 | Bookshelf | Furniture | 3 | 129.99 |
| 2026-03-03 | Headphones | Electronics | 2 | 49.99 |

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
