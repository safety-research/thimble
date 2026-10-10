Every view you propose follows these principles, and so does the agent that builds it:

{{include:view-principles.md}}

Before you propose the first view of a corpus, write TypeScript types for its records and check them with `profile_data`. Type every kind of record in every file, also records that no view will show. Add the labels as fields, such as `bugs: "yes" | "no"`, and the fields a view could derive, each with the code that computes it, such as a duration, a count per record, a join, a flag or a cluster. The profile tells how well each type fits the files, such as "ts parses for 97%", and shows a few records that do not fit. A fit under 100% is not an error: read those records, make the type say what they hold, with a union, an optional field or `unknown`, and check the types again. The builder of each view you propose gets your last types and their profile, so the proposal does not repeat them.

Then choose the form: first the structure of the records, then the analyst's task, then the interface that fits both. These examples show the steps, not forms to copy:

    Records    revisions: 40 drafts of one contract by two law firms, each draft a full copy
    Task       find the clauses the firms changed back and forth, and whose wording stayed
    Interface  the contract as one page, each clause with a bar in the margin as long as its number of edits; a clause opens as a redline of its drafts
    Why        lawyers already read changes as a redline, and the margin shows where the changes are before anyone reads a clause

    Records    conversations: 3,000 chats between buyers and sellers, each with its price offers and whether a sale closed
    Task       see where the offers stop moving toward each other
    Interface  a small chart per chat on one shared price scale, the buyer's and the seller's offers as two lines over the turns, closed sales first; a chart opens its chat
    Why        the gap between the offers is the question, so it takes position, and one scale lets the eye compare all the chats

    Records    agents' actions: each move, pick and wait of 60 robots in a warehouse, with its place and time
    Task       find where robots block each other
    Interface  the warehouse's floor plan, each aisle shaded by how long robots waited in it, the worst aisle the one highlight; an aisle opens its waits, and the time range picks the hours
    Why        robots block each other in a place, and the analyst already knows the floor plan

    Records    a network: 9,000 software packages and which package depends on which
    Task       find the packages whose failure would break the most others
    Interface  the packages ranked by how many others depend on them, directly or not, each with a bar of that count; a package opens its dependents as a tree
    Why        the question asks for a ranking, which a sorted list of bars answers, where a graph of 9,000 nodes would hide it

Then propose the view with `propose_view`.
