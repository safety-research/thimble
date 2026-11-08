# Fernhill Tea: orders in March 2026

The data for thimble's tour (`/thimble:tour`, or `thimble tour` in a shell). Fernhill Tea is a made-up online tea
shop. Every name, order and number here is made up.

`orders.csv` has one row per order, 36 rows:

| Column | What it holds |
|---|---|
| `order_id` | the order's id, F-1001 to F-1036 |
| `date` | the day the customer placed the order |
| `customer` | the customer's name |
| `region` | North, South, East or West |
| `product` | Loose-leaf tin, Gift box or Sampler |
| `quantity` | how many of the product the order holds |
| `total_usd` | what the order cost, in US dollars |
| `carrier` | the company that shipped it: Parcelo or Swiftbox |
| `arrived` | on time, or late |
| `refunded` | yes when the shop gave the money back |
