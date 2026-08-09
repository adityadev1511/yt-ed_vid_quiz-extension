/**
 * Sample transcript behind the "Try an example" button, so a first-time visitor
 * can see what the tool does without having to go find a transcript.
 *
 * Chosen because it teaches several distinct, testable concepts (write cost,
 * leftmost prefix, selectivity, covering indexes) — which gives the quiz
 * generator enough material to show off the transfer rule.
 */
export const EXAMPLE_TRANSCRIPT = `Okay so today I want to talk about database indexes, and specifically why adding an index is not free.

Most people learn indexes as "makes queries fast." That's the marketing version. The real version is: an index is a separate sorted data structure that the database maintains alongside your table. Usually a B-tree. When you write a query with a WHERE clause on an indexed column, the database can walk that tree in logarithmic time instead of scanning every row.

But here's the part people skip. Every single INSERT, UPDATE, or DELETE on that table now has to update the index too. If you have eight indexes on a table, one insert is really nine writes. So indexes trade write throughput for read speed. On a write-heavy table, piling on indexes will actively make your system slower overall.

Second thing: composite indexes and column order. If you create an index on (last_name, first_name), the database can use it for a query filtering on last_name alone, and for a query filtering on both. But it generally cannot use it for a query filtering on first_name alone. Think of a phone book sorted by last name then first name. Finding everyone named "Smith" is easy. Finding everyone whose first name is "John" means reading the whole book. This is called the leftmost prefix rule.

Third: selectivity. An index is only useful if it narrows things down a lot. If you index a boolean column where ninety percent of rows are true, and you query for true, the database will often ignore your index entirely and just scan the table. Reading the index and then jumping back to the table for ninety percent of rows is more expensive than reading the table straight through. Query planners make this decision using statistics they collect about your data distribution.

And finally, covering indexes. If your index happens to contain every column the query needs, the database never has to touch the actual table at all. It answers from the index alone. That's called an index-only scan, and it's one of the biggest wins available. But it means the index is bigger, which means more memory and more write cost. Everything is a trade.

So the mental model I want you to leave with: an index is not a magic speed switch. It's a cached, sorted copy of part of your data, and you pay for it on every write.`;
