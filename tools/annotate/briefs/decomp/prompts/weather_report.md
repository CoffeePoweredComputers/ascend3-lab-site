### Problem Decomposition: Weather Station Report

**Problem.** You are given a pandas DataFrame of daily weather readings from multiple cities. Some temperature readings may be missing (NaN). Construct a program that takes this DataFrame and produces a summary dictionary containing:

- "city_avg_temp": the average temperature for each city (after removing rows with missing temperatures)
- "warmest_city": the name of the city with the highest average temperature
- "rainiest_city": the name of the city with the most rainy days (days where precip_in > 0)
- "total_readings": the total number of readings used after removing rows with missing temperatures

**Deliverable.** Create a visual diagram showing how you would decompose this problem into functions. Each box should represent a function and include: Function Name, Inputs, Outputs, and a brief Description. Show which functions call which others. Look for opportunities to reuse the same function in multiple places.

**Sample DataFrame**

| city | date | temp_f | precip_in | wind_mph |
| --- | --- | --- | --- | --- |
| Chicago | 2026-03-01 | 35.2 | 0.5 | 12.0 |
| Houston | 2026-03-01 | 72.1 | 0.0 | 5.3 |
| Chicago | 2026-03-02 | NaN | 0.2 | 8.7 |
| Houston | 2026-03-02 | 68.4 | 1.1 | 6.0 |
| Chicago | 2026-03-03 | 40.0 | 0.0 | 15.2 |
| Houston | 2026-03-03 | 75.0 | 0.0 | 4.1 |

**Example decomposition diagram shown to students** (a call hierarchy with reused helpers). The prompt says: "Notice how helper functions are defined once and reused in multiple places. Your diagram should follow this pattern."

```
Helper functions (reusable)
  get_price(item)              In: item name                 Out: price (float) or None   Look up price in catalog, None if not found
  apply_discount(price, rules) In: price, discount rules     Out: final price             Apply matching discount rule
  find_extreme(d, mode)        In: dict, "max" or "min"      Out: key with extreme value  Generic dict search. Reused ×2
        ▲ ×1 per item               ▲ ×1 per item                 ▲ ▲
process_cart(items)            In: item names, discount rules   Out: item → final price, skipped count
                               For each item, call get_price. Skip if None. For valid items, call apply_discount.
        ▲ ×1
checkout(items, rules)  MAIN   In: item names, discount rules   Out: full receipt dictionary
  1. Call process_cart → priced items, skipped count
  2. Classify items: sale (>20% discount) vs regular
  3. find_extreme(prices, "max") → most expensive item
  4. find_extreme(prices, "min") → cheapest item
  5. Compute subtotal, tax, final total
  6. Assemble and return receipt
```

**Reflection questions**

1. Describe your decomposition approach and strategy. Explain how you broke down the problem into functions. What strategy did you use? Which functions did you identify as reusable, and why?
2. What did you find easy or difficult? Reflect on challenges you encountered and what aspects came naturally. What would you do differently?
