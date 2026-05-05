import { describe, expect, it } from "vitest";
import { buildPlaidCategoryNames, resolveActualCategoryId } from "./category-matching.js";

describe("category matching", () => {
  it("derives useful provider category variants", () => {
    expect(
      buildPlaidCategoryNames({
        primary: "FOOD_AND_DRINK",
        detailed: "FOOD_AND_DRINK_GROCERIES"
      })
    ).toEqual(["Food And Drink Groceries", "Groceries", "Food And Drink"]);
  });

  it("matches a leaf provider category to an Actual category", () => {
    expect(
      resolveActualCategoryId({
        categoryNames: ["Food And Drink Groceries", "Groceries", "Food And Drink"],
        actualCategories: [
          { id: "groceries", name: "Groceries" },
          { id: "eating-out", name: "Eating Out" }
        ]
      })
    ).toBe("groceries");
  });

  it("uses aliases for common provider-to-Actual category names", () => {
    expect(
      resolveActualCategoryId({
        categoryNames: ["Food And Drink Restaurants", "Restaurants", "Food And Drink"],
        actualCategories: [
          { id: "groceries", name: "Groceries" },
          { id: "eating-out", name: "Eating Out" }
        ]
      })
    ).toBe("eating-out");
  });

  it("maps Teller-style category names to common Actual categories", () => {
    expect(
      resolveActualCategoryId({
        categoryNames: ["Dining"],
        actualCategories: [
          { id: "groceries", name: "Groceries" },
          { id: "eating-out", name: "Eating Out" }
        ]
      })
    ).toBe("eating-out");
  });

  it("does not map transfer categories to spending categories", () => {
    expect(
      resolveActualCategoryId({
        categoryNames: ["Transfer In", "Transfer"],
        actualCategories: [{ id: "groceries", name: "Groceries" }]
      })
    ).toBeUndefined();
  });
});
