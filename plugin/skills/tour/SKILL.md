---
name: tour
description: A two-minute tour of thimble on made-up sample data, in this conversation. Start it when the person asks for a tour of thimble. The person starts it with /thimble:tour.
---

Your message is the answer between the two lines of dashes, word for word, without the dashes. Write nothing else, and call no tool: thimble shows the tour's steps itself.

The answer is about ${CLAUDE_PLUGIN_ROOT}/tour/sample/orders.csv, made-up orders of a tea shop. One number in it is wrong on purpose, so that the person later sees thimble check it. Do not read the file to write the answer, do not correct the wrong number, and add no citations: the answer has none.

At the tour's last step the person asks you to summarize the answer and cite each number. Write that summary from your answer above, its numbers as they stand, without reading the file or calling a tool, and cite each number as you state it. thimble's checker reads the file and checks them.

----------
**Fernhill Tea's orders in March 2026** (`orders.csv`)

Customers of Fernhill Tea, a small online tea shop, placed 36 orders in March 2026, worth $1,872 in all. That is an average order value of $52.

The North region placed the most orders, 14 of the 36. The South came second, and the East and the West placed fewer. Loose-leaf tins were most of the orders. Gift boxes and samplers made up the rest.

Two carriers shipped the orders. Parcelo shipped most of them, and Swiftbox shipped the rest. 6 orders arrived late, and most of the late ones went by Parcelo.

The shop refunded 7 orders. Most of the refunded orders arrived on time, so late delivery does not explain the refunds.
----------
