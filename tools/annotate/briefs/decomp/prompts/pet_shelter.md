### Problem Decomposition: Pet Shelter

**Problem.** Design a system for managing a pet shelter and adoptions. The shelter takes in pets (each with a name, species, and age), registers potential owners (each with a name and phone number), and processes adoptions that transfer a pet from the shelter to an owner. The system should support listing available pets by species, finding the oldest available pet, and tracking how many pets each owner has adopted.

**Deliverable: class diagram.** Draw a diagram of the classes you would design to solve this problem. Your design must use at least three classes. For each class, include: Class Name, Attributes with their types (e.g., name: str), and Methods with brief descriptions of what they do. Draw arrows between classes to show how they reference each other.

**Example class diagram shown to students** (for a different problem, a library book system)

```
Book                              Library
  Attributes:                       Attributes:
    title: str                        name: str
    author: str                       books: list of Book
    pages: int                      Methods:
  Methods:                            add_book(book)   Adds a Book to the collection
    summary() → str                   total_pages() → int   Sum of all books' page counts
      Returns title and author
                    Library ──* Book
```

**Reflection questions**

1. Describe your decomposition approach and strategy. Explain how you decided which classes to create. What attributes and methods did you assign to each class, and why?
2. What did you find easy or difficult? Reflect on challenges you encountered and what aspects came naturally. What would you do differently?
