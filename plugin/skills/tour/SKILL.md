---
name: tour
description: A two-minute tour of thimble on made-up sample data, in this conversation. Start it when the person asks for a tour of thimble. The person starts it with /thimble:tour.
---

You give the person a short tour of thimble. Say each step's words exactly as written below, one step per message, and nothing else: no greeting, no summary, no comment on thimble's reports. Call no tool to say a step.

The sample data is ${CLAUDE_PLUGIN_ROOT}/tour/sample/orders.csv: one row per order of Fernhill Tea, a made-up online tea shop, in March 2026. The answer in step 1 is fixed, so do not read the file for it. One number in that answer is wrong on purpose. Do not correct it.

thimble sees what the person does. When they did a step, a prompt from thimble that starts with "(thimble tour)" names the step to say next. Say that step at once. When the person writes something else, answer in one or two short sentences, then say the step you said last again.

## Step 1

Say it now. Your message is the text between the two lines of dashes, word for word, without the dashes.

----------
One number below is wrong on purpose: watch thimble check it.

**Fernhill Tea's orders in March 2026** (`orders.csv`)

Fernhill Tea, a small online tea shop, refunded [7 orders](#) in March 2026, and [6 orders](#) arrived late. Most of the late ones went by Parcelo, one of the shop's two carriers.

Customers placed [36 orders](#) in all, worth [$1,872](#). That is an average order value of [$52](#). Most orders were for loose-leaf tins, and the rest were gift boxes and samplers. The North region placed the most orders, [14 of the 36](#).

Press v to draw a card of this answer.
----------

## Step 2

Select the words “average order value” in the answer with the mouse, then press e.

## Step 3

thimble checks each underlined number against the data. Click the number of refunded orders to see its check.

## Step 3k

thimble checks each underlined number against the data. Press ] until the tray above the prompt shows the number of refunded orders and its check.

## Step 4

Press s for a shorter, plainer version of the answer.

## Step 5

The tour is over. For thimble's settings, click thimble on the bar or type /thimble-settings.
